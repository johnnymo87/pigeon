/**
 * POST /topics/named/rehome: move a machine's named-topic bindings into its Slack workspace (bead
 * pigeon-4ogz.6; spec docs/plans/2026-11-20-slack-transport-design.md §3 "What the flip carries
 * over"; script packages/worker/scripts/slack-flip.mjs).
 *
 * A bound named topic (a stall-watch coordinator's) cannot follow a change of workspace lazily: the
 * session's own notifications go through `getBindingForSession`, never a key resolve, so a binding
 * left in the old chat sends every coordinator post unthreaded to `#alerts`. This route moves a
 * machine's bindings to the workspace that machine is on NOW, creating each Slack channel at the
 * move so the coordinator can be talked to from Slack straight away. It is used when a machine
 * first gets a workspace and when its team changes.
 *
 *   {machine, after?, limit?, dryRun?}
 *   200 {workspace, pending, results: [{sessionId, key, outcome, chatId?, messageThreadId?, created?, reason?}],
 *        next, retryAfter?}
 *   400 bad body · 401 no machine credential · 409 {error: "no_workspace"}
 *
 * `workspace` is whether this isolate sees a `SLACK_WORKSPACE_<MACHINE>` secret for the machine.
 * (Deployed scripts also send `expect: "slack"`, which is ignored.)
 *
 * `dryRun: true` moves nothing, calls no provider, and is answered whether or not the machine has
 * a workspace yet (without one, `pending` counts every binding not in a Slack chat).
 *
 * Three things are deliberate:
 *
 * - **It only ever converges, and never takes another machine's binding.** The target is the
 *   machine's own workspace as this isolate sees it; a machine with none is a 409, which right
 *   after a secret put is propagation, and the script retries it. A key already bound in the
 *   target chat to ANOTHER machine's session is reported `failed` and left alone (a bind would
 *   otherwise hand that machine's topic to this coordinator), and `_`-prefixed keys are never
 *   moved (they are the worker's own, like `_alerts`). With those two rules any machine key may
 *   call it for any machine, which the flip needs (it runs on devbox for all three).
 * - **Paged and resumable.** At most `limit` bindings per call, in session-id order after the
 *   `after` cursor; `next` is the cursor to pass back, or null when the page reached the end. A
 *   Slack 429 stops the page with `retryAfter` and a cursor BEFORE the limited binding, so it is
 *   retried rather than skipped. `conversations.create` is Tier 2, which a coordinator fleet of 30
 *   can exceed.
 * - **Nothing is left behind silently.** A binding that could not move is reported `failed`.
 */
import { MACHINE_ID_PATTERN, requireMachinePrincipal } from "./credentials";
import { slackChatId, slackWorkspaceForMachine } from "./chat/slack-config";
import { resolveNamedTopic, writeBinding } from "./named-topics";

export const REHOME_DEFAULT_LIMIT = 5;
export const REHOME_MAX_LIMIT = 20;
/**
 * How long the script should wait after Slack limits `conversations.create`. The Slack client
 * turns a create 429 into a transient `upstream` 503 (so it never pauses a daemon's outbox), which
 * drops Slack's Retry-After; Tier 2 is a per-minute budget, so half a minute is the honest wait.
 */
export const REHOME_SLACK_BACKOFF_S = 30;

/** True for a create that Slack refused with a rate limit, in whichever shape it arrived. */
function isRateLimit(res: { ok: false; kind: string; details?: unknown }): boolean {
  if (res.kind === "rate_limited") return true;
  const d = res.details as { error?: unknown; errorClass?: unknown } | undefined;
  return d?.error === "ratelimited" || d?.errorClass === "rate_limited";
}

/** A dry run lists at most this many pending bindings (the count is exact). */
const DRY_RUN_LIST_CAP = 200;

interface PendingRow {
  session_id: string;
  chat_id: string;
  topic_key: string;
  name: string | null;
}

export interface RehomeResult {
  sessionId: string;
  key: string;
  outcome: "moved" | "failed" | "pending";
  chatId?: string;
  messageThreadId?: number;
  created?: boolean;
  reason?: string;
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

/**
 * The bindings of `machine`'s sessions that are not where they belong: every binding not in the
 * workspace's chat. A binding whose session has no worker `sessions` row is inert (every lookup
 * joins it) and is not moved. A dry run before the secret exists has no target yet, and counts
 * every non-Slack binding.
 */
function pendingSql(targetKnown: boolean, cursor: boolean, limit: boolean): string {
  return `SELECT b.session_id, b.chat_id, b.topic_key, t.name
            FROM named_topic_bindings b
            JOIN sessions s ON s.session_id = b.session_id
            LEFT JOIN named_topics t ON t.chat_id = b.chat_id AND t.topic_key = b.topic_key
           WHERE s.machine_id = ?
             AND ${targetKnown ? "b.chat_id <> ?" : "b.chat_id NOT LIKE 'slack:%'"}
             ${cursor ? "AND b.session_id > ?" : ""}
           ORDER BY b.session_id
           ${limit ? "LIMIT ?" : ""}`;
}

async function countPending(db: D1Database, machine: string, target: string | null): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM (${pendingSql(target !== null, false, false)})`;
  const stmt = db.prepare(sql);
  const row = await (target !== null ? stmt.bind(machine, target) : stmt.bind(machine)).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The machine whose session holds `(chatId, key)`, when that is not `machine`, else null. A binding
 * whose session has no worker row is inert and may be replaced (as /topics/named/bind would).
 */
async function otherMachineHolding(db: D1Database, chatId: string, key: string, machine: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT s.machine_id FROM named_topic_bindings b JOIN sessions s ON s.session_id = b.session_id
        WHERE b.chat_id = ? AND b.topic_key = ?`,
    )
    .bind(chatId, key)
    .first<{ machine_id: string }>();
  return row && row.machine_id !== machine ? row.machine_id : null;
}

export async function handleNamedTopicRehome(db: D1Database, env: Env, request: Request): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }
  if (!body || typeof body !== "object") return bad("invalid body");

  const machine = typeof body.machine === "string" ? body.machine : "";
  if (!MACHINE_ID_PATTERN.test(machine)) return bad("machine must be a machine id");
  const limit = body.limit === undefined ? REHOME_DEFAULT_LIMIT : body.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > REHOME_MAX_LIMIT) {
    return bad(`limit must be an integer from 1 to ${REHOME_MAX_LIMIT}`);
  }
  const after = body.after === undefined || body.after === null ? null : body.after;
  if (after !== null && (typeof after !== "string" || after.length === 0 || after.length > 128)) {
    return bad("after must be a session id");
  }
  const dryRun = body.dryRun === true;

  const ws = slackWorkspaceForMachine(env, machine);

  if (dryRun) {
    // Allowed without a workspace, so the script can preview a flip before it puts the secret.
    const dryTarget = ws ? slackChatId(ws) : null;
    const stmt = db.prepare(pendingSql(dryTarget !== null, false, true));
    const { results } = await (dryTarget !== null
      ? stmt.bind(machine, dryTarget, DRY_RUN_LIST_CAP)
      : stmt.bind(machine, DRY_RUN_LIST_CAP)
    ).all<PendingRow>();
    return Response.json({
      workspace: ws !== null,
      pending: await countPending(db, machine, dryTarget),
      results: (results ?? []).map((r) => ({ sessionId: r.session_id, key: r.topic_key, outcome: "pending" })),
      next: null,
    });
  }

  if (!ws) {
    return Response.json({ error: "no_workspace" }, { status: 409 });
  }
  const target = slackChatId(ws);

  const stmt = db.prepare(pendingSql(true, after !== null, true));
  const args: unknown[] = [machine, target];
  if (after !== null) args.push(after);
  args.push(limit);
  const { results: rows } = await stmt.bind(...args).all<PendingRow>();
  const page = rows ?? [];

  const results: RehomeResult[] = [];
  let cursor: string | null = after;
  let retryAfter: number | undefined;

  for (const row of page) {
    const chatId = target;
    if (row.topic_key.startsWith("_")) {
      results.push({ sessionId: row.session_id, key: row.topic_key, outcome: "failed", reason: "reserved key" });
      cursor = row.session_id;
      continue;
    }
    const holder = await otherMachineHolding(db, chatId, row.topic_key, machine);
    if (holder !== null) {
      results.push({
        sessionId: row.session_id,
        key: row.topic_key,
        outcome: "failed",
        reason: `key is bound in ${chatId} to a session of ${holder}`,
      });
      cursor = row.session_id;
      continue;
    }
    const res = await resolveNamedTopic(db, {
      chatId,
      key: row.topic_key,
      name: row.name ?? row.topic_key,
      env,
    });
    if (!res.ok && isRateLimit(res)) {
      retryAfter = res.kind === "rate_limited" ? res.retryAfter : REHOME_SLACK_BACKOFF_S;
      break; // cursor stays before this binding
    }
    cursor = row.session_id;
    if (!res.ok) {
      results.push({ sessionId: row.session_id, key: row.topic_key, outcome: "failed", reason: "create_failed" });
      console.warn("[worker] rehome: named topic create failed", { sessionId: row.session_id, key: row.topic_key, chatId });
      continue;
    }
    await writeBinding(db, chatId, row.topic_key, row.session_id);
    results.push({
      sessionId: row.session_id,
      key: row.topic_key,
      outcome: "moved",
      chatId,
      messageThreadId: res.messageThreadId,
      created: res.created,
    });
  }

  const reachedEnd = retryAfter === undefined && page.length < limit;
  return Response.json({
    workspace: true,
    pending: await countPending(db, machine, target),
    results,
    next: reachedEnd ? null : cursor,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

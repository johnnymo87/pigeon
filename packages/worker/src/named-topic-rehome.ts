/**
 * POST /topics/named/rehome: the binding half of a Slack flip (bead pigeon-4ogz.6; spec
 * docs/plans/2026-11-20-slack-transport-design.md §3 "What the flip carries over" and "Flip and
 * unflip move bindings explicitly"; script packages/worker/scripts/slack-flip.mjs).
 *
 * A bound named topic (a stall-watch coordinator's) cannot follow a flip lazily: the session's own
 * notifications go through `getBindingForSession`, never a key resolve, so a binding left in the
 * old chat sends every coordinator post unthreaded to `#alerts`. This route moves a machine's
 * bindings to the transport that machine is on NOW, creating each Slack channel at the flip so the
 * coordinator can be talked to from Slack straight away.
 *
 *   {machine, expect: "slack"|"telegram", telegramChatId?, after?, limit?, dryRun?}
 *   200 {transport, pending, results: [{sessionId, key, outcome, chatId?, messageThreadId?, created?, reason?}],
 *        next, retryAfter?}
 *   400 bad body · 401 no machine credential · 409 {error: "transport_mismatch", transport} · 409 topics disabled
 *
 * `dryRun: true` moves nothing, calls no provider, and is answered whatever the transport.
 *
 * Three things are deliberate:
 *
 * - **It only ever converges.** The target is the machine's transport as this isolate sees it
 *   (its `SLACK_WORKSPACE_<MACHINE>` secret), and `expect` must agree or the answer is 409. So any
 *   machine key may call it for any machine (the flip runs on devbox for all three), and the worst
 *   a caller can do is what that machine's next re-bind would do anyway. A 409 right after a secret
 *   put or delete is propagation, and the script retries it.
 * - **Paged and resumable.** At most `limit` bindings per call, in session-id order after the
 *   `after` cursor; `next` is the cursor to pass back, or null when the page reached the end. A
 *   Slack 429 stops the page with `retryAfter` and a cursor BEFORE the limited binding, so it is
 *   retried rather than skipped. `conversations.create` is Tier 2, which a coordinator fleet of 30
 *   can exceed.
 * - **Unflip needs a Telegram chat.** The worker does not know a machine's Telegram chat. A binding
 *   moves back to the one Telegram chat that already holds a topic for its key (the flip leaves the
 *   old topic in place); with `telegramChatId` it goes there, creating a topic if needed. Otherwise
 *   it is reported `unplaced` and left where it is, and the daemon's next re-bind (which sends its
 *   configured chat) places it.
 */
import { MACHINE_ID_PATTERN, requireMachinePrincipal } from "./credentials";
import { isAllowedChatId } from "./chat/allowlist";
import { slackChatId, slackWorkspaceForMachine } from "./chat/slack-config";
import { resolveNamedTopic, writeBinding } from "./named-topics";
import { topicsEnabled } from "./topics";

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

type Transport = "slack" | "telegram";

interface PendingRow {
  session_id: string;
  chat_id: string;
  topic_key: string;
  name: string | null;
}

export interface RehomeResult {
  sessionId: string;
  key: string;
  outcome: "moved" | "failed" | "unplaced" | "pending";
  chatId?: string;
  messageThreadId?: number;
  created?: boolean;
  reason?: string;
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

/**
 * The bindings of `machine`'s sessions that are not where they belong: on Slack, every binding not
 * in the workspace's chat; on Telegram, every binding in a `slack:` chat. A binding whose session
 * has no worker `sessions` row is inert (every lookup joins it) and is not moved. A dry run of a
 * flip to Slack before the secret exists has no target yet, and counts every non-Slack binding.
 */
function pendingSql(transport: Transport, targetKnown: boolean, cursor: boolean, limit: boolean): string {
  return `SELECT b.session_id, b.chat_id, b.topic_key, t.name
            FROM named_topic_bindings b
            JOIN sessions s ON s.session_id = b.session_id
            LEFT JOIN named_topics t ON t.chat_id = b.chat_id AND t.topic_key = b.topic_key
           WHERE s.machine_id = ?
             AND ${transport === "telegram" ? "b.chat_id LIKE 'slack:%'" : targetKnown ? "b.chat_id <> ?" : "b.chat_id NOT LIKE 'slack:%'"}
             ${cursor ? "AND b.session_id > ?" : ""}
           ORDER BY b.session_id
           ${limit ? "LIMIT ?" : ""}`;
}

async function countPending(db: D1Database, machine: string, transport: Transport, target: string | null): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM (${pendingSql(transport, target !== null, false, false)})`;
  const stmt = db.prepare(sql);
  const row = await (target !== null ? stmt.bind(machine, target) : stmt.bind(machine)).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The single Telegram chat that already has a topic for `key`, or null (none, or ambiguous). */
async function existingTelegramChat(db: D1Database, key: string, env: Env): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT DISTINCT chat_id FROM named_topics WHERE topic_key = ? AND chat_id NOT LIKE 'slack:%'")
    .bind(key)
    .all<{ chat_id: string }>();
  const allowed = (results ?? []).filter((r) => isAllowedChatId(r.chat_id, env));
  return allowed.length === 1 ? allowed[0]!.chat_id : null;
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
  const expect = body.expect;
  if (expect !== "slack" && expect !== "telegram") return bad('expect must be "slack" or "telegram"');
  const limit = body.limit === undefined ? REHOME_DEFAULT_LIMIT : body.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > REHOME_MAX_LIMIT) {
    return bad(`limit must be an integer from 1 to ${REHOME_MAX_LIMIT}`);
  }
  const after = body.after === undefined || body.after === null ? null : body.after;
  if (after !== null && (typeof after !== "string" || after.length === 0 || after.length > 128)) {
    return bad("after must be a session id");
  }
  const tgRaw = body.telegramChatId;
  let telegramChatId: string | null = null;
  if (tgRaw !== undefined && tgRaw !== null) {
    if (expect !== "telegram") return bad("telegramChatId is only for expect: telegram");
    if ((typeof tgRaw !== "string" && typeof tgRaw !== "number") || !isAllowedChatId(String(tgRaw), env)) {
      return bad("telegramChatId must be an allowlisted Telegram chat id");
    }
    telegramChatId = String(tgRaw);
  }
  const dryRun = body.dryRun === true;

  const ws = slackWorkspaceForMachine(env, machine);
  const transport: Transport = ws ? "slack" : "telegram";
  if (!topicsEnabled(env)) return Response.json({ error: "topics disabled" }, { status: 409 });

  if (dryRun) {
    // Allowed against either transport, so the script can preview a flip before it puts or
    // deletes the secret. `transport` reports what this isolate sees; `pending` is for `expect`.
    const dryTarget = expect === "slack" && ws ? slackChatId(ws) : null;
    const stmt = db.prepare(pendingSql(expect, dryTarget !== null, false, true));
    const { results } = await (dryTarget !== null
      ? stmt.bind(machine, dryTarget, DRY_RUN_LIST_CAP)
      : stmt.bind(machine, DRY_RUN_LIST_CAP)
    ).all<PendingRow>();
    return Response.json({
      transport,
      pending: await countPending(db, machine, expect, dryTarget),
      results: (results ?? []).map((r) => ({ sessionId: r.session_id, key: r.topic_key, outcome: "pending" })),
      next: null,
    });
  }

  if (transport !== expect) {
    return Response.json({ error: "transport_mismatch", transport }, { status: 409 });
  }
  const target = ws ? slackChatId(ws) : null;

  const stmt = db.prepare(pendingSql(transport, target !== null, after !== null, true));
  const args: unknown[] = [machine];
  if (transport === "slack") args.push(target);
  if (after !== null) args.push(after);
  args.push(limit);
  const { results: rows } = await stmt.bind(...args).all<PendingRow>();
  const page = rows ?? [];

  const results: RehomeResult[] = [];
  let cursor: string | null = after;
  let retryAfter: number | undefined;

  for (const row of page) {
    const chatId = target ?? telegramChatId ?? (await existingTelegramChat(db, row.topic_key, env));
    if (!chatId) {
      results.push({
        sessionId: row.session_id,
        key: row.topic_key,
        outcome: "unplaced",
        reason: "no single Telegram topic for this key; pass telegramChatId",
      });
      cursor = row.session_id;
      continue;
    }
    const res = await resolveNamedTopic(db, {
      chatId,
      key: row.topic_key,
      name: row.name ?? row.topic_key,
      botToken: env.TELEGRAM_BOT_TOKEN,
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
    transport,
    pending: await countPending(db, machine, transport, target),
    results,
    next: reachedEnd ? null : cursor,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

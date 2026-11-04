import os from "os";
import { openSync } from "fs";
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { OpencodeHttpError, type OpencodeClient } from "../opencode-client";
import { RequestTimeoutError, TransportError, transportCode } from "../routing/serve-outcome";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";
import { describeOcTagsFailure, type OcTagsRunner } from "./oc-tags";
import { isValidSessionId, isValidTag, truncate } from "./tag-ingest";
import { parseWhichLine } from "../tag-resolver";
import type { LaunchMessage } from "./poller";

/**
 * Budget for the `oc-tags which` behind tag inheritance. Same as the footer
 * resolver's: `which` never reads the message table, so a slow one means a
 * contended DB, and the launch confirmation should not wait 20s on it.
 */
export const INHERIT_WHICH_TIMEOUT_MS = 3_000;

/** Path of the log file shared with the home.base.nix shell wrapper. */
const AUTO_ATTACH_LOG_PATH = "/tmp/oc-auto-attach.log";

/** Treat a bare word (no slashes, no ~) as ~/projects/<word> (or ~/Code/<word> on macOS). */
export function expandShorthand(dir: string): string {
  if (!dir.includes("/") && !dir.startsWith("~")) {
    const isDarwin = os.platform() === "darwin";
    return isDarwin ? `~/Code/${dir}` : `~/projects/${dir}`;
  }
  return dir;
}

/** Resolve leading `~` or `~/` to the user's home directory. */
export function resolveHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return os.homedir() + dir.slice(1);
  return dir;
}

export interface LaunchCommandInput {
  commandId: string;
  directory: string;
  prompt: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  /**
   * Resolve the client for the serve that OWNS a session (pigeon HRW placement).
   * The session is created on `opencodeClient` (serve-0) but its agent loop must
   * run on the serve pigeon assigns, so the prompt is sent via this owner. When
   * absent, or when it returns undefined (no healthy pool serve), the launch
   * degrades to sending on `opencodeClient` — the pre-pool single-serve behavior.
   */
  resolveOwnerClient?: (sessionId: string, opts?: { avoidEndpoints?: string[] }) => OpencodeClient | undefined;
  /** Healthy pool serves to create on, with failover. See LaunchStartInput.createClients. */
  createClients?: () => OpencodeClient[];
  /**
   * Optional oc-tags tag from `/launch <machine> <dir> --tag <tag> <prompt>`.
   *
   * Absent on every ordinary launch. It is an OVERRIDE, not a creation: every
   * session already has exactly one tag, so this converts the new session off
   * the directory-derived "auto:" fallback that would otherwise say nothing
   * about what the session was launched to do.
   */
  tag?: string;
  /**
   * The session this /launch was sent in the context of (its forum topic or a
   * swipe-reply to its notification), set by the worker only when no `--tag`
   * was given and that session is on this machine. If oc-tags says its tag is
   * an explicit SESSION tag, the new session gets a copy. A dir-rule or
   * `auto:` tag is never inherited. Absent from an old worker.
   */
  inheritFromSessionId?: string;
  /** null (or absent) means oc-tags is not installed on this machine. */
  runOcTags?: OcTagsRunner | null;
  /**
   * Runner for the inheritance `oc-tags which`, with the short
   * INHERIT_WHICH_TIMEOUT_MS budget. Absent: falls back to runOcTags.
   */
  runOcTagsWhich?: OcTagsRunner | null;
  /**
   * Called once `--tag` has actually been applied, so a cached tag for this
   * session can be refetched. A throw is swallowed — the tag is written either
   * way, and this must not cost the confirmation message.
   */
  onTagged?: (sessionId: string) => void;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
  /** Injected for tests; defaults to node child_process.spawn. */
  spawn?: (cmd: string, args: ReadonlyArray<string>, opts?: { stdio?: "ignore" | "inherit" | "pipe" | Array<"ignore" | "inherit" | "pipe" | number>; detached?: boolean }) => ChildProcess;
}

/**
 * Last non-empty line, which for a Python traceback is the only useful one.
 *
 * Truncated with tag-ingest's surrogate-safe helper rather than slice(): a lone
 * surrogate makes the JSON body invalid UTF-8 and Telegram rejects the WHOLE
 * message with a 400 — and on this path that message is the one carrying the
 * session id.
 */
function lastLine(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const lines = (candidate ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length > 0) return truncate(lines[lines.length - 1]!, 300);
  }
  return "";
}

/**
 * Tags the freshly launched session, and NEVER throws or rejects.
 *
 * Two invariants:
 *
 *  - **It cannot throw.** A throw would propagate out of ingestLaunchCommand to
 *    the poller, which skips the ack, and the redelivered launch is a DUPLICATE
 *    SESSION. Losing a launch — or doubling one — to a bookkeeping write is a
 *    strictly worse trade than losing the tag row.
 *  - **It always returns a line naming a reason.** Nobody reads stderr on a
 *    phone, so an unexplained failure here is simply invisible.
 *
 * The tag is validated here even though the worker validated it before queueing,
 * because this is the side that spawns a process: the value arrives from a D1
 * row via metadata_json, not from that function's return value. An invalid tag
 * skips the spawn but still launches — the daemon-side path is reachable only
 * through a tampered row (whoever holds the API key can already queue any launch
 * they like) or through drift between the two validator copies, where refusing
 * would reject a tag the worker had just accepted.
 */
export async function applyTag(
  tag: string,
  sessionId: string,
  runOcTags: OcTagsRunner | null | undefined,
  machineLabel: string,
  onTagged?: (sessionId: string) => void,
): Promise<string> {
  if (!isValidTag(tag)) {
    return `Tag not applied: invalid tag ${truncate(String(tag), 64)}`;
  }
  if (!runOcTags) {
    return `Tag not applied: oc-tags is not installed${machineLabel}.`;
  }

  try {
    // argv, never a command string, and `set <tag> <session-id>` — tag FIRST.
    // Reversed, oc-tags tags a session literally named after the tag and reports
    // success.
    const result = await runOcTags(["set", tag, sessionId]);
    if (result.code !== 0) {
      return `Tag not applied: ${lastLine(result.stderr, result.stdout) || `oc-tags exited ${result.code}`}`;
    }
    // The session already registered, so a tag cache may hold the pre-tag
    // answer. Without this the confirmation below says `🏷 Tagged ...` and the
    // session's first notification arrives with no tag on it, which reads as
    // the tag not having taken.
    try {
      onTagged?.(sessionId);
    } catch (err) {
      console.warn(`[launch-ingest] onTagged threw session=${sessionId}:`, err);
    }
    // oc-tags' OWN confirmation line: it lowercases, so `--tag FBM` is charted
    // as `fbm`, and a line composed here would name a tag the chart never shows.
    return lastLine(result.stdout) || `Tagged ${sessionId} as ${tag}`;
  } catch (err) {
    return `Tag not applied: ${describeOcTagsFailure(err)}`;
  }
}

/**
 * Copies the context session's explicit tag onto the new session, and NEVER
 * throws or rejects — for the same duplicate-session reason as applyTag: the
 * runner rejects on timeout, and a throw here would skip the poller's ack and
 * redeliver the launch.
 *
 * Returns the line for the confirmation, or null when there was nothing to
 * report. The worker has already told the human "will inherit X's session tag", so
 * every outcome that is not an inheritance says why.
 */
async function inheritTag(
  input: LaunchCommandInput,
  sessionId: string,
  machineLabel: string,
): Promise<string | null> {
  const parent = input.inheritFromSessionId;
  try {
    if (parent === undefined) return null;
    if (!isValidSessionId(parent)) {
      return `Tag not inherited: invalid session id ${truncate(String(parent), 64)}`;
    }
    const runWhich = input.runOcTagsWhich !== undefined ? input.runOcTagsWhich : input.runOcTags;
    if (!runWhich) {
      return `Tag not inherited: oc-tags is not installed${machineLabel}.`;
    }

    let result;
    try {
      result = await runWhich(["which", parent]);
    } catch (err) {
      return `Tag not inherited from ${parent}: ${describeOcTagsFailure(err, INHERIT_WHICH_TIMEOUT_MS)}`;
    }
    if (!result || result.code !== 0) {
      const reason = result ? lastLine(result.stderr, result.stdout) || `oc-tags exited ${result.code}` : "no result";
      return `Tag not inherited from ${parent}: ${reason}`;
    }

    const which = parseWhichLine(String(result.stdout ?? ""));
    if (!which) {
      return `Tag not inherited from ${parent}: could not read oc-tags which output`;
    }
    if (which.kind === undefined) {
      // A pre-column-4 oc-tags says `manual` for a session tag AND a legacy
      // dir rule alike; guessing would copy a place onto a piece of work.
      return `Tag not inherited from ${parent}: oc-tags is too old to tell a session tag from a directory tag`;
    }
    if (which.kind !== "session") {
      return `No tag inherited: ${parent} has no session tag`;
    }

    // Tags live on ROOT sessions; when the context session is a subagent the
    // tag actually came from its root, so name that.
    const source = which.rootSessionId && which.rootSessionId !== parent ? which.rootSessionId : parent;
    const line = await applyTag(which.tag, sessionId, input.runOcTags, machineLabel, input.onTagged);
    return line.startsWith("Tag not applied")
      ? `${line} (inheriting from ${source})`
      : `${line} (inherited from ${source})`;
  } catch (err) {
    console.warn(`[launch-ingest] tag inheritance failed session=${sessionId} parent=${String(parent)}:`, err);
    return `Tag not inherited: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export type LaunchStartOutcome =
  | { outcome: "launched"; sessionId: string }
  | { outcome: "refused"; reason: string; detail: string }          // nothing is running
  | { outcome: "unconfirmed"; sessionId: string | null; detail: string };

export interface LaunchStartInput {
  directory: string;              // already resolved, absolute
  prompt: string;
  opencodeClient: OpencodeClient;
  /**
   * The owning serve's client for a session (HRW placement). `avoidEndpoints`
   * names serves a create just failed on, so a NEW placement keeps the session
   * off them while another healthy serve exists.
   */
  resolveOwnerClient?: (sessionId: string, opts?: { avoidEndpoints?: string[] }) => OpencodeClient | undefined;
  budgets?: { healthMs: number; createMs: number; promptMs: number };  // remote launches pass 5000/20000/20000
  onCreated?: (sessionId: string) => void;   // called synchronously right after createSession returns, before sendPrompt
  /**
   * Clients for the pool's currently healthy serves, in the order to try
   * `createSession` on. With one or more, the launch creates on them instead
   * of `opencodeClient`, and a create that times out, fails in transport or
   * gets a non-OK answer is retried ONCE on the next serve inside the same
   * create budget. Absent, empty or throwing means the single-serve path on
   * `opencodeClient`, with its up-front health check.
   *
   * Why (2026-11-03, devbox): serve-0 answered /global/health but hung every
   * session-DB route for 2.5h, and every launch timed out creating on it while
   * serve-1 was fine. The pool's liveness signal cannot see that state, so the
   * create itself is the probe.
   */
  createClients?: () => OpencodeClient[];
}

/** Create budget for a launch with no explicit budgets (Telegram /launch). */
export const DEFAULT_CREATE_BUDGET_MS = 30_000;

/**
 * At most this many serves are tried per launch. More attempts would starve
 * each of time, and the whole launch must finish inside one 60s lease or the
 * item is handed out again mid-launch.
 */
export const MAX_CREATE_ATTEMPTS = 2;

/**
 * Time held back from the first attempt for the failover attempt. The first
 * serve gets everything else, so on an ordinary day (remote: 20s budget, first
 * attempt 15s) a slow cold-directory create has exactly the time it had before
 * failover existed; only a serve that blows through that falls over.
 */
export const FAILOVER_RESERVE_MS = 5_000;

function formatDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return truncate(message, 300);
}

type CreateFailure = Exclude<LaunchStartOutcome, { outcome: "launched" }>;

/** Classify one failed createSession exactly as the single-serve path always has. */
function classifyCreateFailure(err: unknown): CreateFailure {
  const detail = formatDetail(err);
  if (err instanceof RequestTimeoutError) {
    return { outcome: "unconfirmed", sessionId: null, detail };
  }
  if (err instanceof TransportError && transportCode(err) === "ECONNREFUSED") {
    return { outcome: "refused", reason: "serve_unreachable", detail };
  }
  if (err instanceof TransportError) {
    return { outcome: "unconfirmed", sessionId: null, detail };
  }
  return { outcome: "refused", reason: "create_failed", detail };
}

/** The pool candidates to create on, or null for the single-serve path. */
function resolvePoolCandidates(input: LaunchStartInput): OpencodeClient[] | null {
  if (!input.createClients) return null;
  try {
    const clients = input.createClients();
    return clients.length > 0 ? clients.slice(0, MAX_CREATE_ATTEMPTS) : null;
  } catch (err) {
    console.warn(`[launch-ingest] createClients threw, creating on opencodeClient:`, err);
    return null;
  }
}

/**
 * createSession, failing over to a second healthy serve.
 *
 * Every failure fails over, including an ambiguous timeout. A timed-out create
 * may still complete on the first serve and leave an EMPTY, unprompted session
 * there. That orphan never runs a turn and was already a known outcome of a
 * slow create; it is a far better trade than reporting the launch as "may or
 * may not have started" with no id, which is what a single attempt gives. No
 * prompt is ever sent twice: sendPrompt runs once, after one create succeeded.
 *
 * When every attempt fails, the result is the most cautious one seen: any
 * ambiguous failure makes it unconfirmed, otherwise the last refusal stands.
 * `failedEndpoints` names the serves that failed before the winner, so the
 * prompt's owner can be placed elsewhere.
 */
async function createOnCandidates(
  input: LaunchStartInput,
  clients: OpencodeClient[],
): Promise<{ session: { id: string }; failedEndpoints: string[] } | CreateFailure> {
  const totalMs = input.budgets?.createMs ?? DEFAULT_CREATE_BUDGET_MS;
  const startedAt = Date.now();
  const failedEndpoints: string[] = [];
  let worst: CreateFailure | undefined;
  for (let i = 0; i < clients.length; i++) {
    const remaining = totalMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const reserve = (clients.length - 1 - i) * FAILOVER_RESERVE_MS;
    const timeoutMs = Math.max(1, remaining - reserve > 0 ? remaining - reserve : Math.floor(remaining / (clients.length - i)));
    const client = clients[i]!;
    try {
      const session = await client.createSession(input.directory, { timeoutMs });
      if (i > 0) {
        console.warn(`[launch-ingest] createSession succeeded on failover attempt ${i + 1} session=${session.id} avoided=${failedEndpoints.join(",")}`);
      }
      return { session, failedEndpoints };
    } catch (err) {
      const failure = classifyCreateFailure(err);
      console.warn(`[launch-ingest] createSession attempt ${i + 1}/${clients.length} on ${client.endpoint ?? "?"} failed (${failure.outcome}): ${failure.detail}`);
      if (client.endpoint) failedEndpoints.push(client.endpoint);
      if (!worst || failure.outcome === "unconfirmed") worst = failure;
      else if (worst.outcome === "refused") worst = failure;
    }
  }
  return worst ?? { outcome: "unconfirmed", sessionId: null, detail: "create budget exhausted" };
}

async function createSingleServe(
  input: LaunchStartInput,
): Promise<{ session: { id: string }; failedEndpoints: string[] } | CreateFailure> {
  try {
    const healthy = input.budgets
      ? await input.opencodeClient.healthCheck({ timeoutMs: input.budgets.healthMs })
      : await input.opencodeClient.healthCheck();
    if (!healthy) {
      return {
        outcome: "refused",
        reason: "serve_unavailable",
        detail: "opencode serve is not running",
      };
    }
  } catch (err) {
    return {
      outcome: "refused",
      reason: "serve_unavailable",
      detail: formatDetail(err),
    };
  }
  try {
    const session = input.budgets
      ? await input.opencodeClient.createSession(input.directory, { timeoutMs: input.budgets.createMs })
      : await input.opencodeClient.createSession(input.directory);
    return { session, failedEndpoints: [] };
  } catch (err) {
    return classifyCreateFailure(err);
  }
}

export async function startSession(input: LaunchStartInput): Promise<LaunchStartOutcome> {
  // With a pool, the up-front /global/health on opencodeClient is skipped: it
  // could only refuse a launch another healthy serve would take, and it passes
  // on exactly the half-wedged serve the failover exists for. The pool's
  // healthy set (fresh heartbeats) stands in for it, and a dead serve fails the
  // create fast (ECONNREFUSED) and fails over.
  const pool = resolvePoolCandidates(input);
  const created = pool ? await createOnCandidates(input, pool) : await createSingleServe(input);
  if ("outcome" in created) return created;
  const session = created.session;

  if (input.onCreated) {
    try {
      input.onCreated(session.id);
    } catch (err) {
      console.warn(`[launch-ingest] onCreated threw for session ${session.id}:`, err);
    }
  }

  let owner = input.opencodeClient;
  if (input.resolveOwnerClient) {
    try {
      const placeOpts = created.failedEndpoints.length > 0 ? { avoidEndpoints: created.failedEndpoints } : undefined;
      owner = (placeOpts ? input.resolveOwnerClient(session.id, placeOpts) : input.resolveOwnerClient(session.id)) ?? input.opencodeClient;
    } catch (err) {
      console.warn(`[launch-ingest] resolveOwnerClient threw for session ${session.id}, falling back to opencodeClient:`, err);
    }
  }
  try {
    if (input.budgets) {
      await owner.sendPrompt(session.id, input.directory, input.prompt, { timeoutMs: input.budgets.promptMs });
    } else {
      await owner.sendPrompt(session.id, input.directory, input.prompt);
    }
    console.log(`[launch-ingest] session started sessionId=${session.id} directory=${input.directory}`);
    return { outcome: "launched", sessionId: session.id };
  } catch (err) {
    const detail = formatDetail(err);
    if (err instanceof OpencodeHttpError && err.status >= 400 && err.status < 500) {
      try {
        await owner.deleteSession(session.id);
      } catch {
        // best-effort deleteSession (swallow errors)
      }
      return { outcome: "refused", reason: "prompt_rejected", detail };
    }
    if (err instanceof TransportError && transportCode(err) === "ECONNREFUSED") {
      try {
        await owner.deleteSession(session.id);
      } catch {
        // best-effort deleteSession (swallow errors)
      }
      return { outcome: "refused", reason: "prompt_unreachable", detail };
    }
    // RequestTimeoutError, 5xx OpencodeHttpError, other TransportError, or any other error
    return { outcome: "unconfirmed", sessionId: session.id, detail };
  }
}

export function autoAttach(
  sessionId: string,
  spawn?: LaunchCommandInput["spawn"],
): void {
  // Auto-attach: best-effort, fire-and-forget. If oc-auto-attach is not
  // installed (e.g. cloudbox), node spawn emits ENOENT asynchronously
  // on the child's 'error' event — we MUST listen for it or node crashes.
  // The synchronous try/catch handles rare cases like invalid arguments
  // that throw immediately.
  //
  // OC_AUTO_ATTACH_BIN env var lets systemd-managed deployments pin an
  // absolute path to the binary. Required on hosts (e.g. cloudbox) where
  // the daemon's PATH is a locked-down nix-store list that does NOT
  // include ~/.nix-profile/bin — without it, spawn would silently ENOENT
  // and the auto-attach to nvim+tmux for telegram /launch would never run.
  //
  // We route the child's stdout AND stderr to /tmp/oc-auto-attach.log
  // (the same log file the home.base.nix shell wrapper uses). Without
  // this, daemon-spawned launches would discard the script's logs and
  // any internal failure (e.g. a missing tool in the script's PATH
  // under `set -o pipefail`) would be completely invisible. We hit
  // exactly that on cloudbox: oc-auto-attach silently failed for a
  // /launch into a project without an existing tmux window because
  // `awk` was missing from the script's hard-coded PATH.
  //
  // openSync failure (e.g. /tmp not writable) is swallowed — we'd
  // rather lose logs than crash the launcher.
  try {
    const spawnFn = spawn ?? nodeSpawn;
    const bin = process.env.OC_AUTO_ATTACH_BIN ?? "oc-auto-attach";
    let logFd: number | "ignore" = "ignore";
    try {
      logFd = openSync(AUTO_ATTACH_LOG_PATH, "a");
    } catch (logErr: unknown) {
      console.warn(`[launch-ingest] could not open ${AUTO_ATTACH_LOG_PATH}:`, logErr);
    }
    const child = spawnFn(bin, [sessionId], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.on?.("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        console.warn(`[launch-ingest] auto-attach spawn failed (async):`, err);
      }
    });
    child.unref?.();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[launch-ingest] auto-attach spawn failed (sync):`, err);
    }
  }
}

export async function ingestLaunchCommand(input: LaunchCommandInput): Promise<void> {
  const { commandId, prompt, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const directory = resolveHome(expandShorthand(input.directory));
  const machineLabel = machineId ? ` on ${machineId}` : "";

  const outcome = await startSession({
    directory,
    prompt,
    opencodeClient,
    resolveOwnerClient: input.resolveOwnerClient,
    ...(input.createClients ? { createClients: input.createClients } : {}),
  });

  if (outcome.outcome === "refused") {
    if (outcome.reason === "serve_unavailable") {
      await sendTelegramReply(chatId, `opencode serve is not running${machineLabel}.`);
      return;
    }
    await sendTelegramReply(chatId, `Failed to launch session${machineLabel}: ${outcome.detail}`);
    return;
  }

  if (outcome.outcome === "unconfirmed" && outcome.sessionId === null) {
    try {
      await sendTelegramReply(chatId, `Launch${machineLabel} may or may not have started: ${outcome.detail}`);
    } catch (err) {
      console.warn(`[launch-ingest] unconfirmed reply failed:`, err);
    }
    return;
  }

  const sessionId = outcome.sessionId!;

  try {
    autoAttach(sessionId, input.spawn);
  } catch (err) {
    console.warn(`[launch-ingest] autoAttach failed session=${sessionId}:`, err);
  }

  let tagLine: string | null = null;
  try {
    tagLine = input.tag === undefined
      ? await inheritTag(input, sessionId, machineLabel)
      : await applyTag(input.tag, sessionId, input.runOcTags, machineLabel, input.onTagged);
    if (tagLine) {
      const what = input.tag === undefined ? `inherit=${input.inheritFromSessionId}` : `tag=${input.tag}`;
      console.log(`[launch-ingest] tag commandId=${commandId} session=${sessionId} ${what}: ${tagLine}`);
    }
  } catch (err) {
    console.warn(`[launch-ingest] tag step failed session=${sessionId}:`, err);
  }

  try {
    const builder = new TgMessageBuilder()
      .append(`Session started${machineLabel}:\n🆔 `)
      .appendCode(sessionId)
      .append("\n📂 ")
      .appendCode(directory);
    if (tagLine) {
      builder.append(`\n🏷 ${tagLine}`);
    }
    if (outcome.outcome === "unconfirmed") {
      builder.append(`\n⚠️ Its prompt may not have arrived: ${outcome.detail}`);
    }
    const msg = builder
      .append("\n\nThe pigeon plugin will notify you when the session stops or has questions.")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (err) {
    console.warn(`[launch-ingest] confirmation reply failed session=${sessionId}:`, err);
  }
}

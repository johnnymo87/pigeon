import { TgMessageBuilder, type TgEntity } from "../telegram-message.js";
import { expandShorthand, resolveHome } from "../worker/launch-ingest.js";
import { registerGooseSession, type GooseSessionStore } from "./register-session.js";
import { classifyReachability, type Reachability } from "./preflight.js";
import type { SessionRecord } from "../storage/types.js";

/**
 * `/launch --backend goose`: minting a goose session and driving its first turn.
 *
 * THE PROPERTY THIS MODULE IS SHAPED AROUND: it never throws. Every failure is
 * reported to the human and the command is acked.
 *
 * AFTER the mint, throwing would be actively destructive: the poller skips the
 * ack and the redelivered launch mints a SECOND goose session, leaving the human
 * with two, one of which nobody is watching.
 *
 * BEFORE the mint, throwing looks safe -- nothing exists to duplicate -- and is
 * not, on this path. `MAX_REDELIVERIES` lives in `ingestWorkerCommand`, which
 * only the `execute` command type enters; `onLaunch` calls this module directly.
 * So a throw here buys a retry every 60s for up to 24h with NOTHING said to the
 * human, and the most common failure of all is "goose serve was not running".
 * An unbounded silent retry is a worse answer than a lost launch, which costs
 * one retyped line. The opencode launch path already answers this way: unhealthy
 * serve, say so, ack.
 *
 * EVERY AWAIT IS BOUNDED, for the reason the runner gives at its own deadline:
 * the poller dispatches SERIALLY, so one unbounded await freezes command
 * delivery for every session on the machine -- including another session's
 * /interrupt -- and the ACP client deliberately has no per-request timeout, so a
 * socket that opens and then never answers would hang forever.
 *
 * WHY A THROWAWAY CLIENT MINTS THE SESSION. The runner is per-session and builds
 * its own client, and its `ensureConnected` is private -- so there is no client
 * to borrow before the session exists. A separate short-lived connection opens
 * the session, and the runner's own connection then drives it. That this works
 * at all is a measured property of goose 1.48.0, not an assumption: a session
 * minted on one connection is promptable from another after the first closes
 * (scripts/goose-id-split-probe.ts).
 *
 * WHY THE PROMPT GOES THROUGH THE RUNNER rather than the minting client: the
 * runner owns the turn, routes `session/update` frames to the transcript, and
 * reports the stop to Telegram. Prompting on the throwaway client would run a
 * real turn that nobody was listening to.
 */

export interface GooseLaunchRunner {
  deliver(commandId: string, text: string): Promise<unknown>;
}

/** The subset of GooseAcpClient this path needs, narrowed so tests can fake it. */
export interface GooseMintClient {
  connect(): Promise<void>;
  newSession(cwd: string): Promise<string>;
  close(): void;
}

export interface GooseLaunchInput {
  commandId: string;
  directory: string;
  prompt: string;
  chatId: string;
  machineId?: string;
  /** Where this daemon's goose serve listens. */
  acpUrl: string;
  acpToken?: string;
  sessions: GooseSessionStore;
  runnerFor: (session: SessionRecord) => GooseLaunchRunner;
  createMintClient: (url: string, token: string) => GooseMintClient;
  /** Registers the new session with the worker, so replies can route to it. */
  onSessionStart?: (sessionId: string, notify: boolean, label?: string | null) => Promise<void> | void;
  /**
   * MUST NOT THROW. It is called from inside this module's own failure
   * handling, so a throw here would escape and redeliver the launch -- the one
   * thing the whole module is arranged to prevent. The production sender
   * swallows send failures; see createTelegramReplySender.
   */
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
  now?: () => number;
  /** Bound on the two mint calls. See the file header. */
  mintTimeoutMs?: number;
  /** Injected for tests. */
  reachability?: typeof classifyReachability;
  mintPigeonId?: () => string;
}

/**
 * The same bound the runner uses for its non-turn calls, and for the same
 * reason: a handshake or a session/new is distinguishable from a TURN, which
 * may legitimately take minutes. Opening a session is not a turn.
 */
const MINT_TIMEOUT_MS = 10_000;

/** Rejects if `p` has not settled within `ms`. Does not cancel `p`. */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`goose ${what} did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Turns a preflight verdict into a message, or null to proceed.
 *
 * Every verdict reports rather than throwing -- see the file header. The
 * delivery adapter throws for `unreachable`, and that difference is deliberate:
 * there the command is the human's message to a live session, here it is one
 * retyped line, and only the adapter's path has a bounded redelivery counter.
 *
 * Exhaustive by construction: adding a Reachability variant makes the end of
 * this function reachable and fails the build under `strict`.
 */
function refusalFor(reach: Reachability, endpoint: string): string | null {
  switch (reach.kind) {
    case "ok":
      return null;
    case "auth-failed":
      return `goose rejected pigeon's token for ${endpoint}. Check PIGEON_GOOSE_ACP_TOKEN against the serve's GOOSE_SERVER__SECRET_KEY.`;
    case "not-goose":
      return `${endpoint} answered like something other than a goose serve (HTTP ${reach.status}). Check the port.`;
    case "unreachable":
      return `goose serve is not reachable at ${endpoint}: ${reach.cause}. Start it and re-send the launch.`;
  }
}

export async function ingestGooseLaunchCommand(input: GooseLaunchInput): Promise<void> {
  const { chatId, machineId, acpUrl, sendTelegramReply } = input;
  const directory = resolveHome(expandShorthand(input.directory));
  const machineLabel = machineId ? ` on ${machineId}` : "";
  const token = input.acpToken ?? "";
  const now = input.now ?? Date.now;

  // --- Before the mint. Throwing here is safe.
  const probe = input.reachability ?? classifyReachability;
  const refusal = refusalFor(await probe(acpUrl, token), acpUrl);
  if (refusal) {
    await sendTelegramReply(chatId, refusal);
    return;
  }

  const timeoutMs = input.mintTimeoutMs ?? MINT_TIMEOUT_MS;
  const client = input.createMintClient(acpUrl, token);
  let backendSessionId: string;
  try {
    // Both bounded. Preflight proved something answered HTTP, which says
    // nothing about whether the ACP handler behind it is healthy -- a wedged
    // serve accepts the upgrade and then never replies, and nothing else here
    // would ever end that wait.
    await withDeadline(client.connect(), timeoutMs, "connect");
    backendSessionId = await withDeadline(client.newSession(directory), timeoutMs, "session/new");
  } catch (err) {
    // Still before the mint, so nothing was created -- but reporting rather
    // than throwing, because a throw on this path is an unbounded silent retry.
    try { client.close(); } catch { /* closing a dead socket is not a failure */ }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[goose-launch] commandId=${input.commandId} could not start a session:`, err);
    await sendTelegramReply(chatId, `Could not start a goose session${machineLabel}: ${message}`);
    return;
  }
  // The session exists from here on. Everything below reports; nothing throws.
  try { client.close(); } catch { /* as above */ }

  // --- After the mint. A throw here would duplicate the session, so this
  // section reports every failure and the function returns normally.
  let sessionId: string | undefined;
  let failure: string | undefined;
  try {
    const registered = registerGooseSession(
      input.sessions,
      { backendSessionId, endpoint: acpUrl, cwd: directory, authToken: input.acpToken ?? null },
      now(),
      input.mintPigeonId,
    );
    if (!registered.ok) {
      // Only reachable if goose handed back an id that collides with an
      // existing session of another kind, which should not happen -- but
      // "should not happen" is not a reason to drop it silently.
      failure = `could not register it: ${registered.conflict}`;
    } else {
      sessionId = registered.sessionId;
      const session = input.sessions.get(sessionId);
      if (!session) throw new Error(`session ${sessionId} vanished immediately after registration`);

      // Announce BEFORE prompting: the worker routes the turn's stop
      // notification using this registration, so a turn that finished first
      // would have nowhere to report.
      await input.onSessionStart?.(sessionId, true, null);

      const outcome = await input.runnerFor(session).deliver(input.commandId, input.prompt);
      // A runner can decline without throwing. Unreachable for a runner this
      // fresh, but announcing "you'll get a message when the turn ends" over a
      // prompt that was never sent is the kind of quiet lie this path exists to
      // avoid.
      if (outcome && typeof outcome === "object" && "ok" in outcome && outcome.ok === false) {
        failure = `its first prompt was not accepted: ${String((outcome as { error?: unknown }).error ?? "unknown reason")}`;
      }
    }
  } catch (err) {
    console.error(`[goose-launch] commandId=${input.commandId} failed after minting ${backendSessionId}:`, err);
    failure = `starting its first turn failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Sending is OUTSIDE the try on purpose. Inside, a send that threw would be
  // caught and relabelled as a launch failure -- reporting the wrong cause for
  // a session that had actually started fine. `sendTelegramReply` is documented
  // as non-throwing; this makes the module correct even if that is ever untrue.
  try {
    if (failure !== undefined) {
      // Naming the ids is the point: the session really was created, so the
      // human must be able to reach it rather than be told the launch "failed"
      // and leave it orphaned.
      const idPart = sessionId ? ` (session ${sessionId}, goose id ${backendSessionId})` : ` (goose id ${backendSessionId})`;
      await sendTelegramReply(chatId, `The goose session was created${machineLabel}${idPart}, but ${failure}`);
      return;
    }

    const msg = new TgMessageBuilder()
      .append(`goose session started${machineLabel}:\n\u{1F194} `)
      .appendCode(sessionId!)
      .append("\n\u{1F4C2} ")
      .appendCode(directory)
      // goose's own name for it, which is what `goose session list` shows --
      // pigeon's id means nothing outside pigeon.
      .append("\n\u{1FABF} goose id ")
      .appendCode(backendSessionId)
      // Deliberately NOT the opencode path's "the pigeon plugin will notify
      // you": goose has no plugin, which is the whole reason this path exists.
      // The runner reports the turn instead.
      .append("\n\nYou'll get a message when the turn ends.")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (err) {
    // Last resort. The session exists and is registered either way; losing the
    // confirmation is survivable, redelivering the launch is not.
    console.error(`[goose-launch] commandId=${input.commandId} could not report its result:`, err);
  }
}

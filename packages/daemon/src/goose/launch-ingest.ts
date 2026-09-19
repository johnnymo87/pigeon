import { TgMessageBuilder, type TgEntity } from "../telegram-message.js";
import { expandShorthand, resolveHome } from "../worker/launch-ingest.js";
import { registerGooseSession, type GooseSessionStore } from "./register-session.js";
import { classifyReachability, type Reachability } from "./preflight.js";
import type { SessionRecord } from "../storage/types.js";

/**
 * `/launch --backend goose`: minting a goose session and driving its first turn.
 *
 * THE PROPERTY THIS MODULE IS SHAPED AROUND: nothing may throw once the session
 * has been minted. A throw reaches the poller, which then skips the ack, and the
 * redelivered launch mints a SECOND goose session -- leaving the human with two,
 * one of which nobody is watching. So the mint is the hinge: before it a throw
 * is the correct retry (nothing exists to duplicate), after it every failure is
 * caught and reported instead.
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
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
  now?: () => number;
  /** Injected for tests. */
  reachability?: typeof classifyReachability;
  mintPigeonId?: () => string;
}

/**
 * Turns a preflight verdict into either a throw (retry) or a message (give up).
 *
 * The split mirrors the delivery adapter's, and for the same reason: an
 * unreachable serve is usually a serve that is restarting, so the launch should
 * come back; a rejected token and a wrong port are not fixed by waiting, and
 * retrying them every 60s until the command expires tells the human nothing.
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
      // Nothing has been created, so the throw is safe and IS the retry: the
      // poller skips the ack, the lease lapses, and the launch comes back.
      throw new Error(`goose serve unreachable at ${endpoint}: ${reach.cause}`);
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

  const client = input.createMintClient(acpUrl, token);
  let backendSessionId: string;
  try {
    await client.connect();
    backendSessionId = await client.newSession(directory);
  } catch (err) {
    // Still before the mint: nothing was created, so this is retryable and a
    // throw is the retry. The client may be half-open; close it either way.
    try { client.close(); } catch { /* closing a dead socket is not a failure */ }
    throw err instanceof Error ? err : new Error(String(err));
  }
  // The session exists from here on. Everything below reports; nothing throws.
  try { client.close(); } catch { /* as above */ }

  // --- After the mint. A throw here would duplicate the session.
  let sessionId: string | undefined;
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
      await sendTelegramReply(
        chatId,
        `Started a goose session${machineLabel} but could not register it: ${registered.conflict}`,
      );
      return;
    }
    sessionId = registered.sessionId;

    const session = input.sessions.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} vanished immediately after registration`);

    // Announce BEFORE prompting: the turn's stop notification is routed by the
    // worker using this registration, so a turn that finishes before the
    // session is known would have nowhere to report.
    await input.onSessionStart?.(sessionId, true, null);

    await input.runnerFor(session).deliver(input.commandId, input.prompt);

    const msg = new TgMessageBuilder()
      .append(`goose session started${machineLabel}:\n🆔 `)
      .appendCode(sessionId)
      .append("\n📂 ")
      .appendCode(directory)
      // goose's own name for it, which is what `goose session list` shows --
      // pigeon's id means nothing outside pigeon.
      .append("\n🪿 goose id ")
      .appendCode(backendSessionId)
      // Deliberately NOT the opencode path's "the pigeon plugin will notify
      // you": goose has no plugin, which is the whole reason this path exists.
      // The runner reports the turn instead.
      .append("\n\nYou'll get a message when the turn ends.")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Naming the session id is the point: it was really created, so the human
    // needs to be able to reach it rather than be told the launch "failed" and
    // leave it orphaned.
    const idPart = sessionId ? ` (session ${sessionId}, goose id ${backendSessionId})` : "";
    console.error(`[goose-launch] commandId=${input.commandId} failed after minting ${backendSessionId}:`, err);
    await sendTelegramReply(
      chatId,
      `The goose session was created${machineLabel}${idPart}, but starting its first turn failed: ${message}`,
    );
  }
}

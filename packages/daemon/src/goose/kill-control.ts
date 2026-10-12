import type { SessionRecord } from "../storage/types.js";
import type { GooseRunnerRegistry } from "./session-runner.js";

export interface GooseKillDeps {
  storage: {
    sessions: {
      get(id: string): SessionRecord | null | undefined;
      delete(id: string): void;
    };
    assignments: {
      delete(id: string): void;
    };
  };
  gooseRunners?: GooseRunnerRegistry;
  poller?: {
    unregisterSession(id: string): Promise<unknown>;
  };
  reply: (text: string) => Promise<unknown>;
}

/**
 * Chooses the /kill notice based on runner cancel outcome and whether the
 * endpoint is honkd or bare goose.
 *
 * honk + "sent": Asked honkd to cancel; does not claim "cancelled" because honkd does not confirm.
 * honk + "failed": Honest "may still be running in honkd", plus cancel could not be sent.
 * bare + "sent"/"no-connection": Dropping connection cancels any running turn on goose.
 * bare + "failed": Closing connection still cancels on goose, so keep bare wording.
 * isHonk unknown + "failed": Cautious wording, the turn may still be running.
 */
export function pickKillReply(
  outcome: "sent" | "no-connection" | "failed",
  isHonk: boolean | undefined,
  isHonkKnown: boolean | undefined,
): string {
  if (isHonk) {
    if (outcome === "sent") {
      return (
        "Session closed. Asked honkd to cancel any running turn; "
        + "pigeon has stopped tracking the session."
      );
    }
    return (
      "Session closed. Could not send cancel to honkd; the turn may still be running in honkd; "
      + "pigeon has stopped tracking the session."
    );
  }

  if (isHonkKnown) {
    // Known bare goose: closing the connection cancels any turn that was running
    return (
      "Session closed. That dropped pigeon's connection to goose, which cancels "
      + "any turn that was running; pigeon has stopped tracking the session."
    );
  }

  // isHonk is unknown when connect failed: treat as honk-unknown and use cautious wording
  return (
    "Session closed. Could not send cancel; the turn may still be running; "
    + "pigeon has stopped tracking the session."
  );
}

/**
 * Executes /kill for a goose session.
 *
 * Sends session/cancel before the socket is closed and records are deleted.
 * Reads the session record before deletion so a runner can be obtained even
 * after a pigeon restart.
 */
export async function executeGooseKill(sessionId: string, deps: GooseKillDeps): Promise<void> {
  const session = deps.storage.sessions.get(sessionId);
  const runner = session && deps.gooseRunners ? deps.gooseRunners.get(session) : undefined;
  const outcome = runner ? await runner.cancel() : "no-connection";
  const isHonk = runner?.isHonk;
  const isHonkKnown = runner?.isHonkKnown;

  deps.gooseRunners?.drop(sessionId);
  deps.storage.sessions.delete(sessionId);
  deps.storage.assignments.delete(sessionId);
  if (deps.poller) {
    try {
      await deps.poller.unregisterSession(sessionId);
    } catch (err) {
      console.warn(`[index] onKill: goose session unregister failed for ${sessionId}:`, err);
    }
  }

  const replyText = pickKillReply(outcome, isHonk, isHonkKnown);
  await deps.reply(replyText);
}

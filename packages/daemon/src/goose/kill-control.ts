import type { SessionRecord } from "../storage/types.js";
import type { GooseRunnerRegistry, GooseSessionRunner } from "./session-runner.js";

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

export type KillOutcome = "sent" | "no-connection" | "failed" | "no-runner";

/**
 * Chooses the /kill notice based on runner cancel outcome and whether the
 * endpoint is honkd or bare goose.
 *
 * honk + "sent": Asked honkd to cancel; does not claim "cancelled" because honkd does not confirm.
 * honk + "failed": Honest "may still be running there", plus cancel could not be sent.
 * bare + "sent": Pigeon sent goose a cancel and dropped the connection (any running turn is cancelled).
 * bare + "no-connection" / "failed": Closing connection cancels any running turn on goose (today's bare wording).
 * no-runner: When no runner exists (e.g. absent session record), cautious wording (turn may still be running).
 * isHonk unknown + "failed": Cautious wording, the turn may still be running.
 */
export function pickKillReply(
  outcome: KillOutcome,
  isHonk: boolean | undefined,
  isHonkKnown: boolean | undefined,
): string {
  if (outcome === "no-runner") {
    return (
      "Session closed. Could not send cancel; the turn may still be running; "
      + "pigeon has stopped tracking the session."
    );
  }

  if (isHonk) {
    if (outcome === "sent") {
      return (
        "Session closed. Asked honkd to cancel any running turn; "
        + "pigeon has stopped tracking the session."
      );
    }
    return (
      "Session closed. Could not send cancel to honkd; the turn may still be running there; "
      + "pigeon has stopped tracking the session."
    );
  }

  if (outcome === "sent") {
    return (
      "Session closed. Pigeon sent goose a cancel and dropped the connection; "
      + "any running turn is cancelled; pigeon has stopped tracking the session."
    );
  }

  if (outcome === "no-connection" || isHonkKnown) {
    // Known bare goose or no-connection: closing the connection cancels any turn that was running
    return (
      "Session closed. That dropped pigeon's connection to goose, which cancels "
      + "any turn that was running; pigeon has stopped tracking the session."
    );
  }

  // outcome === "failed" and isHonk is unknown (e.g. connect failed before initialize)
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
  let outcome: KillOutcome = "no-runner";
  let runner: GooseSessionRunner | undefined;
  let droppedQueued = 0;
  if (session && deps.gooseRunners) {
    try {
      runner = deps.gooseRunners.get(session);
      try {
        droppedQueued = runner.dropQueued();
      } catch (err) {
        console.warn(`[kill-control] runner.dropQueued failed for ${sessionId}:`, err);
      }
      outcome = await runner.cancel();
    } catch (err) {
      console.warn(`[kill-control] runner.cancel failed for ${sessionId}:`, err);
      outcome = "failed";
    }
  }
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

  let replyText = pickKillReply(outcome, isHonk, isHonkKnown);
  if (droppedQueued > 0) {
    replyText += ` ${droppedQueued} queued message(s) were discarded.`;
  }
  await deps.reply(replyText);
}

import { OpencodeHttpError, type OpencodeClient } from "../opencode-client";
import { ChatMessageBuilder, type ChatEntity } from "../chat-message";
import type { KillMessage } from "./poller";

export interface KillCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendChatReply: (chatId: string, text: string, entities?: ChatEntity[]) => Promise<void>;
  /**
   * Tears down pigeon's side of a session opencode has just deleted: the daemon's sessions row,
   * its routing, and the worker registration with an immediate topic close (pigeon-4ogz.20).
   * Before this a /kill left the row behind, so the topic (or Slack channel) stayed open until the
   * orphan closer collected it past the 7-day idle TTL.
   *
   * Called AFTER the reply, because closing a Slack session channel archives it and a reply into
   * an archived channel fails. Called only when the delete succeeded or answered 404: after any
   * other failure the session may still be alive, and dropping its row would orphan it from chat.
   */
  onTerminated?: (sessionId: string) => Promise<void>;
}

export async function ingestKillCommand(input: KillCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendChatReply, onTerminated } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  // Abort first. DELETE alone does not stop a busy session's prompt loop, and its next event
  // would make the plugin re-register the session, reopening the topic the teardown closes.
  // Best-effort: an idle session has nothing to abort, and the delete is what matters.
  try {
    await opencodeClient.abortSession(sessionId);
  } catch (error) {
    if (!(error instanceof OpencodeHttpError && error.status === 404)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[kill-ingest] abort before delete failed sessionId=${sessionId}: ${message}`);
    }
  }

  let alreadyGone = false;
  try {
    await opencodeClient.deleteSession(sessionId);
  } catch (error) {
    // A 404 means opencode has no such session: a redelivered kill whose first delete landed
    // after its timeout, or a session deleted in the TUI. Gone either way, so pigeon's side goes
    // too. Serves on a machine share one session DB, so any serve's 404 is authoritative.
    if (error instanceof OpencodeHttpError && error.status === 404) {
      alreadyGone = true;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[kill-ingest] failed to terminate session sessionId=${sessionId}: ${message}`);
      await sendChatReply(chatId, `Failed to kill session${machineLabel}: ${message}`);
      return;
    }
  }

  console.log(`[kill-ingest] session ${alreadyGone ? "already gone" : "terminated"} sessionId=${sessionId}`);
  try {
    const msg = new ChatMessageBuilder()
      .append(alreadyGone ? `Session already gone${machineLabel}; closed pigeon's side.\n🆔 ` : `Session terminated${machineLabel}.\n🆔 `)
      .appendCode(sessionId)
      .build();
    await sendChatReply(chatId, msg.text, msg.entities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[kill-ingest] terminated reply failed sessionId=${sessionId}: ${message}`);
  }

  if (!onTerminated) return;
  // Never throws: a throw would skip the poller ack, and the kill would be redelivered every lease
  // expiry, each time answering "Failed to kill" for a session that is already gone.
  try {
    await onTerminated(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[kill-ingest] teardown failed sessionId=${sessionId}: ${message}`);
  }
}

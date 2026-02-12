import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import { OpencodeDirectSource, type OpencodeDirectSource as OpencodeDirectSourceType } from "../opencode-direct/contracts";
import {
  executeViaOpencodeDirectChannel,
  type OpencodeDirectExecuteResult,
} from "../opencode-direct/adapter";

export interface WorkerCommandMessage {
  type: "command";
  commandId?: string;
  id?: string;
  sessionId: string;
  command: string;
  chatId?: string;
}

export interface WorkerAckMessage {
  type: "ack";
  commandId: string;
}

export interface WorkerCommandResultMessage {
  type: "commandResult";
  commandId: string;
  success: boolean;
  error: string | null;
  chatId?: string;
}

export interface WorkerCommandIngestCallbacks {
  send: (payload: WorkerAckMessage | WorkerCommandResultMessage) => void;
}

export interface WorkerCommandIngestOptions {
  executeDirect?: (
    session: SessionRecord,
    msg: WorkerCommandMessage,
    commandId: string,
  ) => Promise<OpencodeDirectExecuteResult>;
}

function directSourceForMessage(msg: WorkerCommandMessage): OpencodeDirectSourceType {
  const command = msg.command.trim();
  if (command === "continue" || command === "y" || command === "n" || command === "exit") {
    return OpencodeDirectSource.TelegramCallback;
  }
  return OpencodeDirectSource.TelegramReply;
}

export async function ingestWorkerCommand(
  storage: StorageDb,
  msg: WorkerCommandMessage,
  callbacks: WorkerCommandIngestCallbacks,
  options: WorkerCommandIngestOptions = {},
): Promise<void> {
  const commandId = msg.commandId ?? msg.id;
  if (!commandId) {
    return;
  }

  const persisted = storage.inbox.persist({
    commandId,
    payload: JSON.stringify(msg),
  });

  if (!persisted) {
    callbacks.send({ type: "ack", commandId });
    return;
  }

  callbacks.send({ type: "ack", commandId });

  const session = storage.sessions.get(msg.sessionId);
  if (!session) {
    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error: "Session not found. Wait for a new notification.",
      chatId: msg.chatId,
    });
    return;
  }

  if (
    session.backendKind === "opencode-plugin-direct"
    && session.backendEndpoint
    && session.backendAuthToken
  ) {
    const executeDirect = options.executeDirect ?? ((sess, commandMsg, id) =>
      executeViaOpencodeDirectChannel({
        requestId: id,
        commandId: id,
        sessionId: commandMsg.sessionId,
        command: commandMsg.command,
        endpoint: sess.backendEndpoint!,
        authToken: sess.backendAuthToken!,
        source: directSourceForMessage(commandMsg),
        ...(commandMsg.chatId ? { chatId: commandMsg.chatId } : {}),
      }));

    const direct = await executeDirect(session, msg, commandId);

    if (direct.ok) {
      storage.inbox.markDone(commandId);
      callbacks.send({
        type: "commandResult",
        commandId,
        success: true,
        error: null,
        chatId: msg.chatId,
      });
      return;
    }

    const error =
      direct.result?.errorMessage
      || direct.error
      || direct.ack?.message
      || direct.ack?.rejectReason
      || "OpenCode direct-channel execution failed";

    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error,
      chatId: msg.chatId,
    });
    return;
  }

  // Session exists but is not configured for direct-channel delivery.
  // This means the session is either missing backend fields or uses an
  // unsupported backend kind.
  callbacks.send({
    type: "commandResult",
    commandId,
    success: false,
    error: "Session is not configured for command delivery. Re-register with backend endpoint and auth token.",
    chatId: msg.chatId,
  });
}

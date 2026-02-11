import type { StorageDb } from "../storage/database";
import { injectWithFallback } from "../injectors/injector-factory";
import type { InjectionResult } from "../injectors/types";
import type { SessionRecord } from "../storage/types";

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
  injectCommand?: (session: SessionRecord, command: string) => Promise<InjectionResult>;
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

  const injectCommand = options.injectCommand ?? injectWithFallback;
  const result = await injectCommand(session, msg.command);

  if (result.ok) {
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

  callbacks.send({
    type: "commandResult",
    commandId,
    success: false,
    error: result.error ?? "Injection failed",
    chatId: msg.chatId,
  });
}

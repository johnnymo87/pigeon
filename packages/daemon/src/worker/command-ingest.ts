import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryResult } from "../adapters/types";
import { DirectChannelAdapter } from "../adapters/direct-channel";
import { NvimRpcAdapter } from "../adapters/nvim-rpc";
import {
  type OpencodeDirectExecuteResult,
} from "../opencode-direct/adapter";
import {
  OpencodeDirectSource,
  type OpencodeDirectSource as OpencodeDirectSourceType,
} from "../opencode-direct/contracts";

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
  /** Override adapter selection for testing */
  createAdapter?: (session: SessionRecord) => CommandDeliveryAdapter | null;
  /**
   * Legacy test injection for direct-channel execution.
   * If provided AND session matches direct-channel, wraps the function in an adapter.
   * Prefer `createAdapter` for new code.
   */
  executeDirect?: (
    session: SessionRecord,
    msg: WorkerCommandMessage,
    commandId: string,
  ) => Promise<OpencodeDirectExecuteResult>;
}

const QUESTION_OPTION_RE = /^q(\d+)$/;

function directSourceForMessage(msg: WorkerCommandMessage): OpencodeDirectSourceType {
  const command = msg.command.trim();
  if (QUESTION_OPTION_RE.test(command)) {
    return OpencodeDirectSource.TelegramCallback;
  }
  return OpencodeDirectSource.TelegramReply;
}

function selectAdapter(session: SessionRecord): CommandDeliveryAdapter | null {
  if (
    session.backendKind === "opencode-plugin-direct"
    && session.backendEndpoint
    && session.backendAuthToken
  ) {
    return new DirectChannelAdapter();
  }

  if (session.nvimSocket && session.ptyPath) {
    return new NvimRpcAdapter();
  }

  return null;
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

  // Check for pending question: if session has a pending question, route as question reply
  const pendingQuestion = storage.pendingQuestions.getBySessionId(msg.sessionId);
  if (pendingQuestion) {
    const command = msg.command.trim();
    const optionMatch = QUESTION_OPTION_RE.exec(command);

    let answers: string[][];
    if (optionMatch) {
      const index = Number(optionMatch[1]);
      const firstQuestion = pendingQuestion.questions[0];
      if (!firstQuestion || index >= firstQuestion.options.length) {
        callbacks.send({
          type: "commandResult",
          commandId,
          success: false,
          error: `Invalid option index ${index}. This question has ${firstQuestion?.options.length ?? 0} options.`,
          chatId: msg.chatId,
        });
        return;
      }
      answers = [[firstQuestion.options[index]!.label]];
    } else {
      // Custom text answer
      answers = [[command]];
    }

    const adapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (!adapter || !adapter.deliverQuestionReply) {
      callbacks.send({
        type: "commandResult",
        commandId,
        success: false,
        error: "Session adapter does not support question replies",
        chatId: msg.chatId,
      });
      return;
    }

    const result = await adapter.deliverQuestionReply(
      session,
      { questionRequestId: pendingQuestion.requestId, answers },
      { commandId, chatId: msg.chatId },
    );

    if (result.ok) {
      storage.inbox.markDone(commandId);
      storage.pendingQuestions.delete(msg.sessionId);
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
      error: result.error || "Question reply delivery failed",
      chatId: msg.chatId,
    });
    return;
  }

  // If command looks like a question option but no pending question, it's stale
  if (QUESTION_OPTION_RE.test(msg.command.trim())) {
    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error: "This question has already been answered.",
      chatId: msg.chatId,
    });
    return;
  }

  // Legacy executeDirect support: wrap in an adapter shim for backward compat
  if (
    options.executeDirect
    && session.backendKind === "opencode-plugin-direct"
    && session.backendEndpoint
    && session.backendAuthToken
  ) {
    const executeDirect = options.executeDirect;
    const legacyAdapter: CommandDeliveryAdapter = {
      name: "direct-channel-legacy",
      async deliverCommand(sess, cmd, ctx) {
        const direct = await executeDirect(sess, msg, ctx.commandId);
        if (direct.ok) {
          return { ok: true, meta: { attempts: direct.attempts, status: direct.status } };
        }
        const error =
          direct.result?.errorMessage
          || direct.error
          || direct.ack?.message
          || direct.ack?.rejectReason
          || "OpenCode direct-channel execution failed";
        return { ok: false, error, meta: { attempts: direct.attempts, status: direct.status } };
      },
    };
    return deliverViaAdapter(legacyAdapter, session, msg, commandId, storage, callbacks);
  }

  const adapter = options.createAdapter
    ? options.createAdapter(session)
    : selectAdapter(session);

  if (!adapter) {
    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error: "Session is not configured for command delivery. Re-register with backend endpoint and auth token.",
      chatId: msg.chatId,
    });
    return;
  }

  return deliverViaAdapter(adapter, session, msg, commandId, storage, callbacks);
}

async function deliverViaAdapter(
  adapter: CommandDeliveryAdapter,
  session: SessionRecord,
  msg: WorkerCommandMessage,
  commandId: string,
  storage: StorageDb,
  callbacks: WorkerCommandIngestCallbacks,
): Promise<void> {
  const result = await adapter.deliverCommand(session, msg.command, {
    commandId,
    chatId: msg.chatId,
  });

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
    error: result.error || "Command delivery failed",
    chatId: msg.chatId,
  });
}

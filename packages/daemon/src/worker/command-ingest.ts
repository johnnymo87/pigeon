import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryContext, CommandDeliveryResult } from "../adapters/types";
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
  media?: {
    key: string;
    mime: string;
    filename: string;
    size: number;
  };
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
  /** Worker base URL for fetching media from R2 (e.g. https://ccr-router.workers.dev) */
  workerUrl?: string;
  /** API key for authenticating media fetch requests to the worker */
  apiKey?: string;
  /** Override fetch for testing */
  fetchFn?: typeof fetch;
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
    console.log(`[command-ingest] dedup commandId=${commandId}`);
    callbacks.send({ type: "ack", commandId });
    return;
  }

  callbacks.send({ type: "ack", commandId });

  const session = storage.sessions.get(msg.sessionId);
  if (!session) {
    console.warn(`[command-ingest] session not found sessionId=${msg.sessionId} commandId=${commandId}`);
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
    console.log(`[command-ingest] routing as question reply sessionId=${msg.sessionId} commandId=${commandId} requestId=${pendingQuestion.requestId}`);
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
      console.log(`[command-ingest] question reply delivered commandId=${commandId}`);
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

    console.warn(`[command-ingest] question reply failed commandId=${commandId} error=${result.error}`);
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
    console.log(`[command-ingest] stale question option commandId=${commandId}`);
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
    console.warn(`[command-ingest] no adapter for session sessionId=${msg.sessionId} commandId=${commandId} backendKind=${session.backendKind}`);
    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error: "Session is not configured for command delivery. Re-register with backend endpoint and auth token.",
      chatId: msg.chatId,
    });
    return;
  }

  // Fetch media from worker's R2 endpoint if present
  let mediaPayload: CommandDeliveryContext["media"];
  if (msg.media) {
    const fetchFn = options.fetchFn ?? globalThis.fetch;
    const workerUrl = options.workerUrl ?? "";
    const apiKey = options.apiKey ?? "";
    try {
      const mediaRes = await fetchFn(`${workerUrl}/media/${msg.media.key}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!mediaRes.ok) {
        throw new Error(`R2 fetch failed: ${mediaRes.status}`);
      }
      const bytes = await mediaRes.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");
      mediaPayload = {
        mime: msg.media.mime,
        filename: msg.media.filename,
        url: `data:${msg.media.mime};base64,${base64}`,
      };
    } catch (err) {
      console.warn(`[command-ingest] media fetch failed commandId=${commandId} key=${msg.media!.key} error=${err instanceof Error ? err.message : String(err)}`);
      callbacks.send({
        type: "commandResult",
        commandId,
        success: false,
        error: `Failed to fetch media: ${err instanceof Error ? err.message : String(err)}`,
        chatId: msg.chatId,
      });
      return;
    }
  }

  return deliverViaAdapter(adapter, session, msg, commandId, storage, callbacks, mediaPayload);
}

async function deliverViaAdapter(
  adapter: CommandDeliveryAdapter,
  session: SessionRecord,
  msg: WorkerCommandMessage,
  commandId: string,
  storage: StorageDb,
  callbacks: WorkerCommandIngestCallbacks,
  media?: CommandDeliveryContext["media"],
): Promise<void> {
  const result = await adapter.deliverCommand(session, msg.command, {
    commandId,
    chatId: msg.chatId,
    ...(media ? { media } : {}),
  });

  if (result.ok) {
    console.log(`[command-ingest] delivered commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId}`);
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

  console.warn(`[command-ingest] delivery failed commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId} error=${result.error}`);
  callbacks.send({
    type: "commandResult",
    commandId,
    success: false,
    error: result.error || "Command delivery failed",
    chatId: msg.chatId,
  });
}

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
import type { ExecuteMessage } from "./poller";
import { formatQuestionWizardStep } from "../notification-service";
import { reviveAndDeliver, type ReviveAndDeliverDeps } from "./revive-and-deliver";

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
    msg: ExecuteMessage,
    commandId: string,
  ) => Promise<OpencodeDirectExecuteResult>;
  /** Worker base URL for fetching media from R2 (e.g. https://ccr-router.workers.dev) */
  workerUrl?: string;
  /** API key for authenticating media fetch requests to the worker */
  apiKey?: string;
  /** Override fetch for testing */
  fetchFn?: typeof fetch;
  /** Edit an existing Telegram notification (for wizard step transitions) */
  editNotification?: (notificationId: string, text: string, replyMarkup: unknown, entities?: unknown[]) => Promise<{ ok: boolean }>;
  /** Machine ID for formatting wizard steps */
  machineId?: string;
  /** OpenCode client for plugin-free fallback delivery on plugin death. */
  opencodeClient?: ReviveAndDeliverDeps["opencodeClient"];
  /** Send a reply to Telegram (used for revive-on-reply error notifications). */
  sendTelegramReply?: (chatId: string, text: string) => Promise<void>;
  /** Injected spawn for testing (passed through to reviveAndDeliver). */
  spawn?: ReviveAndDeliverDeps["spawn"];
}

const QUESTION_OPTION_RE = /^q(\d+)$/;
const WIZARD_OPTION_RE = /^v(\d+):q(\d+)$/;

function directSourceForMessage(msg: ExecuteMessage): OpencodeDirectSourceType {
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

/**
 * Ingest an execute command from the Poller.
 *
 * Returns normally (Poller acks) for permanent failures.
 * Throws for transient failures (Poller skips ack, command retries).
 */
export async function ingestWorkerCommand(
  storage: StorageDb,
  msg: ExecuteMessage,
  options: WorkerCommandIngestOptions = {},
): Promise<void> {
  const commandId = msg.commandId;

  const persisted = storage.inbox.persist({
    commandId,
    payload: JSON.stringify(msg),
  });

  if (!persisted) {
    console.log(`[command-ingest] dedup commandId=${commandId}`);
    return;
  }

  const session = storage.sessions.get(msg.sessionId);
  if (!session) {
    console.warn(`[command-ingest] session not found sessionId=${msg.sessionId} commandId=${commandId}`);
    // Permanent failure: retrying won't help if the session doesn't exist
    return;
  }

  // Check for pending question: if session has a pending question, route as question reply
  const pendingQuestion = storage.pendingQuestions.getBySessionId(msg.sessionId);
  if (pendingQuestion) {
    console.log(`[command-ingest] routing as question reply sessionId=${msg.sessionId} commandId=${commandId} requestId=${pendingQuestion.requestId}`);
    const command = msg.command.trim();
    const wizardMatch = WIZARD_OPTION_RE.exec(command);
    const legacyMatch = !wizardMatch ? QUESTION_OPTION_RE.exec(command) : null;
    const isWizard = pendingQuestion.questions.length > 1;

    // Validate wizard version if wizard match found and this is a wizard question
    if (wizardMatch && isWizard) {
      const incomingVersion = Number(wizardMatch[1]);
      if (incomingVersion !== pendingQuestion.version) {
        console.log(`[command-ingest] stale wizard version incoming=${incomingVersion} current=${pendingQuestion.version} commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        return;
      }
    }

    // Determine which question we're answering (current step for wizard, first for single)
    const currentQuestion = isWizard
      ? pendingQuestion.questions[pendingQuestion.currentStep]
      : pendingQuestion.questions[0];

    // Resolve the step answer
    let stepAnswer: string;
    if (wizardMatch || legacyMatch) {
      // Option button press
      const match = wizardMatch ?? legacyMatch!;
      const optionIndexStr = wizardMatch ? wizardMatch[2] : match[1];
      const index = Number(optionIndexStr);
      if (!currentQuestion || index >= currentQuestion.options.length) {
        console.warn(`[command-ingest] invalid option index ${index} for commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        return;
      }
      stepAnswer = currentQuestion.options[index]!.label;
    } else {
      // Custom text answer
      stepAnswer = command;
    }

    if (isWizard) {
      const isLastStep = pendingQuestion.currentStep === pendingQuestion.questions.length - 1;

      if (!isLastStep) {
        // Advance wizard to next step
        const updated = storage.pendingQuestions.advanceStep(msg.sessionId, [stepAnswer]);
        if (!updated) {
          console.warn(`[command-ingest] wizard advance failed commandId=${commandId}`);
          storage.inbox.markDone(commandId);
          return;
        }

        // Format next step
        const notificationId = `q:${msg.sessionId}:${pendingQuestion.requestId}`;
        const label = session.label || session.sessionId.slice(0, 8);
        const { message, replyMarkup } = formatQuestionWizardStep({
          label,
          questions: pendingQuestion.questions,
          currentStep: updated.currentStep,
          cwd: session.cwd,
          token: pendingQuestion.token ?? "",
          version: updated.version,
          sessionId: msg.sessionId,
          machineId: options.machineId,
        });

        await options.editNotification?.(notificationId, message.text, replyMarkup, message.entities);

        console.log(`[command-ingest] wizard advanced to step ${updated.currentStep} commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        return;
      }

      // Final step: collect all answers and deliver to opencode
      const allAnswers = [...pendingQuestion.answers, [stepAnswer]];

      const adapter = options.createAdapter
        ? options.createAdapter(session)
        : selectAdapter(session);

      if (!adapter || !adapter.deliverQuestionReply) {
        console.warn(`[command-ingest] session adapter does not support question replies commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        return;
      }

      const result = await adapter.deliverQuestionReply(
        session,
        { questionRequestId: pendingQuestion.requestId, answers: allAnswers },
        { commandId, chatId: msg.chatId },
      );

      if (result.ok) {
        console.log(`[command-ingest] wizard complete, all answers delivered commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        storage.pendingQuestions.delete(msg.sessionId);

        const notificationId = `q:${msg.sessionId}:${pendingQuestion.requestId}`;
        await options.editNotification?.(notificationId, "All answers submitted ✅", { inline_keyboard: [] });
        return;
      }

      console.warn(`[command-ingest] wizard final delivery failed commandId=${commandId} error=${result.error}`);
      storage.inbox.markDone(commandId);
      return;
    }

    // Single-question path (existing behavior)
    const answers: string[][] = [[stepAnswer]];

    const adapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (!adapter || !adapter.deliverQuestionReply) {
      console.warn(`[command-ingest] session adapter does not support question replies commandId=${commandId}`);
      storage.inbox.markDone(commandId);
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
      return;
    }

    console.warn(`[command-ingest] question reply failed commandId=${commandId} error=${result.error}`);
    storage.inbox.markDone(commandId);
    return;
  }

  // Metadata fallback: if no pending question found locally but command has
  // question metadata from the worker, route as a question reply anyway.
  // This handles the case where the daemon's pending_questions state is stale
  // (e.g., daemon restarted, TTL expired, race with question-answered event).
  if (msg.metadata?.questionRequestId) {
    console.warn(`[command-ingest] question-reply via metadata fallback sessionId=${msg.sessionId} commandId=${commandId} requestId=${msg.metadata.questionRequestId}`);

    const fallbackAdapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (fallbackAdapter?.deliverQuestionReply) {
      const answers: string[][] = [[msg.command.trim()]];
      const result = await fallbackAdapter.deliverQuestionReply(
        session,
        { questionRequestId: msg.metadata.questionRequestId, answers },
        { commandId, chatId: msg.chatId },
      );

      if (result.ok) {
        console.log(`[command-ingest] metadata fallback question reply delivered commandId=${commandId}`);
        storage.inbox.markDone(commandId);
        // Clean up any stale pending question just in case
        storage.pendingQuestions.delete(msg.sessionId);
        return;
      }

      // If question reply fails (e.g., 404 question not found), fall through to
      // regular command delivery so the user's text isn't lost.
      console.warn(`[command-ingest] metadata fallback question reply failed commandId=${commandId} error=${result.error}, falling through to regular delivery`);
    } else {
      console.warn(`[command-ingest] metadata fallback: adapter does not support question replies commandId=${commandId}, falling through to regular delivery`);
    }
  }

  // If command looks like a question option but no pending question, it's stale
  if (QUESTION_OPTION_RE.test(msg.command.trim()) || WIZARD_OPTION_RE.test(msg.command.trim())) {
    console.log(`[command-ingest] stale question option commandId=${commandId} sessionId=${msg.sessionId}`);
    storage.inbox.markDone(commandId);
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
    return deliverViaAdapter(legacyAdapter, session, msg, commandId, storage, options);
  }

  const adapter = options.createAdapter
    ? options.createAdapter(session)
    : selectAdapter(session);

  if (!adapter) {
    console.warn(`[command-ingest] no adapter for session sessionId=${msg.sessionId} commandId=${commandId} backendKind=${session.backendKind}`);
    // Permanent failure: ack and move on
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
      // Transient failure: throw so Poller skips ack and command retries
      throw err;
    }
  }

  return deliverViaAdapter(adapter, session, msg, commandId, storage, options, mediaPayload);
}



function isConnectionError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("unable to connect") ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("timed out") ||
    lower.includes("abort") ||
    lower.includes("fetch failed") ||
    lower.includes("network error")
  );
}

async function deliverViaAdapter(
  adapter: CommandDeliveryAdapter,
  session: SessionRecord,
  msg: ExecuteMessage,
  commandId: string,
  storage: StorageDb,
  options: WorkerCommandIngestOptions,
  media?: CommandDeliveryContext["media"],
): Promise<void> {
  const modelOverride = storage.sessions.getModelOverride(session.sessionId) ?? undefined;

  const result = await adapter.deliverCommand(session, msg.command, {
    commandId,
    chatId: msg.chatId,
    ...(modelOverride ? { modelOverride } : {}),
    ...(media ? { media } : {}),
  });

  if (result.ok) {
    console.log(`[command-ingest] delivered commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId}`);
    storage.inbox.markDone(commandId);
    return;
  }

  console.warn(`[command-ingest] delivery failed commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId} error=${result.error}`);

  if (isConnectionError(result.error)) {
    // Plugin endpoint is dead. If we have an opencodeClient, try the
    // plugin-free fallback (revive-on-reply). Otherwise fall back to the
    // original behavior of deleting the session.
    if (options.opencodeClient) {
      const revived = await reviveAndDeliver(
        storage,
        msg.sessionId,
        msg.command,
        {
          opencodeClient: options.opencodeClient,
          ...(options.spawn ? { spawn: options.spawn } : {}),
        },
      );

      if (revived.ok) {
        console.log(`[command-ingest] revived sessionId=${msg.sessionId} commandId=${commandId} (plugin-free fallback)`);
        storage.inbox.markDone(commandId);
        return;
      }

      switch (revived.reason) {
        case "sessionGone": {
          console.warn(`[command-ingest] session gone in opencode-serve sessionId=${msg.sessionId}`);
          storage.sessions.delete(msg.sessionId);
          await options.sendTelegramReply?.(
            msg.chatId,
            `Session no longer exists. The opencode session was deleted from this machine.`,
          );
          storage.inbox.markDone(commandId);
          return;
        }
        case "serveUnreachable": {
          console.warn(`[command-ingest] opencode-serve unreachable for revival sessionId=${msg.sessionId}: ${revived.error}`);
          await options.sendTelegramReply?.(
            msg.chatId,
            `opencode-serve is unreachable. Try again in a moment.`,
          );
          storage.inbox.markDone(commandId);
          return;
        }
        case "deliveryFailed": {
          console.warn(`[command-ingest] revival delivery failed sessionId=${msg.sessionId}: ${revived.error}`);
          await options.sendTelegramReply?.(
            msg.chatId,
            `Delivery failed: ${revived.error}`,
          );
          storage.inbox.markDone(commandId);
          return;
        }
        case "sessionMissing": {
          // Storage row vanished between the lookup at line 91 and now. Defensive
          // no-op — the worker will see no session and future commands will fail
          // with "session not found".
          console.warn(`[command-ingest] revive-and-deliver: session row missing sessionId=${msg.sessionId}`);
          storage.inbox.markDone(commandId);
          return;
        }
        default: {
          const _exhaustive: never = revived;
          console.warn(`[command-ingest] unexpected revive result: ${JSON.stringify(_exhaustive)}`);
          storage.inbox.markDone(commandId);
          return;
        }
      }
    }

    // No opencodeClient — preserve the original "delete dead session" behavior.
    console.warn(`[command-ingest] removing dead session sessionId=${msg.sessionId} (no opencodeClient for revival)`);
    storage.sessions.delete(msg.sessionId);
    return;
  }

  // Permanent failure: ack and move on
  return;
}

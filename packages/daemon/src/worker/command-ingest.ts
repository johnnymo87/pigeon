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
import { formatQuestionWizardStep, displayName } from "../notification-service";
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
  /** Unregister session worker-side when local session is deleted. */
  unregisterSession?: (sessionId: string) => Promise<unknown>;
  /** Injected spawn for testing (passed through to reviveAndDeliver). */
  spawn?: ReviveAndDeliverDeps["spawn"];
  /**
   * Total wall-clock budget for retrying an *ambiguous* (plugin-alive-but-busy)
   * delivery through the idempotent plugin before falling back to revive.
   * Kept under the worker's 60s lease. Defaults to {@link DEFAULT_DELIVERY_BUDGET_MS}.
   */
  deliveryBudgetMs?: number;
  /** Injectable clock for testing the delivery budget. */
  now?: () => number;
  /** Injectable sleep for testing the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long we keep retrying an ambiguous delivery through the idempotent plugin
 * before reviving. Each ambiguous attempt can take ~15s (the adapter's abort
 * timeout), so ~40s allows up to ~3 attempts and still leaves headroom under the
 * 60s lease for the revive + ack. The plugin dedups on commandId, so these
 * retries collapse a landed-but-slow first attempt to a single injection.
 */
export const DEFAULT_DELIVERY_BUDGET_MS = 40_000;

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
    const existing = storage.inbox.get(commandId);
    if (!existing || existing.status === "done") {
      console.log(`[command-ingest] dedup commandId=${commandId}`);
      return;
    }
    console.log(`[command-ingest] retry unfinished commandId=${commandId}`);
  }

  const session = storage.sessions.get(msg.sessionId);
  if (!session) {
    console.warn(`[command-ingest] session not found sessionId=${msg.sessionId} commandId=${commandId}`);
    // Permanent failure: retrying won't help if the session doesn't exist.
    // Mirrors the reply the revive path already sends for the same condition.
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      `Session no longer exists on this machine. It may have been closed or reaped.`,
      options.sendTelegramReply,
    );
    return;
  }

  // Check for pending question: if session has a pending question, route as question reply
  let pendingQuestion = storage.pendingQuestions.getBySessionId(msg.sessionId);
  if (!pendingQuestion && msg.metadata?.questionRequestId) {
    const expired = storage.pendingQuestions.getBySessionIdIncludingExpired(msg.sessionId);
    if (expired && expired.requestId === msg.metadata.questionRequestId) {
      pendingQuestion = expired;
      console.log(`[command-ingest] resurrected expired pending question sessionId=${msg.sessionId} commandId=${commandId} requestId=${pendingQuestion.requestId}`);
    }
  }

  if (pendingQuestion) {
    if (msg.metadata?.questionRequestId && msg.metadata.questionRequestId !== pendingQuestion.requestId) {
      console.warn(`[command-ingest] question answer metadata mismatched sessionId=${msg.sessionId} commandId=${commandId} expected=${pendingQuestion.requestId} got=${msg.metadata.questionRequestId}`);
      await dropCommand(
        storage,
        commandId,
        msg.chatId,
        `This question was superseded by a newer question. Your message was not delivered: "${msg.command.trim()}"`,
        options.sendTelegramReply,
      );
      return;
    }

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
        const updated = storage.pendingQuestions.advanceStep(pendingQuestion, [stepAnswer]);
        if (!updated) {
          console.warn(`[command-ingest] wizard advance failed commandId=${commandId}`);
          storage.inbox.markDone(commandId);
          return;
        }

        // Format next step
        const notificationId = `q:${msg.sessionId}:${pendingQuestion.requestId}`;
        const label = displayName(session);
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

        const edit = await tryEditNotification(
          options.editNotification,
          notificationId,
          message.text,
          replyMarkup,
          message.entities,
        );
        if (edit.attempted && !edit.ok) {
          // Storage is now at step N+1 / version V+1 but the on-screen message
          // still shows step N with buttons carrying version V, so every later
          // press dies on the stale-version guard above. We do NOT roll the
          // advance back: {ok:false} is ambiguous (the edit may have been
          // applied before the reply failed), and rolling back would create the
          // same skew in the opposite direction. Storage stays authoritative;
          // the user gets working instructions for the step it actually wants.
          console.warn(
            `[command-ingest] wizard step edit failed commandId=${commandId} notificationId=${notificationId} version=${updated.version}`,
          );
          await sendBestEffort(
            options.sendTelegramReply,
            msg.chatId,
            staleKeyboardStepMessage(pendingQuestion.questions, updated.currentStep),
            commandId,
          );
        }

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
        await dropUnanswerableQuestion(storage, commandId, msg, pendingQuestion.requestId, options.sendTelegramReply, options.editNotification);
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
        const doneEdit = await tryEditNotification(
          options.editNotification,
          notificationId,
          "All answers submitted ✅",
          { inline_keyboard: [] },
        );
        if (doneEdit.attempted && !doneEdit.ok) {
          // The answers are delivered and the row is gone, so this is not a
          // soft-lock — but the keyboard survives a wizard that no longer
          // exists. A later tap lands on the stale-option guard and vanishes,
          // and if a NEW question arrives first it can even be misrouted, so
          // say plainly that the buttons are dead.
          console.warn(
            `[command-ingest] wizard completion edit failed commandId=${commandId} notificationId=${notificationId}`,
          );
          await sendBestEffort(
            options.sendTelegramReply,
            msg.chatId,
            STALE_KEYBOARD_DONE_MESSAGE,
            commandId,
          );
        }
        return;
      }

      throwIfTransientQuestionReplyFailure(result, commandId);
      console.warn(`[command-ingest] wizard final delivery failed commandId=${commandId} error=${result.error}`);
      // Deliberately keep the pending question row and leave the notification
      // alone. The final step never calls advanceStep, so `version` is unchanged
      // by this failure and the keyboard still on screen remains valid — the
      // user can simply tap again. Deleting the row would throw away the
      // accumulated answers and destroy that retry path.
      await dropCommand(
        storage,
        commandId,
        msg.chatId,
        questionReplyFailedMessage(result.error),
        options.sendTelegramReply,
      );
      return;
    }

    // Single-question path (existing behavior)
    const answers: string[][] = [[stepAnswer]];

    const adapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (!adapter || !adapter.deliverQuestionReply) {
      console.warn(`[command-ingest] session adapter does not support question replies commandId=${commandId}`);
      await dropUnanswerableQuestion(storage, commandId, msg, pendingQuestion.requestId, options.sendTelegramReply, options.editNotification);
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

    throwIfTransientQuestionReplyFailure(result, commandId);
    console.warn(`[command-ingest] question reply failed commandId=${commandId} error=${result.error}`);
    // Row preserved for the same reason as the wizard final step above: the
    // single-question path never mutates it, so the keyboard stays valid.
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      questionReplyFailedMessage(result.error),
      options.sendTelegramReply,
    );
    return;
  }

  // If command looks like a question option but no pending question was resolved, it's stale
  if (QUESTION_OPTION_RE.test(msg.command.trim()) || WIZARD_OPTION_RE.test(msg.command.trim())) {
    console.log(`[command-ingest] stale question option commandId=${commandId} sessionId=${msg.sessionId}`);
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      "This question is no longer answerable (it was already answered, or it is gone).",
      options.sendTelegramReply,
    );
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

      throwIfTransientQuestionReplyFailure(result, commandId);

      // If question reply fails (e.g., 404 question not found), fall through to
      // regular command delivery so the user's text isn't lost.
      console.warn(`[command-ingest] metadata fallback question reply failed commandId=${commandId} error=${result.error}, falling through to regular delivery`);
    } else {
      console.warn(`[command-ingest] metadata fallback: adapter does not support question replies commandId=${commandId}, falling through to regular delivery`);
    }
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
    // Permanent failure: ack and move on. Usually an incomplete registration
    // (backendKind set, endpoint/token missing), which the user cannot see.
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      // Deliberately backend-agnostic: this also fires for nvim-only and
      // backend-less sessions, where "plugin registration" would be wrong.
      `Session is not reachable: no usable delivery backend is registered for it. Restart the session to re-register.`,
      options.sendTelegramReply,
    );
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



/**
 * Classify a failed delivery so we can decide whether retrying *through the
 * plugin* can help, vs. going straight to the revive fallback, vs. giving up.
 *
 * - `ambiguous`: a timeout/abort. The plugin may be alive but busy (event-loop
 *   starved mid-turn); the injection may or may not have landed. Retrying
 *   through the idempotent plugin can still produce a clean 1× delivery, so we
 *   retry within the budget before reviving.
 * - `definitely_not_delivered`: a connection-level failure (refused/DNS/network).
 *   The plugin process is unreachable, so retrying it is pointless — revive now.
 * - `terminal`: anything else (e.g. the plugin actively rejected the command).
 *   Ack and move on; neither retry nor revive would help.
 */
type DeliveryFailureKind = "ambiguous" | "definitely_not_delivered" | "terminal";

function classifyDeliveryFailure(error: string | undefined): DeliveryFailureKind {
  if (!error) return "terminal";
  const lower = error.toLowerCase();
  if (lower.includes("timed out") || lower.includes("abort")) {
    return "ambiguous";
  }
  if (
    lower.includes("unable to connect") ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("network error")
  ) {
    return "definitely_not_delivered";
  }
  return "terminal";
}

/**
 * Abandon a command that cannot be delivered, without losing it silently.
 *
 * Every caller here is a permanent failure: we return normally, so the Poller acks
 * and the worker will never resend. Before that happens the user must be told, and
 * the local inbox row must be closed out. Omitting either is what made these paths
 * invisible (W2 / pigeon-2k1) — the command showed up as `acked` in D1, which is
 * indistinguishable from success.
 *
 * The Telegram send is deliberately best-effort. If it threw, the exception would
 * propagate out of ingestWorkerCommand, the Poller would skip the ack, and a
 * permanently-undeliverable command would retry forever. Notifying is important;
 * it is not important enough to build an infinite loop out of.
 */
/**
 * Perform a notification edit, reporting whether it was attempted and whether
 * it succeeded.
 *
 * Two distinctions the call sites depend on:
 *
 * - `attempted` separates "the edit failed" from "no editNotification was
 *   wired at all". `options.editNotification?.()` yields `undefined` in the
 *   unwired case, so a bare `!result?.ok` check would report a failure for an
 *   edit nobody ever asked for.
 * - Throws are contained. The production wiring (poller.editNotification)
 *   catches internally and returns {ok:false}, but a throw here would escape
 *   ingestWorkerCommand, skip the ack, and trigger a Poller retry that then
 *   dies on the stale-version guard the wizard advance just created. Checking
 *   the ok flag alone is not sufficient if the call can also throw.
 */
async function tryEditNotification(
  editNotification: WorkerCommandIngestOptions["editNotification"],
  notificationId: string,
  text: string,
  replyMarkup: unknown,
  entities?: unknown[],
): Promise<{ attempted: boolean; ok: boolean }> {
  if (!editNotification) return { attempted: false, ok: false };
  try {
    const result = await editNotification(notificationId, text, replyMarkup, entities);
    return { attempted: true, ok: result?.ok === true };
  } catch (err) {
    console.warn(`[command-ingest] editNotification threw notificationId=${notificationId}:`, err);
    return { attempted: true, ok: false };
  }
}

/** Best-effort user notification. Never throws; see dropCommand for the rationale. */
async function sendBestEffort(
  sendTelegramReply: ((chatId: string, text: string) => Promise<void>) | undefined,
  chatId: string,
  text: string,
  commandId: string,
): Promise<void> {
  try {
    await sendTelegramReply?.(chatId, text);
  } catch (err) {
    console.warn(`[command-ingest] failed to notify user commandId=${commandId}:`, err);
  }
}

const STALE_KEYBOARD_DONE_MESSAGE =
  "✅ All answers submitted.\n\n" +
  "⚠️ I couldn't update the question message, so its buttons are still showing. " +
  "Ignore them — they no longer do anything.";

/**
 * Plain-text restatement of the step the wizard is now waiting on, for when the
 * in-place edit failed and the on-screen buttons are dead.
 *
 * Deliberately not formatQuestionWizardStep's text: that copy invites a
 * swipe-reply for a "custom answer" without saying the buttons stopped working,
 * which is the entire point here. Two details that are load-bearing:
 *
 * - It points at the ORIGINAL question message. This reply is sent straight to
 *   the Telegram API, so it has no `messages` row and a swipe-reply to it
 *   resolves no session.
 * - It asks for the option TEXT, not its number. A typed answer is stored
 *   verbatim, so "2" would be recorded as the literal string "2".
 */
function staleKeyboardStepMessage(
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>,
  currentStep: number,
): string {
  const question = questions[currentStep];
  const lines = [
    "⚠️ I couldn't update the question message — its buttons no longer work.",
    "",
    `Question ${currentStep + 1} of ${questions.length}: ${question?.question ?? ""}`,
  ];

  const options = question?.options ?? [];
  if (options.length > 0) {
    lines.push("", "Options:");
    options.forEach((opt, i) => {
      lines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
    });
  }

  lines.push(
    "",
    "To answer: swipe-reply to the original question message above and type your answer as text" +
      (options.length > 0 ? ` (e.g. "${options[0]!.label}")` : "") +
      ". Don't tap the old buttons, and don't reply with just a number.",
  );

  return lines.join("\n");
}

async function dropCommand(
  storage: StorageDb,
  commandId: string,
  chatId: string,
  userMessage: string,
  sendTelegramReply: ((chatId: string, text: string) => Promise<void>) | undefined,
): Promise<void> {
  try {
    await sendTelegramReply?.(chatId, userMessage);
  } catch (err) {
    console.warn(`[command-ingest] failed to notify user about dropped commandId=${commandId}:`, err);
  }
  storage.inbox.markDone(commandId);
}

/**
 * Reply text for a question answer that could not be delivered.
 *
 * The caller keeps the pending question row, so the retry hint is real: the
 * on-screen keyboard is still valid and a second tap re-attempts delivery.
 * Retry-able is not the same as retry-will-succeed — a genuinely gone question
 * fails identically every time — but each attempt now says so, and the row
 * expires on its own TTL rather than lingering forever.
 */
function questionReplyFailedMessage(error: string | undefined): string {
  const reason = error ?? "unknown error";
  return `Couldn't deliver your answer: ${reason}\n\nYour answer wasn't recorded. Tap the option again, or reply with text, to retry.`;
}

/**
 * The session's adapter cannot accept question replies at all, so this pending
 * question is permanently unanswerable from Telegram.
 *
 * Unlike a delivery failure, the row is DELETED here. While it exists, every
 * plain-text message to this session is hijacked into the question-reply path
 * (see the pendingQuestion branch in ingestWorkerCommand), so keeping it would
 * loop this same failure until the TTL expires and block normal command flow
 * entirely. Dropping it lets the user's next message through as a regular
 * prompt.
 *
 * The keyboard is cleared for the same reason the row is deleted, and in
 * deliberate contrast to the delivery-failure sites: once the row is gone those
 * buttons resolve to nothing, and a tap would be swallowed by the stale-option
 * branch. Leaving a live-looking keyboard that silently does nothing would
 * reintroduce the exact defect this change exists to remove.
 */
async function dropUnanswerableQuestion(
  storage: StorageDb,
  commandId: string,
  msg: ExecuteMessage,
  requestId: string,
  sendTelegramReply: ((chatId: string, text: string) => Promise<void>) | undefined,
  editNotification: WorkerCommandIngestOptions["editNotification"],
): Promise<void> {
  storage.pendingQuestions.delete(msg.sessionId);
  // Contained: an unguarded throw here escapes before dropCommand runs, so the
  // row is already deleted, the command is never acked, and the user is never
  // told. The retry then finds no pending question and a typed answer falls
  // through to the execute path, reaching opencode as a stray prompt.
  await tryEditNotification(
    editNotification,
    `q:${msg.sessionId}:${requestId}`,
    "This session can't receive question answers from Telegram.",
    { inline_keyboard: [] },
  );
  await dropCommand(
    storage,
    commandId,
    msg.chatId,
    "This session can't receive question answers from Telegram. Answer it directly in the TUI instead.",
    sendTelegramReply,
  );
}

function isConnectionError(error: string | undefined): boolean {
  // Both ambiguous (timeout) and definitely-not-delivered failures warrant the
  // revive fallback; only terminal failures do not.
  return classifyDeliveryFailure(error) !== "terminal";
}

function throwIfTransientQuestionReplyFailure(result: CommandDeliveryResult, commandId: string): void {
  if (!isConnectionError(result.error)) return;
  const error = result.error ?? "Question reply delivery failed with a connection error";
  console.warn(`[command-ingest] transient question reply failure commandId=${commandId} error=${error}`);
  throw new Error(error);
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
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budgetMs = options.deliveryBudgetMs ?? DEFAULT_DELIVERY_BUDGET_MS;

  const deliver = () =>
    adapter.deliverCommand(session, msg.command, {
      commandId,
      chatId: msg.chatId,
      ...(modelOverride ? { modelOverride } : {}),
      ...(media ? { media } : {}),
    });

  const startedAt = now();
  let result = await deliver();
  let attempts = 1;

  // Retry an *ambiguous* failure (plugin alive but busy) through the idempotent
  // plugin until the budget is exhausted. The plugin dedups on commandId, so a
  // landed-but-slow first attempt collapses to a single injection (1×) instead
  // of falling through to the revive fallback (which bypasses the plugin dedup
  // and would duplicate). definitely_not_delivered / terminal failures skip this
  // loop — retrying a dead/​rejecting plugin can't help.
  while (
    !result.ok &&
    classifyDeliveryFailure(result.error) === "ambiguous" &&
    now() - startedAt < budgetMs
  ) {
    await sleep(Math.min(1_000 * attempts, 5_000));
    if (now() - startedAt >= budgetMs) break;
    result = await deliver();
    attempts++;
  }

  if (result.ok) {
    console.log(`[command-ingest] delivered commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId} attempts=${attempts}`);
    storage.inbox.markDone(commandId);
    return;
  }

  console.warn(`[command-ingest] delivery failed commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId} attempts=${attempts} error=${result.error}`);

  if (isConnectionError(result.error)) {
    // The plugin endpoint did not confirm delivery (connection refused, or a
    // timeout where the plugin was alive but busy). We cannot tell whether the
    // prompt was injected, so to guarantee at-least-once delivery we revive via
    // opencode-serve directly. This may produce a duplicate when the original
    // attempt did land — that is the accepted trade-off until Phase 2 adds an
    // idempotency key. We must never drop the message.
    // See docs/plans/2026-06-03-triple-injection-idempotency-design.md.
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
          // Drop routing state too so prospective /route can't name a serve for a dead session (workstation-boi9).
          storage.assignments.delete(msg.sessionId);
          // Best-effort, but note this is NOT the reaper's kind of best-effort. The reaper
          // can afford a failed unregister because the local row survives to be retried
          // next cycle; here the local row is already gone, so nothing will ever retry
          // this and a failure strands the worker row permanently. The worker-side 14-day
          // TTL sweep is the only thing that would eventually collect it.
          if (options.unregisterSession) {
            try {
              await options.unregisterSession(msg.sessionId);
            } catch (err) {
              console.warn(`[command-ingest] worker unregister failed for ${msg.sessionId} (row now stranded until the worker TTL sweep):`, err);
            }
          }
          await dropCommand(
            storage,
            commandId,
            msg.chatId,
            `Session no longer exists. The opencode session was deleted from this machine.`,
            options.sendTelegramReply,
          );
          return;
        }
        case "serveUnreachable": {
          console.warn(`[command-ingest] opencode-serve unreachable for revival sessionId=${msg.sessionId}: ${revived.error}`);
          await dropCommand(
            storage,
            commandId,
            msg.chatId,
            `opencode-serve is unreachable. Try again in a moment.`,
            options.sendTelegramReply,
          );
          return;
        }
        case "deliveryFailed": {
          console.warn(`[command-ingest] revival delivery failed sessionId=${msg.sessionId}: ${revived.error}`);
          await dropCommand(
            storage,
            commandId,
            msg.chatId,
            `Delivery failed: ${revived.error}`,
            options.sendTelegramReply,
          );
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
    storage.assignments.delete(msg.sessionId);
    // See the note at the sessionGone site: the local row is already deleted, so a failed
    // unregister here is permanent rather than retried.
    if (options.unregisterSession) {
      try {
        await options.unregisterSession(msg.sessionId);
      } catch (err) {
        console.warn(`[command-ingest] worker unregister failed for ${msg.sessionId} (row now stranded until the worker TTL sweep):`, err);
      }
    }
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      `Session is no longer reachable and was removed. Start a new session and try again.`,
      options.sendTelegramReply,
    );
    return;
  }

  // Permanent failure (the plugin actively rejected this command): ack and move on,
  // but surface the reject reason instead of dropping the message into the void.
  await dropCommand(
    storage,
    commandId,
    msg.chatId,
    `Command rejected: ${result.error ?? "unknown reason"}`,
    options.sendTelegramReply,
  );
  return;
}

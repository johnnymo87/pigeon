import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import type { InjectedPromptsRepository } from "../storage/injected-prompts-repo";
import type { CommandDeliveryAdapter, CommandDeliveryContext, CommandDeliveryResult } from "../adapters/types";
import { DirectChannelAdapter } from "../adapters/direct-channel";
import { GoosePullAdapter, bankedReplyMessage, isPullBackend } from "../adapters/goose-pull";
import { NvimRpcAdapter } from "../adapters/nvim-rpc";
import {
  type OpencodeDirectExecuteResult,
} from "../opencode-direct/adapter";
import {
  AckRejectReason,
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

export function formatDeliveryMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.endpoint != null && meta.endpoint !== "") {
    parts.push(`endpoint=${meta.endpoint}`);
  }
  if (meta.status != null) {
    parts.push(`status=${meta.status}`);
  }
  if (meta.rejectReason != null && meta.rejectReason !== "") {
    parts.push(`rejectReason=${meta.rejectReason}`);
  }
  if (meta.tokenFp != null && meta.tokenFp !== "") {
    parts.push(`tokenFp=${meta.tokenFp}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function directSourceForMessage(msg: ExecuteMessage): OpencodeDirectSourceType {
  const command = msg.command.trim();
  if (QUESTION_OPTION_RE.test(command)) {
    return OpencodeDirectSource.TelegramCallback;
  }
  return OpencodeDirectSource.TelegramReply;
}

function selectAdapter(
  session: SessionRecord,
  injectedPrompts?: InjectedPromptsRepository,
  storage?: StorageDb,
): CommandDeliveryAdapter | null {
  // PULL BACKENDS FIRST, and deliberately with no endpoint/token precondition:
  // the whole point of a pull backend is that it has no address to hold. It is
  // checked before the direct-channel branch so a client that somehow carried
  // both cannot be pushed at by accident.
  if (isPullBackend(session) && storage) {
    return new GoosePullAdapter({ storage });
  }

  if (
    session.backendKind === "opencode-plugin-direct"
    && session.backendEndpoint
    && session.backendAuthToken
  ) {
    return new DirectChannelAdapter({ injectedPrompts });
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

  // The row above is hidden once it passes its 4h TTL, but it is not deleted —
  // age-based cleanup deliberately does not exist — so a late answer can still be matched to it.
  // Resurrect it when the worker tells us which question this answer is for and
  // that id matches. Because the table is keyed on session_id with INSERT OR
  // REPLACE, a newer question would have destroyed this row; an expired row
  // with a matching requestId is therefore provably the same question, and its
  // currentStep/answers are real progress. Every way a question legitimately
  // goes away DELETES the row (answered in the TUI, answered here, superseded),
  // so a surviving row means we never saw it answered. If it did die unobserved,
  // opencode rejects the unknown requestId and the user gets a visible failure —
  // opencode, not this TTL, is the correctness boundary.
  //
  // Deliberately does not extend expires_at: a live row hijacks EVERY plain
  // message to the session into the question-reply path below, so re-arming
  // that for ordinary prompts would be a regression.
  let resurrected = false;
  if (!pendingQuestion && msg.metadata?.questionRequestId) {
    const expired = storage.pendingQuestions.getBySessionIdIncludingExpired(msg.sessionId);
    if (expired && expired.requestId === msg.metadata.questionRequestId) {
      pendingQuestion = expired;
      resurrected = true;
      console.log(`[command-ingest] resurrected expired pending question sessionId=${msg.sessionId} commandId=${commandId} requestId=${pendingQuestion.requestId}`);
    }
  }

  if (pendingQuestion) {
    // Identity check for a LIVE row. A resurrected row cannot reach this — it is
    // only adopted above on an exact requestId match — so this fires exactly
    // when the user answered a question that has since been superseded by a
    // newer one occupying the same session_id. Without it the answer would be
    // applied to the current question by option index, answering something the
    // user never read.
    if (msg.metadata?.questionRequestId && msg.metadata.questionRequestId !== pendingQuestion.requestId) {
      console.warn(`[command-ingest] question answer metadata mismatched sessionId=${msg.sessionId} commandId=${commandId} expected=${pendingQuestion.requestId} got=${msg.metadata.questionRequestId}`);
      await dropCommand(
        storage,
        commandId,
        msg.chatId,
        supersededQuestionMessage(msg.command.trim()),
        options.sendTelegramReply,
      );
      return;
    }

    console.log(`[command-ingest] routing as question reply sessionId=${msg.sessionId} commandId=${commandId} requestId=${pendingQuestion.requestId}`);
    if (await refuseUnanswerableQuestionInput(storage, commandId, msg, options, "pending")) return;
    const command = msg.command.trim();
    const wizardMatch = WIZARD_OPTION_RE.exec(command);
    const legacyMatch = !wizardMatch ? QUESTION_OPTION_RE.exec(command) : null;
    const isWizard = pendingQuestion.questions.length > 1;

    // An option token whose SHAPE disagrees with the pending question's arity
    // provably came from a different render than the row now pending, so it must
    // not be resolved by positional index below. The two renderers are a
    // bijection: `formatQuestionNotification` emits legacy `q{i}` and is guarded
    // on `questions.length === 1` (notification-service.ts:178-187), and
    // `formatQuestionWizardStep` is the only producer of `v{version}:q{i}`
    // (:241-250). Arity is immutable for the life of a row — `store()` is the
    // only writer of `questions_json` and `advanceStep` never touches it — so
    // this cannot fire on a question legitimately changing shape underneath the
    // user.
    //
    // The bijection proves staleness only for RENDERED payloads. Typed text can
    // forge either shape, and there a mismatch proves only "inconsistent with
    // the row that is open now" — which deserves refusing just the same, so the
    // conclusion is unchanged. Note such text was never answerable as prose: it
    // previously resolved as an option index.
    //
    // This is NOT the version guard below, and widening that guard to cover this
    // case does not work: every row is stored with version 0 (repos.ts:385) and
    // a wizard's first step renders v0 (app.ts:816), so a stale `v0:qN` landing
    // on a fresh single question compares 0 !== 0 = false and slips through. The
    // symmetric legacy-against-wizard case carries no version at all, so no
    // version-based check could ever defend it.
    //
    // Defense-in-depth *behind* the requestId identity check above, which is the
    // real fix and which runs first. This earns its keep only where identity is
    // absent, which is never a genuine button press on current code: a typed
    // `/cmd TOKEN v0:q0`, a topic-routed message matching the shape
    // (`resolveMessageSession` Try 2 sets no questionRequestId), and a swipe-reply
    // to a NON-question notification of the same session (Try 1 resolves the
    // session but a non-`q:` notification_id yields no requestId).
    //
    // Deliberately NOT symmetric with the version guard below, which stays a
    // silent markDone: its usual trigger is a benign double-tap during the
    // in-place card edit, where a loud reply would be noise. That asymmetry is a
    // considered UX call, not an oversight — see pigeon-k4c.6.
    if ((wizardMatch && !isWizard) || (legacyMatch && isWizard)) {
      console.warn(`[command-ingest] option token shape does not match pending question arity sessionId=${msg.sessionId} commandId=${commandId} command=${command} questions=${pendingQuestion.questions.length}`);
      await dropCommand(
        storage,
        commandId,
        msg.chatId,
        mismatchedOptionTokenMessage(),
        options.sendTelegramReply,
      );
      return;
    }

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
        await warnMediaNotDelivered(msg, commandId, options);
        return;
      }

      // Final step: collect all answers and deliver to opencode
      const allAnswers = [...pendingQuestion.answers, [stepAnswer]];

      const adapter = options.createAdapter
        ? options.createAdapter(session)
        : selectAdapter(session, storage.injectedPrompts, storage);

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
        storage.pendingQuestions.delete(msg.sessionId, pendingQuestion.requestId);

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
        await notifyIfBanked(result, session, msg, commandId, options);
        await warnMediaNotDelivered(msg, commandId, options);
        return;
      }

      throwIfTransientQuestionReplyFailure(result, commandId);
      console.warn(`[command-ingest] wizard final delivery failed commandId=${commandId} error=${result.error}${formatDeliveryMeta(result.meta)}`);
      if (await dropResurrectedQuestionThatIsGone(resurrected, storage, commandId, msg, pendingQuestion.requestId, result, options)) {
        return;
      }
      if (await dropUnreachableQuestionRegistration(storage, commandId, msg, pendingQuestion.requestId, result, options)) {
        return;
      }
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
      : selectAdapter(session, storage.injectedPrompts, storage);

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
      storage.pendingQuestions.delete(msg.sessionId, pendingQuestion.requestId);
      await notifyIfBanked(result, session, msg, commandId, options);
      await warnMediaNotDelivered(msg, commandId, options);
      return;
    }

    throwIfTransientQuestionReplyFailure(result, commandId);
    console.warn(`[command-ingest] question reply failed commandId=${commandId} error=${result.error}${formatDeliveryMeta(result.meta)}`);
    if (await dropResurrectedQuestionThatIsGone(resurrected, storage, commandId, msg, pendingQuestion.requestId, result, options)) {
      return;
    }
    if (await dropUnreachableQuestionRegistration(storage, commandId, msg, pendingQuestion.requestId, result, options)) {
      return;
    }
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

  // No pending question was resolved and the command is a raw option token, so
  // there is nothing left to map it against. Drop it, and tell the user —
  // silence here is the original defect: a press landing after the row expired
  // was acked and discarded while Telegram had already toasted "Command sent".
  //
  // MUST STAY AHEAD OF THE METADATA FALLBACK BELOW. Reordering these silently
  // reintroduces a transcript-corruption bug: the single-question success path
  // deletes the row but leaves the keyboard on screen, so a second press is
  // routine. It carries metadata and finds no row, so the fallback would send
  // the literal "q0" as the answer text, opencode would reject it, and the
  // fallback's deliberate fall-through would then inject "q0" into the session
  // as a user prompt. An option token is never a prompt and never an answer
  // payload — it is meaningless without a row to resolve it against.
  if (isOptionToken(msg.command.trim())) {
    console.log(`[command-ingest] stale question option commandId=${commandId} sessionId=${msg.sessionId}`);
    await dropCommand(
      storage,
      commandId,
      msg.chatId,
      "That question is no longer answerable — it was already answered, or the session has moved on.",
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

    // Same hygiene as the primary question path above. This branch has its own
    // copy of the empty-answer bug (`[[msg.command.trim()]]` below), so guarding
    // only the primary path would leave the stale-state rescue route submitting
    // '' as an answer.
    if (await refuseUnanswerableQuestionInput(storage, commandId, msg, options, "fallback")) return;

    const fallbackAdapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session, storage.injectedPrompts, storage);

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
        // Clean up matching pending question; keyed delete ensures an unrelated live question survives
        storage.pendingQuestions.delete(msg.sessionId, msg.metadata.questionRequestId);
        await notifyIfBanked(result, session, msg, commandId, options);
        await warnMediaNotDelivered(msg, commandId, options);
        return;
      }

      throwIfTransientQuestionReplyFailure(result, commandId);

      // If question reply fails (e.g., 404 question not found or connection refused),
      // fall through to regular command delivery so the user's text isn't lost.
      // Fall-through on refused is intentional: raw option tokens have already been
      // filtered out above, so msg.command is genuinely typed prose that should reach
      // the session as a prompt.
      console.warn(`[command-ingest] metadata fallback question reply failed commandId=${commandId} error=${result.error}, falling through to regular delivery${formatDeliveryMeta(result.meta)}`);
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
    : selectAdapter(session, storage.injectedPrompts, storage);

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

  // A file with no caption would otherwise be delivered as `command: ''` and
  // rejected wholesale by the plugin's validator, discarding the bytes we just
  // relayed. Gated on media presence: a media-less empty command must stay empty
  // and fail downstream, never be papered over with a synthetic prompt.
  const effectiveMsg: ExecuteMessage = !msg.command.trim() && msg.media
    ? { ...msg, command: mediaPlaceholderCommand(msg.media) }
    : msg;

  return deliverViaAdapter(adapter, session, effectiveMsg, commandId, storage, options, mediaPayload);
}



// Disambiguation: This function classifies command delivery failures for inbound worker commands, unrelated to classifyDeliveryFailure in worker/delivery-policy.ts which classifies outbound notification delivery failures.
/**
 * Classify a failed delivery so we can decide whether retrying *through the
 * plugin* can help, vs. going straight to the revive fallback, vs. giving up.
 *
 * NOTE: The `meta.rejectReason` rule is strictly for execute-path commands.
 * On the question-reply path, `meta.rejectReason` carries `ResultErrorCode`
 * (type-punned with `AckRejectReason`), and question replies cannot be revived.
 * Callers on the question-reply path (specifically `throwIfTransientQuestionReplyFailure`)
 * must pass `{ error: result.error }` without `meta`.
 *
 * - `ambiguous`: a timeout/abort. The plugin may be alive but busy (event-loop
 *   starved mid-turn); the injection may or may not have landed. Retrying
 *   through the idempotent plugin can still produce a clean 1× delivery, so we
 *   retry within the budget before reviving.
 * - `definitely_not_delivered`: a connection-level failure (refused/DNS/network),
 *   or an UNAUTHORIZED rejection from direct-channel token check.
 *   The plugin process is unreachable or rejected before reading the body (the token
 *   check runs before route dispatch and before body read, provably guaranteeing zero
 *   injection occurred for that individual request), so retrying it is pointless — revive now.
 *   (At command scope, duplicate injection remains possible if an earlier attempt timed
 *   out ambiguously before the plugin restarted with a new token — the same accepted at-least-once
 *   tradeoff documented at lines 1084-1090.)
 * - `terminal`: anything else (e.g. the plugin actively rejected the command mid-turn
 *   or with deterministic validation errors like BUSY/UNAVAILABLE/UNSUPPORTED_VERSION/INVALID_PAYLOAD).
 *   Ack and move on; neither retry nor revive would help.
 */
type DeliveryFailureKind = "ambiguous" | "definitely_not_delivered" | "terminal";

function classifyDeliveryFailure(
  result: Pick<CommandDeliveryResult, "error" | "meta">,
): DeliveryFailureKind {
  const error = result.error;
  if (error) {
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
  }
  if (result.meta?.rejectReason === AckRejectReason.Unauthorized) {
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
/**
 * Tell the human their message was BANKED, not delivered.
 *
 * Gated on the adapter's own `meta.banked` rather than on the session's backend
 * kind, so the notice can only appear for a delivery that really was a bank --
 * one fact, asserted by the code that performed it.
 *
 * WHY IT EXISTS. On success this path sends nothing, because Telegram has
 * already toasted "Command sent" and a second confirmation would be noise. For a
 * pull backend that toast is false by as much as ~68 hours (the motivating
 * client runs Mon-Fri plus capped follow-ups, so the worst gap is Friday evening
 * to Monday). Silence here would leave the human believing an unattended agent
 * had just been told something it will not read until next week.
 *
 * Best-effort by construction: the message IS banked either way, and failing the
 * command because a courtesy notice failed would trade a real delivery for a
 * cosmetic one.
 */
async function notifyIfBanked(
  result: CommandDeliveryResult,
  session: SessionRecord,
  msg: ExecuteMessage,
  commandId: string,
  options: WorkerCommandIngestOptions,
): Promise<void> {
  if (!result.ok || result.meta?.banked !== true) return;
  await sendBestEffort(
    options.sendTelegramReply,
    msg.chatId,
    bankedReplyMessage(session),
    commandId,
  );
}

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
 * Input hygiene for both question-reply paths (W4 / `pigeon-bru`).
 *
 * Returns `true` when the caller must stop because this message cannot become
 * an answer. Two cases, deliberately handled differently because the inputs
 * genuinely differ:
 *
 * - **Nothing answer-shaped at all** (empty text, or a file with no caption):
 *   refuse outright. The `pendingQuestions` row is kept, so the on-screen
 *   keyboard stays valid and the user can still answer. Previously the empty
 *   string was accepted as the answer and the wizard advanced on garbage —
 *   a failure that *succeeded*, which is worse than one that errors.
 *
 * A caption plus a file is NOT refused: the caption is a real answer, so it is
 * delivered, and `warnMediaNotDelivered` reports the dropped file *after* the
 * answer lands. See that function for why the timing matters.
 *
 * Why the daemon and not the worker: only the daemon knows a question is
 * pending. `resolveMessageSession` sets `questionRequestId` solely for
 * swipe-replies to a `q:`-prefixed notification, so topic-routed messages carry
 * no question context at all — yet `getBySessionId` hijacks them into this path
 * regardless. A worker-side guard would be a sieve.
 *
 * `origin` only affects wording. On the metadata-fallback branch there is by
 * definition no local pending row — that is why that branch exists — so telling
 * the user the question is "still waiting" there would assert something the
 * daemon does not know.
 */
async function refuseUnanswerableQuestionInput(
  storage: StorageDb,
  commandId: string,
  msg: ExecuteMessage,
  options: WorkerCommandIngestOptions,
  origin: "pending" | "fallback",
): Promise<boolean> {
  if (msg.command.trim().length > 0) return false;

  console.warn(`[command-ingest] refusing unanswerable question input commandId=${commandId} media=${Boolean(msg.media)} origin=${origin}`);

  const cause = msg.media
    ? `Can't answer a question with a file — only text answers can be delivered.`
    : `Can't answer a question with an empty message.`;
  const next = origin === "pending"
    ? `The question is still waiting: tap an option, or reply with text.`
    : `If that question is still open, tap an option on it, or reply with text.`;
  const trailer = msg.media ? ` Then send the file again.` : ``;

  await dropCommand(storage, commandId, msg.chatId, `${cause}\n\n${next}${trailer}`, options.sendTelegramReply);
  return true;
}

/**
 * Report a file that rode along with a question answer and went nowhere.
 *
 * `QuestionReplyEnvelope` carries only `answers: string[][]`, and opencode's own
 * `/question/:id/reply` endpoint has no file channel, so the attachment is
 * unavoidably dropped. Silence about that is the defect class this epic exists
 * to kill.
 *
 * Called only once the answer has actually been accepted, which is load-bearing
 * in two ways. A transient failure throws so the Poller retries the whole
 * command, and anything sent before that point is re-sent once per lease cycle
 * for as long as the failure lasts. And on the metadata-fallback branch a
 * terminal failure falls through to regular delivery, which *does* carry the
 * file — so warning early would have been an outright lie.
 */
async function warnMediaNotDelivered(
  msg: ExecuteMessage,
  commandId: string,
  options: WorkerCommandIngestOptions,
): Promise<void> {
  if (!msg.media) return;
  await sendBestEffort(
    options.sendTelegramReply,
    msg.chatId,
    `Your answer was delivered, but the attached file was not — a question answer can only carry text.\n\nSend the file again now that the question is answered.`,
    commandId,
  );
}

/**
 * Stand-in prompt for a file sent with no caption (W3 / `pigeon-tyk`).
 *
 * Without this the envelope carries `command: ''`, which
 * `isExecuteCommandEnvelope` rejects — so the bytes are fetched from R2,
 * relayed, and then thrown away by the plugin's own validator.
 *
 * Synthesized in the daemon rather than the worker on purpose. Worker-side
 * synthesis would flow into the question path above and become a question's
 * *answer*, manufacturing a fresh instance of the very bug W4 fixes. Doing it
 * here, after both question branches have returned, structurally cannot.
 *
 * Wording is deliberately a flat statement of fact. An agent reads this
 * verbatim as the user's prompt, so it must not invent an instruction ("analyze
 * this") the user never gave.
 */
function mediaPlaceholderCommand(media: NonNullable<ExecuteMessage["media"]>): string {
  return `[User sent a file with no caption: ${media.filename} (${media.mime})]`;
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
/**
 * A resurrected question that opencode refused (the question is gone) or whose
 * registration is still unreachable (tap 2 retry failure) bounds the retry loop.
 *
 * Handled apart from the live-row failure paths, which keep the row on purpose
 * so the on-screen keyboard stays valid for a retry. That reasoning inverts
 * here: the retry cannot ever succeed, and because resurrection ignores
 * `expires_at`, keeping the row would re-resurrect on every attempt and trap
 * every future swipe-reply to this card in the same wall forever. Deleting it
 * restores the pre-resurrection escape hatch — the next message to the session
 * is treated as an ordinary prompt and reaches opencode.
 *
 * Branching the reply wording: if the failure is unreachable registration (dead
 * port or 401), assert nothing about the question state in opencode; otherwise
 * (genuine refusal), state that the question is no longer open.
 *
 * Returns true when it handled the command.
 */
async function dropResurrectedQuestionThatIsGone(
  resurrected: boolean,
  storage: StorageDb,
  commandId: string,
  msg: ExecuteMessage,
  requestId: string,
  result: CommandDeliveryResult,
  options: WorkerCommandIngestOptions,
): Promise<boolean> {
  if (!resurrected) return false;
  storage.pendingQuestions.delete(msg.sessionId, requestId);
  const isUnreachable = isUnreachableRegistrationFailure(result);
  console.warn(
    `[command-ingest] resurrected question is gone (${isUnreachable ? "unreachable" : "refused"}), dropping row sessionId=${msg.sessionId} commandId=${commandId}`,
  );
  const message = isUnreachable
    ? "Still couldn't reach the session that asked this question. Your answer wasn't delivered — send it as a normal message if you still want it to reach the session."
    : "That question is no longer open in the session, so your answer wasn't recorded. Tapping again won't help — send it as a normal message if you still want it to reach the session.";
  await dropCommand(
    storage,
    commandId,
    msg.chatId,
    message,
    options.sendTelegramReply,
  );
  return true;
}

/**
 * Reply text for an answer to a question that a newer one has replaced.
 *
 * A button press arrives as an internal wire token (`q0`, `v0:q1`), so echoing
 * the raw command back would show the user a string they never typed. Only
 * genuinely typed text is quoted — that is the part worth returning, since the
 * user would otherwise have to retype it.
 */
function supersededQuestionMessage(command: string): string {
  const tail = isOptionToken(command)
    ? ""
    : `\n\nYour reply wasn't applied: "${command}"`;
  return `That question was replaced by a newer one, so your answer wasn't recorded. Answer the latest question above.${tail}`;
}

/**
 * Refusal for an option token whose shape contradicts the pending question's
 * arity.
 *
 * Deliberately not `supersededQuestionMessage`'s wording. "Replaced by a newer
 * one" is true for the requestId mismatch that helper serves, but not for every
 * case that reaches here: text typed to match the token grammar can arrive for
 * the question that is genuinely open, where nothing was replaced. This says
 * only what is true in all of them — the option does not belong to the question
 * currently open. The raw token is not echoed, for the same reason it is not
 * echoed there: it is machine text the user never typed as prose.
 */
function mismatchedOptionTokenMessage(): string {
  return "That option doesn't belong to the question that's open now, so it wasn't recorded. Use the buttons on the latest question above.";
}

function isOptionToken(command: string): boolean {
  return QUESTION_OPTION_RE.test(command) || WIZARD_OPTION_RE.test(command);
}

function questionReplyFailedMessage(error: string | undefined): string {
  const reason = error ?? "unknown error";
  return `Couldn't deliver your answer: ${reason}\n\nYour answer wasn't recorded. Tap the option again, or reply with text, to retry.`;
}

function unreachableQuestionRegistrationMessage(): string {
  return "Couldn't reach the session that asked this question — it looks like it restarted.\n\nYour answer may not have been recorded. Tap the option again to retry once; if that fails, send it as a normal message.";
}

function isUnreachableRegistrationFailure(result: Pick<CommandDeliveryResult, "error" | "meta">): boolean {
  return (
    result.meta?.status === 401
    || classifyDeliveryFailure({ error: result.error }) === "definitely_not_delivered"
  );
}

/**
 * Handle a question-reply delivery failure where the session's direct-channel
 * registration is unreachable (dead port or recycled port returning 401).
 *
 * This registration can never deliver this answer, and no retry through it will
 * heal it. Expire the row so it stops hijacking ordinary prompts into the
 * question-reply path, while leaving it visible to
 * `getBySessionIdIncludingExpired` so the resurrection path can still find it on
 * a re-tap.
 *
 * Key on `meta.status === 401` exactly. Do not broaden to any non-envelope response
 * (e.g. 501 from a version-skewed plugin where the session is live and the question
 * is still answerable in the TUI).
 *
 * Do not edit/strip the notification keyboard — the re-tap is the retry path.
 *
 * Returns true when handled.
 */
async function dropUnreachableQuestionRegistration(
  storage: StorageDb,
  commandId: string,
  msg: ExecuteMessage,
  requestId: string,
  result: CommandDeliveryResult,
  options: WorkerCommandIngestOptions,
): Promise<boolean> {
  if (!isUnreachableRegistrationFailure(result)) {
    return false;
  }

  const is401 = result.meta?.status === 401;
  const now = options.now ? options.now() : Date.now();
  storage.pendingQuestions.expire(msg.sessionId, requestId, now);
  const flavour = is401 ? "recycled-port (401)" : "dead-port";
  console.warn(
    `[command-ingest] question registration unreachable (${flavour}) sessionId=${msg.sessionId} commandId=${commandId} error=${result.error}${formatDeliveryMeta(result.meta)}`,
  );
  await dropCommand(
    storage,
    commandId,
    msg.chatId,
    unreachableQuestionRegistrationMessage(),
    options.sendTelegramReply,
  );
  return true;
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
  storage.pendingQuestions.delete(msg.sessionId, requestId);
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

function isConnectionError(result: Pick<CommandDeliveryResult, "error" | "meta">): boolean {
  // Both ambiguous (timeout) and definitely-not-delivered failures warrant the
  // revive fallback; only terminal failures do not.
  return classifyDeliveryFailure(result) !== "terminal";
}

function throwIfTransientQuestionReplyFailure(result: CommandDeliveryResult, commandId: string): void {
  // Deliberately classify from `{ error: result.error }` only, omitting `meta`.
  // `meta.rejectReason` is type-punned across channels: it carries AckRejectReason
  // on execute but ResultErrorCode on question-reply (both use "UNAUTHORIZED").
  // A question-reply 401/unauthorized rejection is permanent (and question replies
  // cannot be revived anyway since opencode-serve revive only supports sendPrompt).
  // Passing meta here would classify UNAUTHORIZED as definitely_not_delivered and
  // throw, arming an infinite poller retry loop.
  //
  // Pigeon-m426.4: Throw ONLY for "ambiguous" (timeout/abort). "definitely_not_delivered"
  // (dead port / connection refused) stops throwing, allowing bounded drop and row expiry.
  // Note: A recycled port held by a listener that accepts but never completes HTTP yields
  // "abort" -> ambiguous -> throws -> unbounded 60s re-lease loop by design until inbox
  // attempt counting is added.
  if (classifyDeliveryFailure({ error: result.error }) !== "ambiguous") return;
  const error = result.error ?? "Question reply delivery failed with a connection error";
  console.warn(`[command-ingest] transient question reply failure commandId=${commandId} error=${error}${formatDeliveryMeta(result.meta)}`);
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
    classifyDeliveryFailure(result) === "ambiguous" &&
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
    await notifyIfBanked(result, session, msg, commandId, options);
    return;
  }

  console.warn(`[command-ingest] delivery failed commandId=${commandId} adapter=${adapter.name} sessionId=${msg.sessionId} attempts=${attempts} error=${result.error}${formatDeliveryMeta(result.meta)}`);

  if (isConnectionError(result)) {
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
        // The revive fallback talks to opencode-serve directly and has no file
        // channel, so any attachment is lost here. Saying so inline matters more
        // since W3: without it a caption-less photo arrives as the bare
        // placeholder text, describing a file the session never received.
        msg.media
          ? `${msg.command}\n\n(A file was attached but could not be delivered. Please send it again.)`
          : msg.command,
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

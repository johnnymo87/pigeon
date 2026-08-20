import { createHash } from "node:crypto";
import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryContext, CommandDeliveryResult, QuestionReplyInput } from "./types";
import {
  executeViaOpencodeDirectChannel,
  replyQuestionViaOpencodeDirectChannel,
  type OpencodeDirectAdapterDeps,
} from "../opencode-direct/adapter";
import { OpencodeDirectSource } from "../opencode-direct/contracts";

export interface DirectChannelAdapterDeps extends OpencodeDirectAdapterDeps {}

function tokenFingerprint(token?: string | null): string | undefined {
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export class DirectChannelAdapter implements CommandDeliveryAdapter {
  readonly name = "direct-channel";

  constructor(private readonly deps: DirectChannelAdapterDeps = {}) {}

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    const endpoint = session.backendEndpoint;
    const authToken = session.backendAuthToken;

    if (!endpoint || !authToken) {
      const tokenFp = tokenFingerprint(authToken);
      return {
        ok: false,
        error: "Session missing backendEndpoint or backendAuthToken",
        meta: {
          ...(endpoint ? { endpoint } : {}),
          ...(tokenFp ? { tokenFp } : {}),
        },
      };
    }

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: context.commandId,
        commandId: context.commandId,
        sessionId: session.sessionId,
        command,
        endpoint,
        authToken,
        source: OpencodeDirectSource.TelegramReply,
        // Single attempt here: retrying the (non-idempotent) execute path is the
        // job of command-ingest's deadline-aware, classification-aware budget
        // loop, which retries *ambiguous* timeouts through the now-idempotent
        // plugin and reserves the revive fallback for last resort. Keeping the
        // retry in exactly one layer avoids double-retry blowing past the 60s
        // worker lease. See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2b).
        maxRetries: 0,
        ...(context.chatId !== undefined
          ? { chatId: String(context.chatId) }
          : {}),
        ...(context.modelOverride ? { modelOverride: context.modelOverride } : {}),
        ...(context.media ? { media: context.media } : {}),
      },
      this.deps,
    );

    if (result.ok) {
      return {
        ok: true,
        meta: {
          attempts: result.attempts,
          status: result.status,
        },
      };
    }

    const error =
      result.result?.errorMessage
      || result.error
      || result.ack?.message
      || result.ack?.rejectReason
      || "OpenCode direct-channel execution failed";

    const tokenFp = tokenFingerprint(authToken);
    // meta.rejectReason carries AckRejectReason on the execute path (e.g. UNAUTHORIZED, BUSY)
    const rejectReason = result.ack?.rejectReason;

    return {
      ok: false,
      error,
      meta: {
        endpoint,
        status: result.status,
        attempts: result.attempts,
        ...(rejectReason ? { rejectReason } : {}),
        ...(tokenFp ? { tokenFp } : {}),
      },
    };
  }

  async deliverQuestionReply(
    session: SessionRecord,
    reply: QuestionReplyInput,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    const endpoint = session.backendEndpoint;
    const authToken = session.backendAuthToken;

    if (!endpoint || !authToken) {
      const tokenFp = tokenFingerprint(authToken);
      return {
        ok: false,
        error: "Session missing backendEndpoint or backendAuthToken",
        meta: {
          ...(endpoint ? { endpoint } : {}),
          ...(tokenFp ? { tokenFp } : {}),
        },
      };
    }

    const result = await replyQuestionViaOpencodeDirectChannel(
      {
        requestId: context.commandId,
        sessionId: session.sessionId,
        questionRequestId: reply.questionRequestId,
        answers: reply.answers,
        endpoint,
        authToken,
        ...(context.chatId !== undefined ? { chatId: String(context.chatId) } : {}),
      },
      this.deps,
    );

    if (result.ok) {
      return { ok: true, meta: { status: result.status } };
    }

    const tokenFp = tokenFingerprint(authToken);
    // meta.rejectReason carries ResultErrorCode on the question-reply path (e.g. INVALID_SESSION, UNAUTHORIZED)
    const rejectReason = result.result?.errorCode;

    return {
      ok: false,
      error: result.error || "Question reply delivery failed",
      meta: {
        endpoint,
        status: result.status,
        ...(rejectReason ? { rejectReason } : {}),
        ...(tokenFp ? { tokenFp } : {}),
      },
    };
  }
}

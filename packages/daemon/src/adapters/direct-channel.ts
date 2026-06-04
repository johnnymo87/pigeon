import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryContext, CommandDeliveryResult, QuestionReplyInput } from "./types";
import {
  executeViaOpencodeDirectChannel,
  replyQuestionViaOpencodeDirectChannel,
  type OpencodeDirectAdapterDeps,
} from "../opencode-direct/adapter";
import { OpencodeDirectSource } from "../opencode-direct/contracts";

export interface DirectChannelAdapterDeps extends OpencodeDirectAdapterDeps {}

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
      return {
        ok: false,
        error: "Session missing backendEndpoint or backendAuthToken",
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

    return {
      ok: false,
      error,
      meta: {
        attempts: result.attempts,
        status: result.status,
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
      return {
        ok: false,
        error: "Session missing backendEndpoint or backendAuthToken",
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

    return {
      ok: false,
      error: result.error || "Question reply delivery failed",
      meta: { status: result.status },
    };
  }
}

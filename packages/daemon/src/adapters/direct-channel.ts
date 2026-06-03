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
        // Phase 2: the plugin execute sink is now idempotent on commandId, so a
        // retry after an ambiguous timeout/5xx is safe — the retry carries the
        // same commandId and the plugin dedups it (no re-injection). We keep N
        // small (1 retry, ≤2×15s) so a single command never blocks the
        // sequential poller past the worker's 60s lease. A landed-but-slow first
        // attempt collapses to a single injection; only a turn that stays busy
        // across both attempts falls through to command-ingest's last-resort
        // revive (a possible duplicate, never a drop — at-least-once preserved).
        // See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2b).
        maxRetries: 1,
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

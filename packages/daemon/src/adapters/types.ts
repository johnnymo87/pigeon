import type { SessionRecord } from "../storage/types";

export interface CommandDeliveryResult {
  ok: boolean;
  error?: string;
  /** Adapter-specific metadata */
  meta?: Record<string, unknown>;
}

export interface QuestionReplyInput {
  questionRequestId: string;
  answers: string[][];
}

export interface CommandDeliveryContext {
  commandId: string;
  chatId?: string | number;
  modelOverride?: string;
  media?: {
    mime: string;
    filename: string;
    /** data URI (data:<mime>;base64,...) after daemon fetches from R2 */
    url: string;
  };
}

export interface CommandDeliveryAdapter {
  /** Human-readable adapter name for logging */
  readonly name: string;

  /**
   * How `deliverViaAdapter` should treat a failure from this adapter.
   *
   * Undefined (the default, and what all three opencode-era adapters use) keeps
   * the historical behaviour: the error STRING is classified, and anything
   * connection-shaped ("fetch failed", "econnrefused", "network error") is taken
   * as proof the opencode plugin is gone, which triggers revive and — whether or
   * not an opencodeClient is available — ultimately DELETES the session row, the
   * assignment, and the Telegram topic registration.
   *
   * `"surface"` says: this adapter's errors mean nothing to that machinery, so do
   * not classify them and do not touch the session. Report the failure to the
   * human and close the command out.
   *
   * An adapter that opts in owns its own retry policy, and the rule is NOT
   * "throw for anything transient". Redelivery re-runs `deliverCommand` from the
   * top, so the only safe throws are failures that are provably BEFORE the
   * command reached the backend:
   *
   *   throw            connect refused, handshake failed, session creation failed
   *                    — nothing was sent, so redelivery cannot duplicate. The
   *                    poller deliberately skips the ack on a throw, the 60s
   *                    worker lease lapses, and the command comes back.
   *   return ok:false  anything at or after the point the command was sent, and
   *                    every permanent failure. A disconnect mid-turn is NOT a
   *                    safe throw: the backend may still be running the turn, so
   *                    redelivery would issue a SECOND command into it.
   *   return ok:false  authentication and configuration failures especially —
   *                    a 401 is not transient, and throwing on one produces an
   *                    unbounded 60s retry loop that nothing caps until the
   *                    command expires a day later. If the transport cannot tell
   *                    401 from connection-refused (they can look identical), the
   *                    adapter must establish which it is before deciding.
   *
   * Bound every await inside `deliverCommand`. The poller dispatches serially, so
   * one unbounded await freezes command delivery for EVERY session on the
   * machine, including another session's `/interrupt`.
   *
   * This only governs `deliverViaAdapter`, i.e. the execute path. The
   * question-reply path still string-classifies and throws independently of this
   * field, so a `"surface"` adapter must not implement `deliverQuestionReply`
   * until that path is gated too.
   *
   * This exists because a second backend's transient socket error is
   * indistinguishable, at the string level, from an opencode plugin that has
   * genuinely died — and guessing wrong destroys the human's session mapping.
   */
  readonly failurePolicy?: "surface";

  /** Deliver a command to the session, return success/failure */
  deliverCommand(
    session: SessionRecord,
    command: string,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult>;

  /** Deliver a question reply to the session, return success/failure */
  deliverQuestionReply?(
    session: SessionRecord,
    reply: QuestionReplyInput,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult>;
}

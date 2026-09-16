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
   * human and close the command out. An adapter that opts in owns its own retry
   * policy — it should THROW for a transient error it wants redelivered (the
   * poller deliberately skips the ack on a throw, so the worker lease lapses and
   * the command comes back) and return `{ ok: false }` for a permanent one.
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

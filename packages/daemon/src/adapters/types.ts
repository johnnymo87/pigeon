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

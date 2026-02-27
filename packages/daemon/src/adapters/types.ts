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

export interface CommandDeliveryAdapter {
  /** Human-readable adapter name for logging */
  readonly name: string;

  /** Deliver a command to the session, return success/failure */
  deliverCommand(
    session: SessionRecord,
    command: string,
    context: { commandId: string; chatId?: string | number },
  ): Promise<CommandDeliveryResult>;

  /** Deliver a question reply to the session, return success/failure */
  deliverQuestionReply?(
    session: SessionRecord,
    reply: QuestionReplyInput,
    context: { commandId: string; chatId?: string | number },
  ): Promise<CommandDeliveryResult>;
}

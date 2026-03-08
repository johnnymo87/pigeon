export const OPENCODE_DIRECT_PROTOCOL_VERSION = 1 as const;

export const OpencodeDirectMessageType = {
  Execute: "pigeon.command.execute",
  Ack: "pigeon.command.ack",
  Result: "pigeon.command.result",
  QuestionReply: "pigeon.question.reply",
  QuestionReplyResult: "pigeon.question.reply.result",
} as const;

export const OpencodeDirectSource = {
  TelegramReply: "telegram-reply",
  TelegramCallback: "telegram-callback",
  Manual: "manual",
} as const;

export const AckRejectReason = {
  InvalidSession: "INVALID_SESSION",
  Unauthorized: "UNAUTHORIZED",
  Busy: "BUSY",
  Unavailable: "UNAVAILABLE",
  UnsupportedVersion: "UNSUPPORTED_VERSION",
  InvalidPayload: "INVALID_PAYLOAD",
} as const;

export const ResultErrorCode = {
  Timeout: "TIMEOUT",
  ExecutionError: "EXECUTION_ERROR",
  Cancelled: "CANCELLED",
  InvalidSession: "INVALID_SESSION",
  Unauthorized: "UNAUTHORIZED",
  Internal: "INTERNAL",
} as const;

export type OpencodeDirectSource =
  (typeof OpencodeDirectSource)[keyof typeof OpencodeDirectSource];

export type AckRejectReason =
  (typeof AckRejectReason)[keyof typeof AckRejectReason];

export type ResultErrorCode =
  (typeof ResultErrorCode)[keyof typeof ResultErrorCode];

export interface ExecuteCommandEnvelope {
  type: typeof OpencodeDirectMessageType.Execute;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  sessionId: string;
  command: string;
  source: OpencodeDirectSource;
  issuedAt: number;
  deadlineMs?: number;
  metadata?: {
    chatId?: string;
    replyToMessageId?: string;
    replyToken?: string;
  };
  media?: {
    mime: string;
    filename: string;
    url: string;
  };
}

export interface CommandAckEnvelope {
  type: typeof OpencodeDirectMessageType.Ack;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  sessionId: string;
  accepted: boolean;
  acceptedAt: number;
  rejectReason?: AckRejectReason;
  message?: string;
}

export interface CommandResultEnvelope {
  type: typeof OpencodeDirectMessageType.Result;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  sessionId: string;
  success: boolean;
  finishedAt: number;
  exitCode?: number;
  output?: string;
  errorCode?: ResultErrorCode;
  errorMessage?: string;
}

export interface ReplyQuestionEnvelope {
  type: typeof OpencodeDirectMessageType.QuestionReply;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  questionRequestId: string;
  answers: string[][];
  issuedAt: number;
  metadata?: {
    chatId?: string;
  };
}

export interface QuestionReplyResultEnvelope {
  type: typeof OpencodeDirectMessageType.QuestionReplyResult;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  questionRequestId: string;
  success: boolean;
  finishedAt: number;
  errorCode?: ResultErrorCode;
  errorMessage?: string;
}

export type OpencodeDirectEnvelope =
  | ExecuteCommandEnvelope
  | CommandAckEnvelope
  | CommandResultEnvelope
  | ReplyQuestionEnvelope
  | QuestionReplyResultEnvelope;

export interface OpencodeDirectSessionRegistration {
  backend_kind: "opencode-plugin-direct";
  backend_protocol_version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  backend_endpoint: string;
  backend_auth_token: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isExecuteCommandEnvelope(value: unknown): value is ExecuteCommandEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.type !== OpencodeDirectMessageType.Execute) return false;
  if (record.version !== OPENCODE_DIRECT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(record.requestId)) return false;
  if (!isNonEmptyString(record.commandId)) return false;
  if (!isNonEmptyString(record.sessionId)) return false;
  if (!isNonEmptyString(record.command)) return false;
  if (!Object.values(OpencodeDirectSource).includes(record.source as OpencodeDirectSource)) return false;
  if (!isFiniteNumber(record.issuedAt)) return false;
  if (record.deadlineMs !== undefined && !isFiniteNumber(record.deadlineMs)) return false;

  return true;
}

export function isCommandAckEnvelope(value: unknown): value is CommandAckEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.type !== OpencodeDirectMessageType.Ack) return false;
  if (record.version !== OPENCODE_DIRECT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(record.requestId)) return false;
  if (!isNonEmptyString(record.commandId)) return false;
  if (!isNonEmptyString(record.sessionId)) return false;
  if (typeof record.accepted !== "boolean") return false;
  if (!isFiniteNumber(record.acceptedAt)) return false;
  if (record.rejectReason !== undefined && !Object.values(AckRejectReason).includes(record.rejectReason as AckRejectReason)) return false;

  return true;
}

export function isReplyQuestionEnvelope(value: unknown): value is ReplyQuestionEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.type !== OpencodeDirectMessageType.QuestionReply) return false;
  if (record.version !== OPENCODE_DIRECT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(record.requestId)) return false;
  if (!isNonEmptyString(record.sessionId)) return false;
  if (!isNonEmptyString(record.questionRequestId)) return false;
  if (!Array.isArray(record.answers)) return false;
  if (!isFiniteNumber(record.issuedAt)) return false;

  return true;
}

export function isQuestionReplyResultEnvelope(value: unknown): value is QuestionReplyResultEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.type !== OpencodeDirectMessageType.QuestionReplyResult) return false;
  if (record.version !== OPENCODE_DIRECT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(record.requestId)) return false;
  if (!isNonEmptyString(record.sessionId)) return false;
  if (!isNonEmptyString(record.questionRequestId)) return false;
  if (typeof record.success !== "boolean") return false;
  if (!isFiniteNumber(record.finishedAt)) return false;
  if (record.errorCode !== undefined && !Object.values(ResultErrorCode).includes(record.errorCode as ResultErrorCode)) return false;

  return true;
}

export function isCommandResultEnvelope(value: unknown): value is CommandResultEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.type !== OpencodeDirectMessageType.Result) return false;
  if (record.version !== OPENCODE_DIRECT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(record.requestId)) return false;
  if (!isNonEmptyString(record.commandId)) return false;
  if (!isNonEmptyString(record.sessionId)) return false;
  if (typeof record.success !== "boolean") return false;
  if (!isFiniteNumber(record.finishedAt)) return false;
  if (record.exitCode !== undefined && !isFiniteNumber(record.exitCode)) return false;
  if (record.errorCode !== undefined && !Object.values(ResultErrorCode).includes(record.errorCode as ResultErrorCode)) return false;

  return true;
}

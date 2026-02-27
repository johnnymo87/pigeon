export interface SessionRecord {
  sessionId: string;
  ppid: number | null;
  pid: number | null;
  startTime: number | null;
  cwd: string | null;
  label: string | null;
  notify: boolean;
  state: string;
  ptyPath: string | null;
  nvimSocket: string | null;
  backendKind: string | null;
  backendProtocolVersion: number | null;
  backendEndpoint: string | null;
  backendAuthToken: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeen: number;
  expiresAt: number;
}

export interface SessionTokenRecord {
  token: string;
  sessionId: string;
  chatId: string;
  scopes: string[];
  context: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export interface ReplyTokenRecord {
  channelId: string;
  replyKey: string;
  token: string;
  createdAt: number;
}

export interface InboxRecord {
  commandId: string;
  receivedAt: number;
  payload: string;
  status: string;
  updatedAt: number;
}

export interface QuestionOptionData {
  label: string;
  description: string;
}

export interface QuestionInfoData {
  question: string;
  header: string;
  options: QuestionOptionData[];
  multiple?: boolean;
  custom?: boolean;
}

export interface PendingQuestionRecord {
  sessionId: string;
  requestId: string;
  questions: QuestionInfoData[];
  token: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface StorePendingQuestionInput {
  sessionId: string;
  requestId: string;
  questions: QuestionInfoData[];
  token?: string;
}

export interface UpsertSessionInput {
  sessionId: string;
  ppid?: number | null;
  pid?: number | null;
  startTime?: number | null;
  cwd?: string | null;
  label?: string | null;
  notify?: boolean;
  state?: string;
  ptyPath?: string | null;
  nvimSocket?: string | null;
  backendKind?: string | null;
  backendProtocolVersion?: number | null;
  backendEndpoint?: string | null;
  backendAuthToken?: string | null;
}

export interface MintSessionTokenInput {
  token: string;
  sessionId: string;
  chatId: string;
  scopes?: string[];
  context?: Record<string, unknown>;
}

export interface PersistInboxCommandInput {
  commandId: string;
  payload: string;
}

export interface SessionRecord {
  sessionId: string;
  ppid: number | null;
  pid: number | null;
  startTime: number | null;
  cwd: string | null;
  label: string | null;
  notify: boolean;
  state: string;
  transportKind: string | null;
  nvimSocket: string | null;
  instanceName: string | null;
  tmuxPaneId: string | null;
  tmuxSession: string | null;
  paneId: string | null;
  sessionName: string | null;
  ptyPath: string | null;
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

export interface UpsertSessionInput {
  sessionId: string;
  ppid?: number | null;
  pid?: number | null;
  startTime?: number | null;
  cwd?: string | null;
  label?: string | null;
  notify?: boolean;
  state?: string;
  transportKind?: string | null;
  nvimSocket?: string | null;
  instanceName?: string | null;
  tmuxPaneId?: string | null;
  tmuxSession?: string | null;
  paneId?: string | null;
  sessionName?: string | null;
  ptyPath?: string | null;
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

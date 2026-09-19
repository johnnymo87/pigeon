export interface SessionRecord {
  sessionId: string;
  ppid: number | null;
  pid: number | null;
  startTime: number | null;
  cwd: string | null;
  label: string | null;
  title: string | null;
  /**
   * Message id of the most recent human-authored user turn (phase 1b of unread
   * navigation), used as the scroll anchor for notifications enqueued until the
   * next one. NULL when the session has had no such turn -- meaning "do not
   * scroll", which is the pre-feature behaviour of landing at the bottom.
   *
   * Written only by /mirror, so it is really "last turn authored in the TUI":
   * Telegram replies arrive as daemon-injected prompts and are excluded.
   */
  lastHumanMsgId: string | null;
  notify: boolean;
  state: string;
  ptyPath: string | null;
  nvimSocket: string | null;
  backendKind: string | null;
  backendProtocolVersion: number | null;
  backendEndpoint: string | null;
  backendAuthToken: string | null;
  /**
   * The id the BACKEND knows this session by, when that differs from pigeon's.
   *
   * Exists because goose's `session/new` returns `YYYYMMDD_N` -- a per-serve
   * counter (measured on goose 1.48.0: `20260919_1`..`_7`, persisting across a
   * serve restart). That is unique on one machine and NOT unique across
   * machines: every machine mints `20260920_1` as its first session of a day.
   * The worker's D1 keys sessions GLOBALLY (`session_id TEXT PRIMARY KEY`) and
   * its registration upsert overwrites `machine_id` on conflict, so two machines
   * launching goose on the same day would silently repoint each other's routing
   * -- and the reaper's unregister, which deletes by session id with no machine
   * filter, would destroy the other's live session.
   *
   * So pigeon mints its own globally-unique `gse_<uuid>` and keeps the backend's
   * name for it here. opencode needs none of this: its ids are already random.
   *
   * NULL for every session registered before this column existed, and for those
   * pigeon's id IS the backend's id -- read it through `backendSessionIdOf`
   * rather than directly, or the first prompt to a pre-existing goose session
   * goes out as `undefined`.
   */
  backendSessionId: string | null;
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
  /** Redeliveries seen so far. 0 on the first arrival; bounded by MAX_REDELIVERIES. */
  retryCount: number;
  /** Why the last delivery threw, so the give-up message can name the cause. */
  lastError: string | null;
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
  currentStep: number;
  answers: string[][];
  version: number;
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
  title?: string | null;
  notify?: boolean;
  state?: string;
  ptyPath?: string | null;
  nvimSocket?: string | null;
  backendKind?: string | null;
  backendProtocolVersion?: number | null;
  backendEndpoint?: string | null;
  backendAuthToken?: string | null;
  backendSessionId?: string | null;
}

/**
 * The id to address the BACKEND with for this session.
 *
 * The `?? sessionId` fallback is what lets the column be added without a
 * backfill: a row written before it existed has NULL, and for those two ids
 * were the same thing. Every ACP call must go through this rather than reading
 * the field, because reading it directly is correct for new rows and silently
 * wrong for old ones.
 */
export function backendSessionIdOf(session: {
  sessionId: string;
  backendSessionId?: string | null;
}): string {
  return session.backendSessionId ?? session.sessionId;
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

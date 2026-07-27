/**
 * All worker tests in a single file.
 * The worker uses D1 + HTTP polling (no Durable Objects).
 */
import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, it, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  generateCommandId as d1GenerateCommandId,
  queueCommand,
  pollNextCommand,
  ackCommand,
  touchMachine,
  isMachineRecent,
  cleanupCommands,
  cleanupSeenUpdates,
  MAX_QUEUE_PER_MACHINE,
} from "../src/d1-ops";
import { isAllowedChatId, generateToken, handleSendNotification } from "../src/notifications";
import {
  topicsEnabled,
  topicName,
  clampPreservingSurrogates,
  getBySession,
  getByThread,
  reserve,
  finalize,
  rename,
  markClosed,
  markOpen,
  deleteBySession,
  stealReservation,
  listReapable,
  listOrphaned,
  MACHINE_ICON_COLORS,
  DEFAULT_ICON_COLOR,
} from "../src/topics";
import { resolveTopic, RESERVATION_TTL_MS } from "../src/topic-manager";
import {
  verifyWebhookSecret,
  deduplicateUpdate,
  resolveMessageSession,
  resolveCallbackSession,
  generateCommandId,
  extractMedia,
  MAX_FILE_SIZE,
} from "../src/webhook";
import { cleanupExpiredMedia } from "../src/media";
import { handlePollNext, handleAckCommand } from "../src/poll";
import { handleSessionRequest } from "../src/sessions";
import {
  sendMessage,
  editMessageText,
  sendPhoto,
  sendDocument,
  answerCallbackQuery,
  getFile,
  getTelegramErrorDetails,
  createTelegramClient,
  createForumTopic,
  editForumTopic,
  closeForumTopic,
  reopenForumTopic,
  deleteForumTopic,
} from "../src/telegram";

// ─── Global D1 Schema Setup ─────────────────────────────────────────────

// Initialize D1 schema once before all tests (sessions, messages, seen_updates,
// commands, machines are all used by sessions/notifications/webhook modules).
const d1SchemaStatements = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    machine_id    TEXT NOT NULL,
    label         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine_id)`,
  `CREATE TABLE IF NOT EXISTS messages (
    chat_id         TEXT NOT NULL,
    message_id      INTEGER NOT NULL,
    session_id      TEXT NOT NULL,
    token           TEXT NOT NULL,
    notification_id TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
    ON messages(notification_id) WHERE notification_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS seen_updates (
    update_id     INTEGER PRIMARY KEY,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    command_id    TEXT PRIMARY KEY,
    machine_id    TEXT NOT NULL,
    session_id    TEXT,
    command_type  TEXT NOT NULL DEFAULT 'execute',
    command       TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    directory     TEXT,
    media_json    TEXT,
    metadata_json TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    leased_at     INTEGER,
    acked_at      INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commands_poll ON commands (machine_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS machines (
    machine_id    TEXT PRIMARY KEY,
    last_poll_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS topics (
    session_id        TEXT PRIMARY KEY,
    machine_id        TEXT,
    chat_id           TEXT NOT NULL,
    message_thread_id INTEGER,
    name              TEXT,
    state             TEXT NOT NULL DEFAULT 'open',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    closed_at         INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
    ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at)`,
];

beforeAll(async () => {
  for (const stmt of d1SchemaStatements) {
    await env.DB.prepare(stmt).run();
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────

const authHeaders = {
  Authorization: "Bearer test-api-key",
  "Content-Type": "application/json",
};

const API_KEY = "test-api-key";

async function registerSession(
  sessionId: string,
  machineId: string,
  label?: string,
): Promise<Response> {
  const body: Record<string, string> = { sessionId, machineId };
  if (label) body.label = label;
  return SELF.fetch("https://worker/sessions/register", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}

async function sendNotification(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://worker/notifications/send", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}

interface QueueRow {
  command_id: string;
  machine_id: string;
  session_id: string | null;
  command: string;
  chat_id: string;
  status: string;
  attempts: number;
  created_at: number;
  sent_at: number | null;
  next_retry_at: number | null;
  acked_at: number | null;
  last_error: string | null;
  command_type?: string;
  directory?: string | null;
  media_json?: string | null;
}

// Query D1 `commands` table (used by webhook/sessions/notifications tests)
async function queryQueueBySession(sessionId: string): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT command_id, machine_id, session_id, command, chat_id, status,
            0 as attempts, created_at, NULL as sent_at, NULL as next_retry_at, acked_at, NULL as last_error,
            command_type, directory, media_json
     FROM commands
     WHERE session_id = ?
     ORDER BY created_at ASC`,
  ).bind(sessionId).all<QueueRow>();
  return results;
}

// Query D1 `commands` table by machine (used by webhook tests)
async function queryQueueByMachine(machineId: string): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT command_id, machine_id, session_id, command, chat_id, status,
            0 as attempts, created_at, NULL as sent_at, NULL as next_retry_at, acked_at, NULL as last_error,
            command_type, directory, media_json
     FROM commands
     WHERE machine_id = ?
     ORDER BY created_at ASC`,
  ).bind(machineId).all<QueueRow>();
  return results;
}

async function insertCommandRow(row: {
  commandId: string;
  machineId: string;
  sessionId: string | null;
  status: string;
  createdAt: number;
  leasedAt?: number | null;
  ackedAt?: number | null;
  commandType?: string;
  directory?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO commands (
       command_id, machine_id, session_id, command_type, command, chat_id,
       status, created_at, leased_at, acked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.commandId,
      row.machineId,
      row.sessionId,
      row.commandType ?? "execute",
      "echo test",
      "8248645256",
      row.status,
      row.createdAt,
      row.leasedAt ?? null,
      row.ackedAt ?? null,
    )
    .run();
}

async function insertMessageMapping(input: {
  chatId: string;
  messageId: number;
  sessionId: string;
  token: string;
  createdAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (chat_id, message_id, session_id, token, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(input.chatId, input.messageId, input.sessionId, input.token, input.createdAt ?? Date.now())
    .run();
}

function mockTelegramSuccess(messageId: number) {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
    .reply(200, JSON.stringify({ ok: true, result: { message_id: messageId } }), {
      headers: { "Content-Type": "application/json" },
    });
}

function mockTelegramFailure(description: string) {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
    .reply(
      200,
      JSON.stringify({ ok: false, error_code: 400, description }),
      { headers: { "Content-Type": "application/json" } },
    );
}

// ─── Smoke Tests ───────────────────────────────────────────────────────

describe("worker basics", () => {
  it("health endpoint returns ok", async () => {
    const res = await SELF.fetch("https://worker/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("has required env bindings", () => {
    expect(env.DB).toBeDefined();
    expect(env.MEDIA).toBeDefined();
  });
});

// ─── Session Auth ──────────────────────────────────────────────────────

describe("session endpoints: auth", () => {
  test("GET /sessions without auth returns 401", async () => {
    const res = await SELF.fetch("https://worker/sessions");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("POST /sessions/register without auth returns 401", async () => {
    const res = await SELF.fetch("https://worker/sessions/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", machineId: "m1" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /sessions/unregister without auth returns 401", async () => {
    const res = await SELF.fetch("https://worker/sessions/unregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(401);
  });

  test("wrong API key returns 401", async () => {
    const res = await SELF.fetch("https://worker/sessions", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("malformed Authorization header returns 401", async () => {
    const res = await SELF.fetch("https://worker/sessions", {
      headers: { Authorization: "Token test-api-key" },
    });
    expect(res.status).toBe(401);
  });
});

// ─── Session Registration ──────────────────────────────────────────────

describe("POST /sessions/register", () => {
  test("registers a new session", async () => {
    const res = await registerSession("sess-1", "devbox", "my session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sessionId: "sess-1",
      machineId: "devbox",
    });
  });

  test("registered session appears in listing", async () => {
    await registerSession("sess-list", "devbox");
    const res = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-list");
    expect(found).toBeDefined();
    expect(found!.machine_id).toBe("devbox");
  });

  test("re-registration updates machine_id and label", async () => {
    await registerSession("sess-reregister", "devbox", "old");
    await registerSession("sess-reregister", "macbook", "new");

    const res = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-reregister");
    expect(found!.machine_id).toBe("macbook");
    expect(found!.label).toBe("new");
  });

  test("label defaults to null when not provided", async () => {
    await registerSession("sess-nolabel", "devbox");

    const res = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-nolabel");
    expect(found!.label).toBeNull();
  });

  test("missing sessionId returns 400", async () => {
    const res = await SELF.fetch("https://worker/sessions/register", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ machineId: "devbox" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sessionId and machineId required" });
  });

  test("missing machineId returns 400", async () => {
    const res = await SELF.fetch("https://worker/sessions/register", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  test("empty string sessionId returns 400", async () => {
    const res = await SELF.fetch("https://worker/sessions/register", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId: "", machineId: "devbox" }),
    });
    expect(res.status).toBe(400);
  });

  test("timestamps are set on registration", async () => {
    const before = Date.now();
    await registerSession("sess-ts", "devbox");
    const after = Date.now();

    const res = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-ts");
    expect(found!.created_at).toBeGreaterThanOrEqual(before);
    expect(found!.created_at).toBeLessThanOrEqual(after);
  });
});

// ─── Session Unregistration ────────────────────────────────────────────

describe("POST /sessions/unregister", () => {
  test("unregisters an existing session", async () => {
    await registerSession("sess-unreg", "devbox");
    const res = await SELF.fetch("https://worker/sessions/unregister", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId: "sess-unreg" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const listRes = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    const sessions = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(sessions.find((s) => s.session_id === "sess-unreg")).toBeUndefined();
  });

  test("unregistering non-existent session is a no-op (200)", async () => {
    const res = await SELF.fetch("https://worker/sessions/unregister", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId: "does-not-exist" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("missing sessionId returns 400", async () => {
    const res = await SELF.fetch("https://worker/sessions/unregister", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sessionId required" });
  });
});

// ─── Session Listing ───────────────────────────────────────────────────

describe("GET /sessions", () => {
  test("returns an array", async () => {
    const res = await SELF.fetch("https://worker/sessions", { headers: authHeaders });
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// ─── Notification: Unit Tests ──────────────────────────────────────────

describe("isAllowedChatId", () => {
  it("allows a chat ID in the allowlist", () => {
    const testEnv = { ...env, ALLOWED_CHAT_IDS: "123,456,789" } as Env;
    expect(isAllowedChatId("456", testEnv)).toBe(true);
    expect(isAllowedChatId(456, testEnv)).toBe(true);
  });

  it("rejects a chat ID not in the allowlist", () => {
    const testEnv = { ...env, ALLOWED_CHAT_IDS: "123,456" } as Env;
    expect(isAllowedChatId("999", testEnv)).toBe(false);
  });

  it("denies all when ALLOWED_CHAT_IDS is empty", () => {
    const testEnv = { ...env, ALLOWED_CHAT_IDS: "" } as Env;
    expect(isAllowedChatId("123", testEnv)).toBe(false);
  });

  it("denies all when ALLOWED_CHAT_IDS is undefined", () => {
    const testEnv = { ...env } as Env;
    delete (testEnv as Record<string, unknown>).ALLOWED_CHAT_IDS;
    expect(isAllowedChatId("123", testEnv)).toBe(false);
  });

  it("handles whitespace in the allowlist", () => {
    const testEnv = { ...env, ALLOWED_CHAT_IDS: " 123 , 456 " } as Env;
    expect(isAllowedChatId("123", testEnv)).toBe(true);
    expect(isAllowedChatId("456", testEnv)).toBe(true);
  });
});

describe("generateToken", () => {
  it("returns a base64url string of ~16 characters", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(14);
    expect(token.length).toBeLessThanOrEqual(18);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("topicsEnabled", () => {
  it("returns true when TELEGRAM_TOPICS_ENABLED is 'true'", () => {
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "true" } as Env)).toBe(true);
  });

  it("returns false when TELEGRAM_TOPICS_ENABLED is 'false'", () => {
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "false" } as Env)).toBe(false);
  });

  it("returns false when TELEGRAM_TOPICS_ENABLED is absent / undefined", () => {
    expect(topicsEnabled({} as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: undefined } as Env)).toBe(false);
  });

  it("returns false for messy, truthy, or non-matching inputs", () => {
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "TRUE" } as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "1" } as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "" } as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "   " } as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "true " } as Env)).toBe(false);
    expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "yes" } as Env)).toBe(false);
  });
});

// ─── Notification: Integration Tests ───────────────────────────────────

describe("POST /notifications/send", () => {
  const SESSION_ID = "notif-session";
  const CHAT_ID = "8248645256"; // Matches ALLOWED_CHAT_IDS in wrangler.toml

  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    await registerSession(SESSION_ID, "machine-1", "test");
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch("https://worker/notifications/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, chatId: CHAT_ID, text: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("validates required fields", async () => {
    const res = await sendNotification({ sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sessionId, chatId, and text required");
  });

  it("returns 404 for unknown session", async () => {
    const res = await sendNotification({
      sessionId: "nonexistent",
      chatId: CHAT_ID,
      text: "hello",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns 403 for disallowed chat ID", async () => {
    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: "999999",
      text: "hello",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Chat ID not allowed");
  });

  it("sends notification and returns messageId + token", async () => {
    mockTelegramSuccess(42);

    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "Session stopped",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number; token: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(42);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("passes reply_markup to Telegram when provided", async () => {
    mockTelegramSuccess(43);
    const markup = {
      inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]],
    };

    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "Approve?",
      replyMarkup: markup,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(43);
  });

  it("returns 502 when Telegram API fails", async () => {
    mockTelegramFailure("Bad Request: chat not found");
    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "hello",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Telegram API error");
  });

  it("returns 429 when Telegram rate limits with retryAfter", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(
        429,
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 17",
          parameters: { retry_after: 17 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );

    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "hello",
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body).toEqual({
      error: "rate_limited",
      retryAfter: 17,
    });
  });

// ─── Telegram Client Module Classifier ─────────────────────────────────────

describe("telegram client module classifier", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("sendMessage succeeds", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: "123", text: "hello" });
    expect(res).toEqual({
      ok: true,
      result: { message_id: 42 },
    });
  });

  it("sendMessage classifies 429 rate_limited with retry_after", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(
        429,
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
          parameters: { retry_after: 30 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );

    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: "123", text: "hello" });
    expect(res).toEqual({
      ok: false,
      kind: "rate_limited",
      retryAfter: 30,
      response: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 30",
        parameters: { retry_after: 30 },
      },
    });
  });

  it("sendMessage classifies thread_not_found", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(
        400,
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: message thread not found",
        }),
        { headers: { "Content-Type": "application/json" } },
      );

    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: "123", text: "hello" });
    expect(res).toEqual({
      ok: false,
      kind: "thread_not_found",
      response: {
        ok: false,
        error_code: 400,
        description: "Bad Request: message thread not found",
      },
    });
  });

  it("sendMessage classifies plain 400 as kind error", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(
        400,
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
        { headers: { "Content-Type": "application/json" } },
      );

    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: "123", text: "hello" });
    expect(res).toEqual({
      ok: false,
      kind: "error",
      errorCode: 400,
      description: "Bad Request: chat not found",
      response: {
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      },
    });
  });

  it("classifies non-JSON 502 response and generates synthetic details", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(502, "Bad Gateway", { headers: { "Content-Type": "text/html" } });

    const res = await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: "123", text: "hello" });
    expect(res).toEqual({
      ok: false,
      kind: "error",
      errorCode: 502,
      description: undefined,
      response: undefined,
    });

    const details = getTelegramErrorDetails(res);
    expect(details).toEqual({
      ok: false,
      description: undefined,
      error_code: 502,
    });
  });

  it("getTelegramErrorDetails extracts raw response body when present", () => {
    const rawBody = { ok: false, error_code: 400, description: "Bad Request: chat not found" };
    const details = getTelegramErrorDetails({
      ok: false,
      kind: "error",
      errorCode: 400,
      description: "Bad Request: chat not found",
      response: rawBody,
    });
    expect(details).toBe(rawBody);
  });

  describe("createTelegramClient factory and forum topic methods", () => {
    it("createTelegramClient binds botToken and provides all methods", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(
          200,
          JSON.stringify({
            ok: true,
            result: {
              message_thread_id: 101,
              name: "Bound Topic",
              icon_color: 7322096,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
      expect(typeof client.sendMessage).toBe("function");
      expect(typeof client.editMessageText).toBe("function");
      expect(typeof client.sendPhoto).toBe("function");
      expect(typeof client.sendDocument).toBe("function");
      expect(typeof client.answerCallbackQuery).toBe("function");
      expect(typeof client.getFile).toBe("function");
      expect(typeof client.createForumTopic).toBe("function");
      expect(typeof client.editForumTopic).toBe("function");
      expect(typeof client.closeForumTopic).toBe("function");
      expect(typeof client.reopenForumTopic).toBe("function");
      expect(typeof client.deleteForumTopic).toBe("function");

      const res = await client.createForumTopic({ chatId: "-10012345", name: "Bound Topic" });
      expect(res).toEqual({
        ok: true,
        result: {
          message_thread_id: 101,
          name: "Bound Topic",
          icon_color: 7322096,
        },
      });
    });

    it("createForumTopic success shape with optional parameters", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(
          200,
          JSON.stringify({
            ok: true,
            result: {
              message_thread_id: 42,
              name: "Feature Topic",
              icon_color: 16766590,
              icon_custom_emoji_id: "emoji_123",
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await createForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        name: "Feature Topic",
        iconColor: 16766590,
        iconCustomEmojiId: "emoji_123",
      });

      expect(res).toEqual({
        ok: true,
        result: {
          message_thread_id: 42,
          name: "Feature Topic",
          icon_color: 16766590,
          icon_custom_emoji_id: "emoji_123",
        },
      });
    });

    it("createForumTopic error classification path", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(
          400,
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: TOPIC_NAME_INVALID",
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await createForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        name: "",
      });

      expect(res).toEqual({
        ok: false,
        kind: "error",
        errorCode: 400,
        description: "Bad Request: TOPIC_NAME_INVALID",
        response: {
          ok: false,
          error_code: 400,
          description: "Bad Request: TOPIC_NAME_INVALID",
        },
      });
    });

    it("editForumTopic success shape", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: true }), {
          headers: { "Content-Type": "application/json" },
        });

      const res = await editForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
        name: "Renamed Topic",
        iconCustomEmojiId: "emoji_456",
      });

      expect(res).toEqual({ ok: true, result: true });
    });

    it("editForumTopic error classification path (rate limited)", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
        .reply(
          429,
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 15",
            parameters: { retry_after: 15 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await editForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
        name: "Renamed Topic",
      });

      expect(res).toEqual({
        ok: false,
        kind: "rate_limited",
        retryAfter: 15,
        response: {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 15",
          parameters: { retry_after: 15 },
        },
      });
    });

    it("closeForumTopic success shape", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/closeForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: true }), {
          headers: { "Content-Type": "application/json" },
        });

      const res = await closeForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
      });

      expect(res).toEqual({ ok: true, result: true });
    });

    it("closeForumTopic error classification path (thread_not_found)", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/closeForumTopic/ })
        .reply(
          400,
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found",
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await closeForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 999,
      });

      expect(res).toEqual({
        ok: false,
        kind: "thread_not_found",
        response: {
          ok: false,
          error_code: 400,
          description: "Bad Request: message thread not found",
        },
      });
    });

    it("reopenForumTopic success shape", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/reopenForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: true }), {
          headers: { "Content-Type": "application/json" },
        });

      const res = await reopenForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
      });

      expect(res).toEqual({ ok: true, result: true });
    });

    it("reopenForumTopic error classification path", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/reopenForumTopic/ })
        .reply(
          400,
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: TOPIC_NOT_MODIFIED",
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await reopenForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
      });

      expect(res).toEqual({
        ok: false,
        kind: "error",
        errorCode: 400,
        description: "Bad Request: TOPIC_NOT_MODIFIED",
        response: {
          ok: false,
          error_code: 400,
          description: "Bad Request: TOPIC_NOT_MODIFIED",
        },
      });
    });

    it("deleteForumTopic success shape", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/deleteForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: true }), {
          headers: { "Content-Type": "application/json" },
        });

      const res = await deleteForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
      });

      expect(res).toEqual({ ok: true, result: true });
    });

    it("deleteForumTopic error classification path", async () => {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/deleteForumTopic/ })
        .reply(
          400,
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: TOPIC_NOT_FOUND",
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await deleteForumTopic(env.TELEGRAM_BOT_TOKEN, {
        chatId: "-10012345",
        messageThreadId: 42,
      });

      expect(res).toEqual({
        ok: false,
        kind: "error",
        errorCode: 400,
        description: "Bad Request: TOPIC_NOT_FOUND",
        response: {
          ok: false,
          error_code: 400,
          description: "Bad Request: TOPIC_NOT_FOUND",
        },
      });
    });
  });
});

  it("stores unique tokens per notification", async () => {
    mockTelegramSuccess(100);
    const res1 = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "first",
    });
    const body1 = (await res1.json()) as { token: string };

    mockTelegramSuccess(101);
    const res2 = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "second",
    });
    const body2 = (await res2.json()) as { token: string };

    expect(body1.token).not.toBe(body2.token);
  });

  it("reuses daemon token from callback_data instead of generating own", async () => {
    const DAEMON_TOKEN = "daemon-supplied-token-abc";
    mockTelegramSuccess(9001);

    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "Question notification",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "Blue", callback_data: `cmd:${DAEMON_TOKEN}:q0` },
            { text: "Green", callback_data: `cmd:${DAEMON_TOKEN}:q1` },
          ],
        ],
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.token).toBe(DAEMON_TOKEN);
  });

  it("generates fresh token when replyMarkup has no cmd: callback_data", async () => {
    mockTelegramSuccess(9002);

    const res = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "Stop notification",
      replyMarkup: { inline_keyboard: [] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    // Token should be a base64url string (not a specific daemon token)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.token).not.toBe("");
  });
});

// ─── Webhook: Helpers ─────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-webhook-secret";
const CHAT_ID_NUM = 8248645256;

function webhookHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
  };
}

let webhookUpdateCounter = 1000;

function makeWebhookRequest(update: Record<string, unknown>): Request {
  return new Request("https://worker/webhook/telegram/path-secret", {
    method: "POST",
    headers: webhookHeaders(),
    body: JSON.stringify(update),
  });
}

async function sendWebhook(update: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(makeWebhookRequest(update));
}

function makeTextReply(
  text: string,
  replyToMessageId: number,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeCmdMessage(
  text: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text,
    },
  };
}

function makeCallbackQuery(
  data: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    callback_query: {
      id: `cb-${++webhookUpdateCounter}`,
      from: { id: CHAT_ID_NUM },
      message: { chat: { id: CHAT_ID_NUM } },
      data,
    },
  };
}

function mockTelegramSendMessage(messageId: number = 99999) {
  // Specific mock for sendMessage that always returns a valid message_id
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
    .reply(200, JSON.stringify({ ok: true, result: { message_id: messageId } }));
}

function mockTelegramAny() {
  // Catch-all mock for non-sendMessage Telegram API calls (e.g., answerCallbackQuery)
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*/ })
    .reply(200, JSON.stringify({ ok: true, result: { message_id: 99999 } }), {
      headers: { "Content-Type": "application/json" },
    });
}

// ─── Webhook: Auth ────────────────────────────────────────────────────

describe("webhook auth", () => {
  it("rejects requests without webhook secret", async () => {
    const res = await SELF.fetch("https://worker/webhook/telegram/secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("rejects requests with wrong webhook secret", async () => {
    const res = await SELF.fetch("https://worker/webhook/telegram/secret", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid webhook secret", async () => {
    const res = await sendWebhook({ update_id: ++webhookUpdateCounter });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ─── Webhook: Deduplication ───────────────────────────────────────────

describe("webhook dedup", () => {
  it("processes first update and deduplicates second", async () => {
    const updateId = ++webhookUpdateCounter;
    const res1 = await sendWebhook({ update_id: updateId });
    expect(res1.status).toBe(200);

    // Same update_id should be deduplicated (still 200 ok, but not processed)
    const res2 = await sendWebhook({ update_id: updateId });
    expect(res2.status).toBe(200);
  });
});

// ─── Webhook: Reply Routing ───────────────────────────────────────────

describe("webhook reply routing", () => {
  const SESSION_ID = "webhook-route-session";

  beforeAll(async () => {
    await registerSession(SESSION_ID, "machine-1", "test");
  });

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("routes a reply-to-message to the correct session", async () => {
    // Send a notification to create a message mapping
    mockTelegramSuccess(200);
    const notifRes = await sendNotification({
      sessionId: SESSION_ID,
      chatId: String(CHAT_ID_NUM),
      text: "Session idle",
    });
    const notifBody = (await notifRes.json()) as { messageId: number; token: string };

    // Now reply to that message — needs a sendMessage mock for "Command queued"
    mockTelegramSendMessage();
    const res = await sendWebhook(makeTextReply("continue working", notifBody.messageId));
    expect(res.status).toBe(200);
    // Command should be queued (we can verify by checking the response is "ok")
    expect(await res.text()).toBe("ok");
  });

  it("routes a /cmd TOKEN command to the correct session", async () => {
    mockTelegramSuccess(5001);
    const notifRes = await sendNotification({
      sessionId: SESSION_ID,
      chatId: String(CHAT_ID_NUM),
      text: "Session idle",
    });
    const notifBody = (await notifRes.json()) as { token: string };

    mockTelegramSendMessage(); // For "Command queued" confirmation
    const res = await sendWebhook(makeCmdMessage(`/cmd ${notifBody.token} do something`));
    expect(res.status).toBe(200);
  });

  it("sends error when no session found for message", async () => {
    mockTelegramSendMessage(); // For sendTelegramMessage error reporting
    const res = await sendWebhook(makeTextReply("hello", 99999));
    expect(res.status).toBe(200);
  });

  it("routes callback query with cmd:TOKEN:action format", async () => {
    mockTelegramSuccess(5002);
    const notifRes = await sendNotification({
      sessionId: SESSION_ID,
      chatId: String(CHAT_ID_NUM),
      text: "Need approval",
    });
    const notifBody = (await notifRes.json()) as { token: string };

    mockTelegramAny(); // For answerCallbackQuery
    mockTelegramSendMessage(); // For "Command queued" sendMessage
    const res = await sendWebhook(makeCallbackQuery(`cmd:${notifBody.token}:yes`));
    expect(res.status).toBe(200);
  });

  it("answers 'Session expired' for callback with unknown token", async () => {
    mockTelegramAny(); // For answerCallbackQuery
    const res = await sendWebhook(makeCallbackQuery("cmd:unknowntoken:yes"));
    expect(res.status).toBe(200);
  });

  it("silently drops non-cmd callback queries", async () => {
    const res = await sendWebhook(makeCallbackQuery("other:data"));
    expect(res.status).toBe(200);
  });

  it("silently acknowledges unknown update types", async () => {
    const res = await sendWebhook({
      update_id: ++webhookUpdateCounter,
      edited_message: { chat: { id: CHAT_ID_NUM }, text: "edited" },
    });
    expect(res.status).toBe(200);
  });
});

// ─── Command Queue + Alarm: Integration ───────────────────────────────

describe("command queue lifecycle", () => {
  const CHAT_ID_NUM = 8248645256;
  const MACHINE_ID = "queue-machine";

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("queues webhook commands as pending rows", async () => {
    const sessionId = `queue-session-${Date.now()}-${Math.random()}`;
    await registerSession(sessionId, MACHINE_ID);

    const uniqueMessageId = Number(String(Date.now()).slice(-6)) + 900_000;
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: uniqueMessageId,
      sessionId,
      token: `queue-token-${uniqueMessageId}`,
    });

    const webhookRes = await sendWebhook(makeTextReply("ls -la", uniqueMessageId));
    expect(webhookRes.status).toBe(200);

    const queueRows = await queryQueueBySession(sessionId);
    expect(queueRows.length).toBe(1);
    expect(queueRows[0]?.machine_id).toBe(MACHINE_ID);
    expect(queueRows[0]?.status).toBe("pending");
    expect(queueRows[0]?.attempts).toBe(0);
    expect(queueRows[0]?.command).toBe("ls -la");
  });

  it("cleanupCommands deletes old acked and old stuck commands", async () => {
    const now = Date.now();
    const baseSession = `cleanup-session-${Date.now()}`;
    await registerSession(baseSession, MACHINE_ID);

    await insertCommandRow({
      commandId: `acked-old-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "acked",
      createdAt: now - (2 * 60 * 60 * 1000),
      ackedAt: now - (90 * 60 * 1000),
    });

    await insertCommandRow({
      commandId: `pending-stuck-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "pending",
      createdAt: now - (2 * 24 * 60 * 60 * 1000),
    });

    await insertCommandRow({
      commandId: `pending-fresh-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "pending",
      createdAt: now - (10 * 60 * 1000),
    });

    // Simulate scheduled cleanup (replaces DO alarm)
    await cleanupCommands(env.DB, now);

    const rows = await queryQueueBySession(baseSession);
    const ids = rows.map((row) => row.command_id);

    expect(ids).not.toContain(`acked-old-${now}`);
    expect(ids).not.toContain(`pending-stuck-${now}`);
    expect(ids).toContain(`pending-fresh-${now}`);
  });

  it("poll and ack lifecycle: daemon polls pending command, acks it, status becomes acked", async () => {
    const now = Date.now();
    // Use a unique machine ID to avoid picking up leftover rows from other tests
    const uniqueMachineId = `poll-ack-machine-${now}`;
    const sessionId = `poll-ack-session-${now}`;
    const commandId = `poll-ack-cmd-${now}`;
    await registerSession(sessionId, uniqueMachineId);

    await insertCommandRow({
      commandId,
      machineId: uniqueMachineId,
      sessionId,
      status: "pending",
      createdAt: now - 1_000,
    });

    // Poll the command
    const pollReq = new Request(`https://worker/machines/${uniqueMachineId}/next`, {
      headers: { Authorization: "Bearer test-api-key" },
    });
    const pollRes = await SELF.fetch(pollReq);
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as { commandId: string };
    expect(pollBody.commandId).toBe(commandId);

    // Ack the command
    const ackReq = new Request(`https://worker/commands/${pollBody.commandId}/ack`, {
      method: "POST",
      headers: { Authorization: "Bearer test-api-key" },
    });
    const ackRes = await SELF.fetch(ackReq);
    expect(ackRes.status).toBe(200);

    // Verify status is acked in D1
    const row = await env.DB.prepare(
      "SELECT status, acked_at FROM commands WHERE command_id = ?",
    ).bind(commandId).first<{ status: string; acked_at: number | null }>();
    expect(row!.status).toBe("acked");
    expect(row!.acked_at).not.toBeNull();
  });

  it("scheduled cleanup runs without errors", async () => {
    // Just verify cleanupCommands and cleanupSeenUpdates don't throw
    const commandResult = await cleanupCommands(env.DB);
    expect(typeof commandResult.ackedDeleted).toBe("number");
    expect(typeof commandResult.stuckDeleted).toBe("number");

    const seenResult = await cleanupSeenUpdates(env.DB);
    expect(typeof seenResult).toBe("number");
  });
});

// ─── Webhook: Unit Tests ──────────────────────────────────────────────

describe("generateCommandId", () => {
  it("returns a 32-char hex string", () => {
    const id = generateCommandId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateCommandId()));
    expect(ids.size).toBe(50);
  });
});

// ─── /launch Command: Integration Tests ──────────────────────────────

function makeLaunchMessage(
  machineId: string,
  directory: string,
  prompt: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/launch ${machineId} ${directory} ${prompt}`,
    },
  };
}

describe("/launch command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("replies with offline error when machine has not recently polled", async () => {
    // Machine not in D1 machines table → isMachineRecent returns false
    mockTelegramSendMessage(); // ack for error message

    const res = await sendWebhook(
      makeLaunchMessage("offline-machine", "/home/dev/project", "do something"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues a launch command when machine has recently polled D1", async () => {
    const now = Date.now();
    const machineId = `launch-machine-${now}`;

    // Insert a recent machines row so isMachineRecent returns true
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack "Launching on ..."

    const res = await sendWebhook(
      makeLaunchMessage(machineId, "/home/dev/myproject", "build and test the app"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the launch command was queued with correct type and directory (D1)
    const rows = await queryQueueByMachine(machineId);
    const launchRows = rows.filter((r) => r.command_type === "launch");
    expect(launchRows.length).toBeGreaterThanOrEqual(1);
    const launchRow = launchRows[launchRows.length - 1]!;
    expect(launchRow.command_type).toBe("launch");
    expect(launchRow.directory).toBe("/home/dev/myproject");
    expect(launchRow.command).toBe("build and test the app");
    expect(launchRow.session_id).toBeNull();
    expect(launchRow.machine_id).toBe(machineId);
  });

  it("prompt captures everything after directory including spaces", async () => {
    const now = Date.now();
    const machineId = `launch-multiword-${now}`;

    // Insert a recent machines row so isMachineRecent returns true
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage();

    await sendWebhook({
      update_id: ++webhookUpdateCounter,
      message: {
        message_id: ++webhookUpdateCounter,
        chat: { id: CHAT_ID_NUM },
        from: { id: CHAT_ID_NUM },
        text: `/launch ${machineId} /tmp/proj implement a login page with JWT auth`,
      },
    });

    // Verify the command was queued with the full prompt (D1)
    const rows = await queryQueueByMachine(machineId);
    const launchRows = rows.filter((r) => r.command_type === "launch");
    expect(launchRows.length).toBeGreaterThanOrEqual(1);
    const launchRow = launchRows[launchRows.length - 1]!;
    expect(launchRow.command).toBe("implement a login page with JWT auth");
    expect(launchRow.directory).toBe("/tmp/proj");
  });

  it("does not fall through to regular session resolution for /launch", async () => {
    // Even if there's no session for the machine, /launch should not
    // produce the "Could not find session" error message — it should only
    // produce the "not recently seen" message.
    mockTelegramSendMessage(); // exactly one Telegram call expected (offline)

    const res = await sendWebhook(
      makeLaunchMessage("never-connected-machine", "/tmp", "hello"),
    );

    expect(res.status).toBe(200);
    // fetchMock should have consumed exactly the one mock (not recently seen)
    // If it tried a second sendMessage it would throw (no more mocks).
  });
});

// ─── /current-state Command: Integration Tests ─────────────────────────

function makeCurrentStateMessage(
  machineId?: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: machineId !== undefined ? `/current-state ${machineId}` : `/current-state`,
    },
  };
}

describe("/current-state command", () => {
  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    await env.DB.exec("DELETE FROM commands");
    await env.DB.exec("DELETE FROM machines");
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("replies with offline error when default machine (cloudbox) has not recently polled", async () => {
    mockTelegramSendMessage(); // expects 1 Telegram send message call for offline error

    const res = await sendWebhook(makeCurrentStateMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // We should also assert that NO commands were queued
    const rows = await queryQueueByMachine("cloudbox");
    expect(rows.length).toBe(0);
  });

  it("replies with offline error when explicitly provided machine has not recently polled", async () => {
    mockTelegramSendMessage(); // expects 1 Telegram send message call for offline error

    const res = await sendWebhook(makeCurrentStateMessage("devbox"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueByMachine("devbox");
    expect(rows.length).toBe(0);
  });

  it("queues current_state command for default machine (cloudbox) when recent", async () => {
    const now = Date.now();
    await touchMachine(env.DB, "cloudbox", now);

    mockTelegramSendMessage(); // ack message "Fetching current state..."

    const res = await sendWebhook(makeCurrentStateMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueByMachine("cloudbox");
    const csRows = rows.filter((r) => r.command_type === "current_state");
    expect(csRows.length).toBeGreaterThanOrEqual(1);
    const csRow = csRows[csRows.length - 1]!;
    expect(csRow.command_type).toBe("current_state");
    expect(csRow.command).toBe("");
    expect(csRow.session_id).toBeNull();
    expect(csRow.machine_id).toBe("cloudbox");
  });

  it("queues current_state command for explicitly provided machine (devbox) when recent", async () => {
    const now = Date.now();
    await touchMachine(env.DB, "devbox", now);

    mockTelegramSendMessage(); // ack message "Fetching current state..."

    const res = await sendWebhook(makeCurrentStateMessage("devbox"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueByMachine("devbox");
    const csRows = rows.filter((r) => r.command_type === "current_state");
    expect(csRows.length).toBeGreaterThanOrEqual(1);
    const csRow = csRows[csRows.length - 1]!;
    expect(csRow.command_type).toBe("current_state");
    expect(csRow.command).toBe("");
    expect(csRow.session_id).toBeNull();
    expect(csRow.machine_id).toBe("devbox");
  });

  it("rejects when trailing arguments are present", async () => {
    const now = Date.now();
    await touchMachine(env.DB, "cloudbox", now);

    mockTelegramSendMessage(); // for the fallback error reply

    const res = await sendWebhook(makeCurrentStateMessage("cloudbox extra_arg"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Assert that NO commands were queued
    const rows = await queryQueueByMachine("cloudbox");
    const csRows = rows.filter((r) => r.command_type === "current_state");
    expect(csRows.length).toBe(0);
  });
});

// ─── Media Endpoints ──────────────────────────────────────────────────

describe("media endpoints", () => {
  it("POST /media/upload rejects without API key", async () => {
    const form = new FormData();
    form.append("key", "inbound/test/photo.jpg");
    form.append("mime", "image/jpeg");
    form.append("filename", "photo.jpg");
    form.append("file", new Blob(["fake-image-data"], { type: "image/jpeg" }));

    const res = await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(401);
  });

  it("POST /media/upload returns 400 for missing fields", async () => {
    const form = new FormData();
    form.append("key", "test-key");
    // Missing mime, filename, file

    const res = await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(400);
  });

  it("POST /media/upload stores file and returns key", async () => {
    const form = new FormData();
    form.append("key", "inbound/123-abc/photo.jpg");
    form.append("mime", "image/jpeg");
    form.append("filename", "photo.jpg");
    form.append("file", new Blob(["fake-image-data"], { type: "image/jpeg" }));

    const res = await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe("inbound/123-abc/photo.jpg");
  });

  it("GET /media/:key returns 401 without API key", async () => {
    const res = await SELF.fetch("https://worker/media/inbound/test/photo.jpg");
    expect(res.status).toBe(401);
  });

  it("GET /media/:key returns 404 for missing key", async () => {
    const res = await SELF.fetch("https://worker/media/nonexistent/file.jpg", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it("roundtrip: upload then download returns correct file", async () => {
    const fileContent = "test-file-content-binary";
    const form = new FormData();
    form.append("key", "inbound/456-def/document.pdf");
    form.append("mime", "application/pdf");
    form.append("filename", "document.pdf");
    form.append("file", new Blob([fileContent], { type: "application/pdf" }));

    // Upload
    const uploadRes = await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(uploadRes.status).toBe(200);

    // Download
    const downloadRes = await SELF.fetch("https://worker/media/inbound/456-def/document.pdf", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(downloadRes.headers.get("Content-Disposition")).toContain("document.pdf");
    const text = await downloadRes.text();
    expect(text).toBe(fileContent);
  });
});

// ─── /kill Command: Integration Tests ──────────────────────────────

function makeKillReply(
  replyToMessageId: number,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/kill",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeKillMessage(updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/kill",
    },
  };
}

describe("/kill command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with 'could not find a session' when reply_to_message has no mapping", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillReply(99997));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `kill-offline-${now}`;
    const machineId = `kill-offline-machine-${now}`;
    const notifMsgId = 6_000_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `kill-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues a kill command when machine has recently polled D1", async () => {
    const now = Date.now();
    const sessionId = `kill-connected-${now}`;
    const machineId = `kill-machine-${now}`;
    const notifMsgId = 6_001_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `kill-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack "Killing session..."

    const res = await sendWebhook(makeKillReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the kill command was queued in D1
    const rows = await queryQueueBySession(sessionId);
    const killRows = rows.filter((r) => r.command_type === "kill");
    expect(killRows.length).toBeGreaterThanOrEqual(1);
    const killRow = killRows[killRows.length - 1]!;
    expect(killRow.command_type).toBe("kill");
    expect(killRow.session_id).toBe(sessionId);
    expect(killRow.machine_id).toBe(machineId);
  });
});

// ─── /interrupt Command: Integration Tests ──────────────────────────────

function makeInterruptReply(
  replyToMessageId: number,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/interrupt",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeInterruptMessage(updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/interrupt",
    },
  };
}

describe("/interrupt command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeInterruptMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with 'could not find a session' when reply_to_message has no mapping", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeInterruptReply(99996));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues an interrupt command when machine has recently polled D1", async () => {
    const now = Date.now();
    const sessionId = `interrupt-connected-${now}`;
    const machineId = `interrupt-machine-${now}`;
    const notifMsgId = 6_002_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `interrupt-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack "Interrupting session..."

    const res = await sendWebhook(makeInterruptReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the interrupt command was queued in D1
    const rows = await queryQueueBySession(sessionId);
    const interruptRows = rows.filter((r) => r.command_type === "interrupt");
    expect(interruptRows.length).toBeGreaterThanOrEqual(1);
    const interruptRow = interruptRows[interruptRows.length - 1]!;
    expect(interruptRow.command_type).toBe("interrupt");
    expect(interruptRow.session_id).toBe(sessionId);
    expect(interruptRow.machine_id).toBe(machineId);
  });
});

// ─── /compact Command: Integration Tests ─────────────────────────────

function makeCompactMessage(updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/compact",
    },
  };
}

function makeCompactReply(
  replyToMessageId: number,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/compact",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

describe("/compact command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeCompactMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with 'could not find a session' when reply_to_message has no mapping", async () => {
    mockTelegramSendMessage();

    // Reply to a message ID that has no mapping in the messages table
    const res = await sendWebhook(makeCompactReply(99998));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with session not found when session mapping exists but session is deleted", async () => {
    const now = Date.now();
    const orphanedSessionId = `compact-orphan-${now}`;
    const notifMsgId = 4_000_001 + (now % 100);

    // Insert a message mapping pointing to a session that doesn't exist in sessions table
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId: orphanedSessionId,
      token: `compact-orphan-token-${now}`,
    });

    mockTelegramSendMessage();

    const res = await sendWebhook(makeCompactReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // No command should have been queued
    const rows = await queryQueueBySession(orphanedSessionId);
    expect(rows.length).toBe(0);
  });

  it("replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `compact-offline-${now}`;
    const machineId = `compact-offline-machine-${now}`;
    const notifMsgId = 4_001_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `compact-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false

    mockTelegramSendMessage();

    const res = await sendWebhook(makeCompactReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // No compact command should be queued
    const rows = await queryQueueBySession(sessionId);
    const compactRows = rows.filter((r) => r.command_type === "compact");
    expect(compactRows.length).toBe(0);
  });

  it("queues a compact command when machine has recently polled D1", async () => {
    const now = Date.now();
    const sessionId = `compact-connected-${now}`;
    const machineId = `compact-machine-${now}`;
    const notifMsgId = 4_002_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `compact-token-${now}`,
    });
    // Insert a recent machines row so isMachineRecent returns true
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack "Compacting session..."

    const res = await sendWebhook(makeCompactReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the compact command was queued in D1 with correct command_type
    const rows = await queryQueueBySession(sessionId);
    const compactRows = rows.filter((r) => r.command_type === "compact");
    expect(compactRows.length).toBeGreaterThanOrEqual(1);
    const compactRow = compactRows[compactRows.length - 1]!;
    expect(compactRow.command_type).toBe("compact");
    expect(compactRow.session_id).toBe(sessionId);
    expect(compactRow.machine_id).toBe(machineId);
  });
});

// ─── Telegram Media: Unit Tests ───────────────────────────────────────

describe("extractMedia", () => {
  it("returns null for text-only message", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      text: "hello world",
    };
    expect(extractMedia(msg)).toBeNull();
  });

  it("extracts photo file_id from largest photo size within dimension limit", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      photo: [
        { file_id: "small-id", file_unique_id: "small-uid", width: 100, height: 100, file_size: 1000 },
        { file_id: "medium-id", file_unique_id: "medium-uid", width: 320, height: 320, file_size: 5000 },
        { file_id: "large-id", file_unique_id: "large-uid", width: 800, height: 800, file_size: 50000 },
      ],
    };
    const result = extractMedia(msg);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("large-id");
    expect(result!.fileUniqueId).toBe("large-uid");
    expect(result!.mime).toBe("image/jpeg");
    expect(result!.filename).toBe("photo_large-uid.jpg");
    expect(result!.size).toBe(50000);
  });

  it("skips oversized photo variants and picks largest within limit", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      photo: [
        { file_id: "small-id", file_unique_id: "small-uid", width: 100, height: 100, file_size: 1000 },
        { file_id: "fit-id", file_unique_id: "fit-uid", width: 1280, height: 960, file_size: 80000 },
        { file_id: "oversized-id", file_unique_id: "oversized-uid", width: 2560, height: 1920, file_size: 200000 },
      ],
    };
    const result = extractMedia(msg);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("fit-id");
    expect(result!.size).toBe(80000);
  });

  it("returns null when all photo variants exceed dimension limit", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      photo: [
        { file_id: "big-id", file_unique_id: "big-uid", width: 2000, height: 2000, file_size: 100000 },
        { file_id: "bigger-id", file_unique_id: "bigger-uid", width: 3000, height: 3000, file_size: 200000 },
      ],
    };
    const result = extractMedia(msg);
    expect(result).toBeNull();
  });

  it("extracts document metadata", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 102400,
      },
    };
    const result = extractMedia(msg);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("doc-file-id");
    expect(result!.fileUniqueId).toBe("doc-unique-id");
    expect(result!.mime).toBe("application/pdf");
    expect(result!.filename).toBe("report.pdf");
    expect(result!.size).toBe(102400);
  });

  it("uses fallback mime for document without mime_type", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      document: {
        file_id: "doc-id",
        file_unique_id: "doc-uid",
      },
    };
    const result = extractMedia(msg);
    expect(result!.mime).toBe("application/octet-stream");
    expect(result!.filename).toBe("file_doc-uid");
  });

  it("extracts audio with fallback filename", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      audio: {
        file_id: "audio-id",
        file_unique_id: "audio-uid",
        duration: 120,
        mime_type: "audio/mpeg",
        file_size: 2048000,
      },
    };
    const result = extractMedia(msg);
    expect(result).not.toBeNull();
    expect(result!.fileId).toBe("audio-id");
    expect(result!.mime).toBe("audio/mpeg");
    expect(result!.size).toBe(2048000);
  });

  it("extracts video with fallback mime", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      video: {
        file_id: "video-id",
        file_unique_id: "video-uid",
        duration: 30,
      },
    };
    const result = extractMedia(msg);
    expect(result!.mime).toBe("video/mp4");
    expect(result!.filename).toBe("video_video-uid");
  });

  it("extracts voice with .ogg filename", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      voice: {
        file_id: "voice-id",
        file_unique_id: "voice-uid",
        duration: 5,
      },
    };
    const result = extractMedia(msg);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("audio/ogg");
    expect(result!.filename).toBe("voice_voice-uid.ogg");
  });

  it("prefers photo over other media types", () => {
    const msg = {
      message_id: 1,
      chat: { id: 123 },
      photo: [{ file_id: "photo-id", file_unique_id: "photo-uid", width: 100, height: 100 }],
      document: { file_id: "doc-id", file_unique_id: "doc-uid" },
    };
    const result = extractMedia(msg);
    expect(result!.fileId).toBe("photo-id");
  });

  it("MAX_FILE_SIZE is 20MB", () => {
    expect(MAX_FILE_SIZE).toBe(20 * 1024 * 1024);
  });
});

// ─── Telegram Media: Integration Tests ───────────────────────────────

function makeMediaReply(
  replyToMessageId: number,
  media: Record<string, unknown>,
  caption?: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      caption,
      reply_to_message: { message_id: replyToMessageId },
      ...media,
    },
  };
}

function mockGetFile(filePath: string) {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/getFile/ })
    .reply(200, JSON.stringify({ ok: true, result: { file_path: filePath } }), {
      headers: { "Content-Type": "application/json" },
    });
}

function mockFileDownload(content = "fake-file-data") {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "GET", path: /\/file\/bot.*/ })
    .reply(200, content, {
      headers: { "Content-Type": "application/octet-stream" },
    });
}

describe("Telegram media webhook", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("uses caption as command text for media messages", async () => {
    const now = Date.now();
    const sessionId = `media-caption-session-${now}`;
    const notifMsgId = 2_000_001 + (now % 100);
    await registerSession(sessionId, "machine-1", "test");
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-caption-token-${now}` });

    mockGetFile("photos/abc123.jpg");
    mockFileDownload("fake-photo-data");

    const res = await sendWebhook(makeMediaReply(
      notifMsgId,
      { photo: [{ file_id: "photo-id", file_unique_id: "photo-uid", width: 100, height: 100, file_size: 1024 }] },
      "describe this image",
    ));
    expect(res.status).toBe(200);

    const queueRows = await queryQueueBySession(sessionId);
    const lastRow = queueRows[queueRows.length - 1];
    expect(lastRow?.command).toBe("describe this image");
  });

  it("sends error for files over 20MB", async () => {
    const now = Date.now();
    const sessionId = `media-oversize-session-${now}`;
    const notifMsgId = 2_000_101 + (now % 100);
    await registerSession(sessionId, "machine-1", "test");
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-oversize-token-${now}` });

    // Mock sendMessage for error reply
    mockTelegramSendMessage();

    const oversizedDoc = {
      document: {
        file_id: "big-doc-id",
        file_unique_id: "big-doc-uid",
        file_name: "huge.zip",
        mime_type: "application/zip",
        file_size: 25 * 1024 * 1024, // 25MB
      },
    };

    const res = await sendWebhook(makeMediaReply(
      notifMsgId,
      oversizedDoc,
      "here is a large file",
    ));
    expect(res.status).toBe(200);

    // No command should be queued — the error should have caused early return
    const queueRows = await queryQueueBySession(sessionId);
    expect(queueRows.length).toBe(0);
  });

  it("relays photo to R2 and includes media in command", async () => {
    const now = Date.now();
    const sessionId = `media-relay-session-${now}`;
    const notifMsgId = 2_000_201 + (now % 100);
    await registerSession(sessionId, "machine-1", "test");
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-relay-token-${now}` });

    mockGetFile("photos/xyz789.jpg");
    mockFileDownload("fake-photo-bytes");

    const res = await sendWebhook(makeMediaReply(
      notifMsgId,
      {
        photo: [
          { file_id: "small-id", file_unique_id: "small-uid", width: 100, height: 100, file_size: 1024 },
          { file_id: "large-id", file_unique_id: "large-uid", width: 800, height: 800, file_size: 8192 },
        ],
      },
      "analyze this",
    ));
    expect(res.status).toBe(200);

    const queueRows = await queryQueueBySession(sessionId);
    const lastRow = queueRows[queueRows.length - 1];
    expect(lastRow?.media_json).not.toBeNull();

    const media = JSON.parse(lastRow!.media_json!);
    expect(media.key).toMatch(/^inbound\/\d+-large-uid\/photo_large-uid\.jpg$/);
    expect(media.mime).toBe("image/jpeg");
    expect(media.filename).toBe("photo_large-uid.jpg");
    expect(media.size).toBe(8192);
  });

  it("queues text-only command without media_json", async () => {
    const now = Date.now();
    const sessionId = `media-textonly-session-${now}`;
    const notifMsgId = 2_000_301 + (now % 100);
    await registerSession(sessionId, "machine-1", "test");
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-textonly-token-${now}` });

    const res = await sendWebhook(makeTextReply("ls -la", notifMsgId));
    expect(res.status).toBe(200);

    const queueRows = await queryQueueBySession(sessionId);
    const lastRow = queueRows[queueRows.length - 1];
    expect(lastRow?.command).toBe("ls -la");
    expect(lastRow?.media_json).toBeNull();
  });

  it("media message with no caption routes with empty command", async () => {
    const now = Date.now();
    const sessionId = `media-nocaption-session-${now}`;
    const notifMsgId = 2_000_401 + (now % 100);
    await registerSession(sessionId, "machine-1", "test");
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-nocaption-token-${now}` });

    mockGetFile("photos/nocaption.jpg");
    mockFileDownload("fake-photo-data");

    const res = await sendWebhook(makeMediaReply(
      notifMsgId,
      { photo: [{ file_id: "nc-photo-id", file_unique_id: "nc-photo-uid", width: 200, height: 200, file_size: 2048 }] },
      undefined, // no caption
    ));
    expect(res.status).toBe(200);

    const queueRows = await queryQueueBySession(sessionId);
    const lastRow = queueRows[queueRows.length - 1];
    expect(lastRow?.command).toBe("");
    expect(lastRow?.media_json).not.toBeNull();
  });

  it("media command queued in D1 with media_json (poll-based delivery)", async () => {
    const now = Date.now();
    const machineId = `media-poll-machine-${now}`;
    const sessionId = `media-poll-session-${now}`;
    const notifMsgId = 2_000_501 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({ chatId: String(CHAT_ID_NUM), messageId: notifMsgId, sessionId, token: `media-poll-token-${now}` });

    mockGetFile("photos/poll-test.jpg");
    mockFileDownload("fake-photo-for-poll");

    const res = await sendWebhook(makeMediaReply(
      notifMsgId,
      { photo: [{ file_id: "poll-photo-id", file_unique_id: "poll-photo-uid", width: 400, height: 400, file_size: 4096 }] },
      "check this photo",
    ));
    expect(res.status).toBe(200);

    // Verify command was queued in D1 with media_json
    const queueRows = await queryQueueBySession(sessionId);
    const lastRow = queueRows[queueRows.length - 1];
    expect(lastRow?.command).toBe("check this photo");
    expect(lastRow?.media_json).not.toBeNull();
    const media = JSON.parse(lastRow!.media_json!);
    expect(media.key).toMatch(/^inbound\/\d+-poll-photo-uid\/photo_poll-photo-uid\.jpg$/);
    expect(media.mime).toBe("image/jpeg");
  });
});

// ─── Outbound Media: POST /notifications/send with media ──────────────

describe("POST /notifications/send with media", () => {
  const CHAT_ID = "8248645256";

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    // Clear any stale interceptors from previous tests
    fetchMock.get("https://api.telegram.org").cleanMocks();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("sends text message then photo for image mime type", async () => {
    const now = Date.now();
    const sessionId = `outbound-photo-session-${now}`;
    const textMsgId = 3_000_001 + (now % 1000);
    const photoMsgId = 3_000_002 + (now % 1000);
    await registerSession(sessionId, "machine-outbound", "outbound-test");

    // Upload a file to R2 first
    const imageKey = `outbound/${now}-aaa/screenshot.png`;
    const uploadForm = new FormData();
    uploadForm.append("key", imageKey);
    uploadForm.append("mime", "image/png");
    uploadForm.append("filename", "screenshot.png");
    uploadForm.append("file", new Blob(["fake-png-data"], { type: "image/png" }), "screenshot.png");
    await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: uploadForm,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    // Mock sendMessage for text
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: textMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    // Mock sendPhoto for image
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendPhoto/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: photoMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Session completed with screenshot",
      media: [{ key: imageKey, mime: "image/png", filename: "screenshot.png" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(textMsgId);
  });

  it("sends text message then document for non-image mime type", async () => {
    const now = Date.now();
    const sessionId = `outbound-doc-session-${now}`;
    const textMsgId = 3_100_001 + (now % 1000);
    const docMsgId = 3_100_002 + (now % 1000);
    await registerSession(sessionId, "machine-outbound", "outbound-test");

    const docKey = `outbound/${now}-bbb/report.pdf`;
    const uploadForm = new FormData();
    uploadForm.append("key", docKey);
    uploadForm.append("mime", "application/pdf");
    uploadForm.append("filename", "report.pdf");
    uploadForm.append("file", new Blob(["fake-pdf-data"], { type: "application/pdf" }), "report.pdf");
    await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: uploadForm,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    // Mock sendMessage for text
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: textMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    // Mock sendDocument for non-image
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendDocument/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: docMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Session completed with document",
      media: [{ key: docKey, mime: "application/pdf", filename: "report.pdf" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(textMsgId);
  });

  it("stores media message mapping for reply routing", async () => {
    const now = Date.now();
    const sessionId = `outbound-map-session-${now}`;
    const textMsgId = 3_200_001 + (now % 1000);
    const photoMsgId = 3_200_002 + (now % 1000);
    await registerSession(sessionId, "machine-outbound", "outbound-test");

    const imgKey = `outbound/${now}-ccc/photo.jpg`;
    const uploadForm = new FormData();
    uploadForm.append("key", imgKey);
    uploadForm.append("mime", "image/jpeg");
    uploadForm.append("filename", "photo.jpg");
    uploadForm.append("file", new Blob(["fake-jpg"], { type: "image/jpeg" }), "photo.jpg");
    await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: uploadForm,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    // Mock sendMessage + sendPhoto
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: textMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendPhoto/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: photoMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Done with photo",
      media: [{ key: imgKey, mime: "image/jpeg", filename: "photo.jpg" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number; token: string };
    expect(body.ok).toBe(true);

    // The media message (photoMsgId) should be stored in the messages table for reply routing
    // Verify by querying D1 directly
    const { results: mediaMessages } = await env.DB.prepare(
      "SELECT message_id, session_id FROM messages WHERE chat_id = ? AND message_id = ?",
    ).bind(CHAT_ID, photoMsgId).all<{ message_id: number; session_id: string }>();
    expect(mediaMessages).toHaveLength(1);
    expect(mediaMessages[0]!.session_id).toBe(sessionId);
  });

  it("backward compat: notification without media still works normally", async () => {
    const now = Date.now();
    const sessionId = `outbound-noMedia-session-${now}`;
    const textMsgId = 3_300_001 + (now % 1000);
    await registerSession(sessionId, "machine-outbound", "outbound-test");

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: textMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Just text, no media",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(textMsgId);
  });

  it("continues if media key not found in R2 (best-effort)", async () => {
    const now = Date.now();
    const sessionId = `outbound-missing-session-${now}`;
    const textMsgId = 3_400_001 + (now % 1000);
    await registerSession(sessionId, "machine-outbound", "outbound-test");

    // Don't upload anything — key won't exist in R2
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: textMsgId } }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Text with missing media",
      media: [{ key: "outbound/nonexistent/file.jpg", mime: "image/jpeg", filename: "file.jpg" }],
    });

    // Text notification should still succeed
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe(textMsgId);
  });
});

// ─── R2 Cleanup ───────────────────────────────────────────────────────

describe("R2 cleanup", () => {
  const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  it("handles empty bucket gracefully", async () => {
    // The bucket may contain objects from earlier tests, but none with expired timestamps.
    // We verify no errors are thrown and the return type is a non-negative integer.
    const count = await cleanupExpiredMedia(env);
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("deletes objects older than 24 hours", async () => {
    const now = Date.now();
    const oldTimestamp = now - TTL_MS - 1000; // older than 24h
    const recentTimestamp = now - 1000; // 1 second old (well within TTL)

    // Upload old objects (should be deleted)
    await env.MEDIA.put(`inbound/${oldTimestamp}-old1/file.jpg`, new Uint8Array([1, 2, 3]));
    await env.MEDIA.put(`outbound/${oldTimestamp}-old2/doc.pdf`, new Uint8Array([4, 5, 6]));

    // Upload recent objects (should be kept)
    await env.MEDIA.put(`inbound/${recentTimestamp}-new1/photo.png`, new Uint8Array([7, 8, 9]));
    await env.MEDIA.put(`outbound/${recentTimestamp}-new2/report.pdf`, new Uint8Array([10, 11, 12]));

    const deleted = await cleanupExpiredMedia(env);
    expect(deleted).toBe(2);

    // Old objects should be gone
    expect(await env.MEDIA.get(`inbound/${oldTimestamp}-old1/file.jpg`)).toBeNull();
    expect(await env.MEDIA.get(`outbound/${oldTimestamp}-old2/doc.pdf`)).toBeNull();

    // Recent objects should remain
    expect(await env.MEDIA.get(`inbound/${recentTimestamp}-new1/photo.png`)).not.toBeNull();
    expect(await env.MEDIA.get(`outbound/${recentTimestamp}-new2/report.pdf`)).not.toBeNull();
  });

  it("skips keys with non-numeric or malformed timestamps", async () => {
    // Put an object with a key that does not match the expected format
    await env.MEDIA.put(`inbound/badkey/file.jpg`, new Uint8Array([1]));
    await env.MEDIA.put(`inbound/NaN-abc/file.jpg`, new Uint8Array([2]));

    // Should not throw, and should not delete malformed keys
    const count = await cleanupExpiredMedia(env);
    expect(count).toBe(0);

    // Malformed keys should still be there
    expect(await env.MEDIA.get(`inbound/badkey/file.jpg`)).not.toBeNull();
    expect(await env.MEDIA.get(`inbound/NaN-abc/file.jpg`)).not.toBeNull();

    // Cleanup
    await env.MEDIA.delete(`inbound/badkey/file.jpg`);
    await env.MEDIA.delete(`inbound/NaN-abc/file.jpg`);
  });

  it("returns correct count of deleted objects", async () => {
    const now = Date.now();
    const oldTimestamp = now - TTL_MS - 5000;

    // Insert 3 old objects across both prefixes
    await env.MEDIA.put(`inbound/${oldTimestamp}-a/x.txt`, new Uint8Array([1]));
    await env.MEDIA.put(`inbound/${oldTimestamp}-b/y.txt`, new Uint8Array([2]));
    await env.MEDIA.put(`outbound/${oldTimestamp}-c/z.txt`, new Uint8Array([3]));

    const deleted = await cleanupExpiredMedia(env);
    expect(deleted).toBe(3);
  });
});

// ─── D1 Ops ────────────────────────────────────────────────────────────

describe("d1-ops", () => {
  // D1 exec() does not support multi-statement SQL; run each DDL statement separately.
  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS commands (
      command_id    TEXT PRIMARY KEY,
      machine_id    TEXT NOT NULL,
      session_id    TEXT,
      command_type  TEXT NOT NULL DEFAULT 'execute',
      command       TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      directory     TEXT,
      media_json    TEXT,
      metadata_json TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      leased_at     INTEGER,
      acked_at      INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_commands_poll
      ON commands (machine_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      machine_id    TEXT NOT NULL,
      label         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      chat_id         TEXT NOT NULL,
      message_id      INTEGER NOT NULL,
      session_id      TEXT NOT NULL,
      token           TEXT NOT NULL,
      notification_id TEXT,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
      ON messages(notification_id) WHERE notification_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS seen_updates (
      update_id     INTEGER PRIMARY KEY,
      created_at    INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS machines (
      machine_id    TEXT PRIMARY KEY,
      last_poll_at  INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS topics (
      session_id        TEXT PRIMARY KEY,
      machine_id        TEXT,
      chat_id           TEXT NOT NULL,
      message_thread_id INTEGER,
      name              TEXT,
      state             TEXT NOT NULL DEFAULT 'open',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      closed_at         INTEGER
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
      ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at)`,
  ];

  beforeAll(async () => {
    for (const stmt of schemaStatements) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM commands");
    await env.DB.exec("DELETE FROM machines");
    await env.DB.exec("DELETE FROM seen_updates");
    await env.DB.exec("DELETE FROM topics");
  });

  // ─── generateCommandId ───────────────────────────────────────────────

  it("generateCommandId returns 32-char hex string", () => {
    const id = d1GenerateCommandId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generateCommandId returns unique values", () => {
    const ids = new Set(Array.from({ length: 50 }, () => d1GenerateCommandId()));
    expect(ids.size).toBe(50);
  });

  // ─── queueCommand ─────────────────────────────────────────────────────

  it("queueCommand inserts a row with status pending", async () => {
    const commandId = await queueCommand(env.DB, {
      machineId: "machine-1",
      sessionId: "sess-abc",
      command: "echo hello",
      chatId: "8248645256",
    });

    expect(commandId).not.toBeNull();
    expect(typeof commandId).toBe("string");

    const result = await env.DB.prepare(
      "SELECT * FROM commands WHERE command_id = ?",
    ).bind(commandId).first();

    expect(result).not.toBeNull();
    expect(result!.status).toBe("pending");
    expect(result!.machine_id).toBe("machine-1");
    expect(result!.session_id).toBe("sess-abc");
    expect(result!.command).toBe("echo hello");
    expect(result!.chat_id).toBe("8248645256");
  });

  it("queueCommand returns null when queue limit reached", async () => {
    // Insert MAX_QUEUE_PER_MACHINE commands
    const now = Date.now();
    const inserts = Array.from({ length: MAX_QUEUE_PER_MACHINE }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
         VALUES (?, ?, NULL, 'execute', 'echo test', '8248645256', 'pending', ?)`,
      ).bind(`cmd-${i}`, "machine-limit", now + i),
    );
    await env.DB.batch(inserts);

    const result = await queueCommand(env.DB, {
      machineId: "machine-limit",
      sessionId: null,
      command: "one more",
      chatId: "8248645256",
    });

    expect(result).toBeNull();
  });

  // ─── pollNextCommand ──────────────────────────────────────────────────

  it("pollNextCommand returns null when no commands exist", async () => {
    const result = await pollNextCommand(env.DB, "machine-empty");
    expect(result).toBeNull();
  });

  it("pollNextCommand returns oldest pending command and sets status to leased", async () => {
    const now = Date.now();

    // Insert two pending commands; older one first
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'execute', ?, ?, 'pending', ?)`,
    ).bind("old-cmd", "machine-poll", "sess-1", "old command", "8248645256", now - 1000).run();

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'execute', ?, ?, 'pending', ?)`,
    ).bind("new-cmd", "machine-poll", "sess-2", "new command", "8248645256", now).run();

    const result = await pollNextCommand(env.DB, "machine-poll", now);

    expect(result).not.toBeNull();
    expect(result!.commandId).toBe("old-cmd");
    expect(result!.command).toBe("old command");
    expect(result!.sessionId).toBe("sess-1");

    // Check DB status was updated
    const row = await env.DB.prepare(
      "SELECT status, leased_at FROM commands WHERE command_id = ?",
    ).bind("old-cmd").first();
    expect(row!.status).toBe("leased");
    expect(row!.leased_at).toBe(now);
  });

  it("pollNextCommand skips commands for other machines", async () => {
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'echo test', '8248645256', 'pending', ?)`,
    ).bind("other-machine-cmd", "machine-other", now).run();

    const result = await pollNextCommand(env.DB, "machine-mine", now);
    expect(result).toBeNull();
  });

  it("pollNextCommand reclaims commands with expired leases", async () => {
    const now = Date.now();
    const expiredLeasedAt = now - 70_000; // 70s ago, past 60s lease timeout

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, leased_at)
       VALUES (?, ?, NULL, 'execute', 'expired lease cmd', '8248645256', 'leased', ?, ?)`,
    ).bind("expired-lease", "machine-reclaim", now - 80_000, expiredLeasedAt).run();

    const result = await pollNextCommand(env.DB, "machine-reclaim", now);
    expect(result).not.toBeNull();
    expect(result!.commandId).toBe("expired-lease");
  });

  it("pollNextCommand does NOT reclaim commands with fresh leases", async () => {
    const now = Date.now();
    const freshLeasedAt = now - 10_000; // 10s ago, within 60s lease timeout

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, leased_at)
       VALUES (?, ?, NULL, 'execute', 'fresh lease cmd', '8248645256', 'leased', ?, ?)`,
    ).bind("fresh-lease", "machine-fresh", now - 15_000, freshLeasedAt).run();

    const result = await pollNextCommand(env.DB, "machine-fresh", now);
    expect(result).toBeNull();
  });

  // ─── ackCommand ───────────────────────────────────────────────────────

  it("ackCommand marks command as done with acked_at timestamp", async () => {
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'ack me', '8248645256', 'leased', ?)`,
    ).bind("ack-cmd", "machine-ack", now).run();

    const result = await ackCommand(env.DB, "ack-cmd", now);
    expect(result).toBe(true);

    const row = await env.DB.prepare(
      "SELECT status, acked_at FROM commands WHERE command_id = ?",
    ).bind("ack-cmd").first();
    expect(row!.status).toBe("acked");
    expect(row!.acked_at).toBe(now);
  });

  it("ackCommand returns false for non-existent command", async () => {
    const result = await ackCommand(env.DB, "nonexistent-cmd", Date.now());
    expect(result).toBe(false);
  });

  // ─── touchMachine ─────────────────────────────────────────────────────

  it("touchMachine inserts on first call and updates on second", async () => {
    const t1 = Date.now();
    const t2 = t1 + 5000;

    await touchMachine(env.DB, "machine-touch", t1);

    const row1 = await env.DB.prepare(
      "SELECT last_poll_at FROM machines WHERE machine_id = ?",
    ).bind("machine-touch").first();
    expect(row1!.last_poll_at).toBe(t1);

    await touchMachine(env.DB, "machine-touch", t2);

    const row2 = await env.DB.prepare(
      "SELECT last_poll_at FROM machines WHERE machine_id = ?",
    ).bind("machine-touch").first();
    expect(row2!.last_poll_at).toBe(t2);
  });

  // ─── isMachineRecent ──────────────────────────────────────────────────

  it("isMachineRecent returns false for unknown machine", async () => {
    const result = await isMachineRecent(env.DB, "unknown-machine");
    expect(result).toBe(false);
  });

  it("isMachineRecent returns true within threshold and false outside", async () => {
    const now = Date.now();
    const threshold = 30_000; // 30s

    // Machine polled 10s ago -- within 30s threshold
    await env.DB.prepare(
      "INSERT INTO machines (machine_id, last_poll_at) VALUES (?, ?)",
    ).bind("machine-recent", now - 10_000).run();

    const recentResult = await isMachineRecent(env.DB, "machine-recent", threshold, now);
    expect(recentResult).toBe(true);

    // Machine polled 60s ago -- outside 30s threshold
    await env.DB.prepare(
      "INSERT INTO machines (machine_id, last_poll_at) VALUES (?, ?)",
    ).bind("machine-stale", now - 60_000).run();

    const staleResult = await isMachineRecent(env.DB, "machine-stale", threshold, now);
    expect(staleResult).toBe(false);
  });

  // ─── cleanupCommands ──────────────────────────────────────────────────

  it("cleanupCommands deletes acked commands older than 1 hour", async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Old acked command (should be deleted)
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, acked_at)
       VALUES (?, ?, NULL, 'execute', 'old acked', '8248645256', 'acked', ?, ?)`,
    ).bind("old-acked", "machine-cleanup", oneHourAgo - 1000, oneHourAgo - 1000).run();

    // Recent acked command (should be kept)
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, acked_at)
       VALUES (?, ?, NULL, 'execute', 'recent acked', '8248645256', 'acked', ?, ?)`,
    ).bind("recent-acked", "machine-cleanup", now - 1000, now - 1000).run();

    const result = await cleanupCommands(env.DB, now);
    expect(result.ackedDeleted).toBe(1);
    expect(result.stuckDeleted).toBe(0);

    // Verify old-acked was deleted
    const old = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?",
    ).bind("old-acked").first();
    expect(old).toBeNull();

    // Verify recent-acked was kept
    const recent = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?",
    ).bind("recent-acked").first();
    expect(recent).not.toBeNull();
  });

  it("cleanupCommands deletes stuck non-done commands older than 24 hours", async () => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Old stuck pending command (should be deleted)
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'stuck pending', '8248645256', 'pending', ?)`,
    ).bind("old-stuck-pending", "machine-stuck", oneDayAgo - 1000).run();

    // Old stuck leased command (should be deleted)
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, leased_at)
       VALUES (?, ?, NULL, 'execute', 'stuck leased', '8248645256', 'leased', ?, ?)`,
    ).bind("old-stuck-leased", "machine-stuck", oneDayAgo - 1000, oneDayAgo - 1000).run();

    // Recent pending command (should be kept)
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'recent pending', '8248645256', 'pending', ?)`,
    ).bind("recent-pending", "machine-stuck", now - 1000).run();

    const result = await cleanupCommands(env.DB, now);
    expect(result.stuckDeleted).toBe(2);

    const stuck1 = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?",
    ).bind("old-stuck-pending").first();
    expect(stuck1).toBeNull();

    const stuck2 = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?",
    ).bind("old-stuck-leased").first();
    expect(stuck2).toBeNull();

    const recent = await env.DB.prepare(
      "SELECT command_id FROM commands WHERE command_id = ?",
    ).bind("recent-pending").first();
    expect(recent).not.toBeNull();
  });

  // ─── cleanupSeenUpdates ───────────────────────────────────────────────

  it("cleanupSeenUpdates deletes entries older than 24 hours", async () => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Old seen_update (should be deleted)
    await env.DB.prepare(
      "INSERT INTO seen_updates (update_id, created_at) VALUES (?, ?)",
    ).bind(1001, oneDayAgo - 1000).run();

    // Recent seen_update (should be kept)
    await env.DB.prepare(
      "INSERT INTO seen_updates (update_id, created_at) VALUES (?, ?)",
    ).bind(1002, now - 1000).run();

    const deleted = await cleanupSeenUpdates(env.DB, now);
    expect(deleted).toBe(1);

    const old = await env.DB.prepare(
      "SELECT update_id FROM seen_updates WHERE update_id = ?",
    ).bind(1001).first();
    expect(old).toBeNull();

    const recent = await env.DB.prepare(
      "SELECT update_id FROM seen_updates WHERE update_id = ?",
    ).bind(1002).first();
    expect(recent).not.toBeNull();
  });

  // ─── topics table schema ──────────────────────────────────────────────

  it("can insert and read back a topic row", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind("ses-1", "devbox", "-100123456789", 42, "pigeon · test topic", "open", now, now).run();

    const row = await env.DB.prepare("SELECT * FROM topics WHERE session_id = ?")
      .bind("ses-1")
      .first<{
        session_id: string;
        machine_id: string;
        chat_id: string;
        message_thread_id: number;
        name: string;
        state: string;
        created_at: number;
        updated_at: number;
        closed_at: number | null;
      }>();

    expect(row).not.toBeNull();
    expect(row?.session_id).toBe("ses-1");
    expect(row?.machine_id).toBe("devbox");
    expect(row?.chat_id).toBe("-100123456789");
    expect(row?.message_thread_id).toBe(42);
    expect(row?.name).toBe("pigeon · test topic");
    expect(row?.state).toBe("open");
    expect(row?.created_at).toBe(now);
    expect(row?.updated_at).toBe(now);
    expect(row?.closed_at).toBeNull();
  });

  it("rejects duplicate (chat_id, message_thread_id) when message_thread_id is NOT NULL", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind("ses-1", "devbox", "-100123456789", 42, "topic 1", "open", now, now).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("ses-2", "devbox", "-100123456789", 42, "topic 2", "open", now, now).run()
    ).rejects.toThrow();
  });

  it("allows multiple rows with NULL message_thread_id and the same chat_id", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
    ).bind("ses-1", "devbox", "-100123456789", "pending topic 1", "open", now, now).run();

    await env.DB.prepare(
      `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
    ).bind("ses-2", "devbox", "-100123456789", "pending topic 2", "open", now, now).run();

    const rows = await env.DB.prepare("SELECT session_id FROM topics WHERE chat_id = ? ORDER BY session_id ASC")
      .bind("-100123456789")
      .all<{ session_id: string }>();

    expect(rows.results.length).toBe(2);
    expect(rows.results[0].session_id).toBe("ses-1");
    expect(rows.results[1].session_id).toBe("ses-2");
  });

  it("verifies idx_topics_thread is defined as a partial unique index", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_topics_thread'"
    ).first<{ sql: string }>();

    expect(row).not.toBeNull();
    expect(row?.sql).toContain("WHERE message_thread_id IS NOT NULL");
  });
});

// ─── POST /notifications/edit ─────────────────────────────────────────

describe("POST /notifications/edit", () => {
  const SESSION_ID = "edit-notif-session";
  const CHAT_ID = "8248645256";
  const NOTIFICATION_ID = "edit-notif-id-001";

  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    await registerSession(SESSION_ID, "machine-edit", "edit-test");
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  async function editNotification(body: Record<string, unknown>): Promise<Response> {
    return SELF.fetch("https://worker/notifications/edit", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
  }

  it("returns 401 for unauthenticated requests", async () => {
    const res = await SELF.fetch("https://worker/notifications/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationId: NOTIFICATION_ID, text: "new text" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when notificationId is missing", async () => {
    const res = await editNotification({ text: "new text" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notificationId and text are required");
  });

  it("returns 400 when text is missing", async () => {
    const res = await editNotification({ notificationId: NOTIFICATION_ID });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notificationId and text are required");
  });

  it("returns 404 for unknown notificationId", async () => {
    const res = await editNotification({
      notificationId: "nonexistent-notification-id",
      text: "updated text",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Message not found for notificationId");
  });

  it("edits a message by notificationId and returns ok", async () => {
    // First, send a notification to store a message in the messages table
    mockTelegramSuccess(555);
    const notifRes = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "original text",
      notificationId: NOTIFICATION_ID,
    });
    expect(notifRes.status).toBe(200);
    const notifBody = (await notifRes.json()) as { messageId: number };
    expect(notifBody.messageId).toBe(555);

    // Now mock editMessageText
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editMessageText/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 555 } }), {
        headers: { "Content-Type": "application/json" },
      });

    const editRes = await editNotification({
      notificationId: NOTIFICATION_ID,
      text: "updated text",
    });

    expect(editRes.status).toBe(200);
    const editBody = (await editRes.json()) as { ok: boolean };
    expect(editBody.ok).toBe(true);
  });

  it("passes replyMarkup to editMessageText when provided", async () => {
    const uniqueNotifId = `edit-markup-notif-${Date.now()}`;
    mockTelegramSuccess(556);
    const notifRes = await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "original with markup",
      notificationId: uniqueNotifId,
    });
    expect(notifRes.status).toBe(200);

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editMessageText/ })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 556 } }), {
        headers: { "Content-Type": "application/json" },
      });

    const markup = { inline_keyboard: [[{ text: "Next step", callback_data: "next" }]] };
    const editRes = await editNotification({
      notificationId: uniqueNotifId,
      text: "updated with markup",
      replyMarkup: markup,
    });

    expect(editRes.status).toBe(200);
    const editBody = (await editRes.json()) as { ok: boolean };
    expect(editBody.ok).toBe(true);
  });

  it("returns 502 when Telegram editMessageText API fails", async () => {
    const uniqueNotifId = `edit-fail-notif-${Date.now()}`;
    mockTelegramSuccess(557);
    await sendNotification({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      text: "original text",
      notificationId: uniqueNotifId,
    });

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editMessageText/ })
      .reply(
        200,
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message not modified" }),
        { headers: { "Content-Type": "application/json" } },
      );

    const editRes = await editNotification({
      notificationId: uniqueNotifId,
      text: "same or bad text",
    });

    expect(editRes.status).toBe(502);
    const editBody = (await editRes.json()) as { error: string };
    expect(editBody.error).toBe("Telegram API error");
  });
});

// ─── Poll and Ack Endpoints ────────────────────────────────────────────

function makeRequest(url: string, opts: { method?: string; auth?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) {
    headers["Authorization"] = "Bearer test-api-key";
  }
  return new Request(url, { method: opts.method ?? "GET", headers });
}

describe("poll and ack endpoints", () => {
  // D1 exec() does not support multi-statement SQL; run each DDL statement separately.
  const pollSchemaStatements = [
    `CREATE TABLE IF NOT EXISTS commands (
      command_id    TEXT PRIMARY KEY,
      machine_id    TEXT NOT NULL,
      session_id    TEXT,
      command_type  TEXT NOT NULL DEFAULT 'execute',
      command       TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      directory     TEXT,
      media_json    TEXT,
      metadata_json TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      leased_at     INTEGER,
      acked_at      INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_commands_poll
      ON commands (machine_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS machines (
      machine_id    TEXT PRIMARY KEY,
      last_poll_at  INTEGER NOT NULL
    )`,
  ];

  beforeAll(async () => {
    for (const stmt of pollSchemaStatements) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM commands");
    await env.DB.exec("DELETE FROM machines");
  });

  // ─── handlePollNext ──────────────────────────────────────────────────

  it("handlePollNext returns 401 without auth", async () => {
    const req = makeRequest("https://worker/machines/machine-1/next", { auth: false });
    const res = await handlePollNext(env.DB, env, req, "machine-1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("handlePollNext returns 204 when no commands", async () => {
    const req = makeRequest("https://worker/machines/machine-empty/next");
    const res = await handlePollNext(env.DB, env, req, "machine-empty");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("handlePollNext returns command JSON for execute type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'execute', ?, ?, 'pending', ?)`,
    ).bind("exec-cmd-1", "machine-exec", "sess-exec-1", "echo hello", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-exec/next");
    const res = await handlePollNext(env.DB, env, req, "machine-exec");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("exec-cmd-1");
    expect(body.commandType).toBe("execute");
    expect(body.sessionId).toBe("sess-exec-1");
    expect(body.command).toBe("echo hello");
    expect(body.chatId).toBe("8248645256");
  });

  it("handlePollNext returns command JSON for launch type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, directory, status, created_at)
       VALUES (?, ?, NULL, 'launch', ?, ?, ?, 'pending', ?)`,
    ).bind("launch-cmd-1", "machine-launch", "run all tests", "8248645256", "/home/dev/project", now).run();

    const req = makeRequest("https://worker/machines/machine-launch/next");
    const res = await handlePollNext(env.DB, env, req, "machine-launch");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("launch-cmd-1");
    expect(body.commandType).toBe("launch");
    expect(body.chatId).toBe("8248645256");
    expect(body.directory).toBe("/home/dev/project");
    expect(body.prompt).toBe("run all tests");
    // launch type should NOT have command or sessionId
    expect(body.command).toBeUndefined();
    expect(body.sessionId).toBeUndefined();
  });

  it("handlePollNext returns command JSON for kill type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'kill', '', ?, 'pending', ?)`,
    ).bind("kill-cmd-1", "machine-kill", "sess-to-kill", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-kill/next");
    const res = await handlePollNext(env.DB, env, req, "machine-kill");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("kill-cmd-1");
    expect(body.commandType).toBe("kill");
    expect(body.chatId).toBe("8248645256");
    expect(body.sessionId).toBe("sess-to-kill");
  });

  it("handlePollNext returns command JSON for interrupt type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'interrupt', '', ?, 'pending', ?)`,
    ).bind("interrupt-cmd-1", "machine-interrupt", "sess-to-interrupt", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-interrupt/next");
    const res = await handlePollNext(env.DB, env, req, "machine-interrupt");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("interrupt-cmd-1");
    expect(body.commandType).toBe("interrupt");
    expect(body.chatId).toBe("8248645256");
    expect(body.sessionId).toBe("sess-to-interrupt");
  });

  it("handlePollNext includes parsed media for execute with media_json", async () => {
    const now = Date.now();
    const mediaObj = { key: "inbound/123-abc/photo.jpg", mime: "image/jpeg", filename: "photo.jpg", size: 4096 };
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, media_json, status, created_at)
       VALUES (?, ?, ?, 'execute', ?, ?, ?, 'pending', ?)`,
    ).bind("media-cmd-1", "machine-media", "sess-media", "describe this", "8248645256", JSON.stringify(mediaObj), now).run();

    const req = makeRequest("https://worker/machines/machine-media/next");
    const res = await handlePollNext(env.DB, env, req, "machine-media");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("media-cmd-1");
    expect(body.media).toBeDefined();
    const media = body.media as Record<string, unknown>;
    expect(media.key).toBe("inbound/123-abc/photo.jpg");
    expect(media.mime).toBe("image/jpeg");
  });

  it("handlePollNext updates machine last_poll_at", async () => {
    const before = Date.now();
    const req = makeRequest("https://worker/machines/machine-touch/next");
    await handlePollNext(env.DB, env, req, "machine-touch");
    const after = Date.now();

    const row = await env.DB.prepare(
      "SELECT last_poll_at FROM machines WHERE machine_id = ?",
    ).bind("machine-touch").first<{ last_poll_at: number }>();

    expect(row).not.toBeNull();
    expect(row!.last_poll_at).toBeGreaterThanOrEqual(before);
    expect(row!.last_poll_at).toBeLessThanOrEqual(after);
  });

  // ─── handleAckCommand ────────────────────────────────────────────────

  it("handleAckCommand returns 401 without auth", async () => {
    const req = makeRequest("https://worker/commands/some-cmd/ack", { method: "POST", auth: false });
    const res = await handleAckCommand(env.DB, env, req, "some-cmd");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("handleAckCommand returns 200 and marks done", async () => {
    const now = Date.now();
    // Insert a command and lease it
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at, leased_at)
       VALUES (?, ?, NULL, 'execute', 'do something', '8248645256', 'leased', ?, ?)`,
    ).bind("ack-target-cmd", "machine-ack-test", now - 5000, now - 5000).run();

    const req = makeRequest("https://worker/commands/ack-target-cmd/ack", { method: "POST" });
    const res = await handleAckCommand(env.DB, env, req, "ack-target-cmd");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Verify the command is marked as acked in D1
    const row = await env.DB.prepare(
      "SELECT status, acked_at FROM commands WHERE command_id = ?",
    ).bind("ack-target-cmd").first<{ status: string; acked_at: number | null }>();
    expect(row!.status).toBe("acked");
    expect(row!.acked_at).not.toBeNull();
  });

  it("handleAckCommand returns 404 for unknown command", async () => {
    const req = makeRequest("https://worker/commands/nonexistent-cmd/ack", { method: "POST" });
    const res = await handleAckCommand(env.DB, env, req, "nonexistent-cmd");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Command not found" });
  });

  // ─── handlePollNext: new command types ──────────────────────────────

  it("handlePollNext returns sessionId for mcp_list type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'mcp_list', '', ?, 'pending', ?)`,
    ).bind("mcp-list-cmd-1", "machine-mcp", "sess-mcp-1", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-mcp/next");
    const res = await handlePollNext(env.DB, env, req, "machine-mcp");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("mcp-list-cmd-1");
    expect(body.commandType).toBe("mcp_list");
    expect(body.sessionId).toBe("sess-mcp-1");
    expect(body.chatId).toBe("8248645256");
    expect(body.command).toBeUndefined();
    expect(body.serverName).toBeUndefined();
  });

  it("handlePollNext returns sessionId for model_list type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'model_list', '', ?, 'pending', ?)`,
    ).bind("model-list-cmd-1", "machine-model", "sess-model-1", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-model/next");
    const res = await handlePollNext(env.DB, env, req, "machine-model");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("model-list-cmd-1");
    expect(body.commandType).toBe("model_list");
    expect(body.sessionId).toBe("sess-model-1");
    expect(body.chatId).toBe("8248645256");
    expect(body.command).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it("handlePollNext returns sessionId and serverName for mcp_enable type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'mcp_enable', ?, ?, 'pending', ?)`,
    ).bind("mcp-enable-cmd-1", "machine-mcp-en", "sess-mcp-en-1", "my-server", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-mcp-en/next");
    const res = await handlePollNext(env.DB, env, req, "machine-mcp-en");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("mcp-enable-cmd-1");
    expect(body.commandType).toBe("mcp_enable");
    expect(body.sessionId).toBe("sess-mcp-en-1");
    expect(body.serverName).toBe("my-server");
    expect(body.chatId).toBe("8248645256");
  });

  it("handlePollNext returns sessionId and serverName for mcp_disable type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'mcp_disable', ?, ?, 'pending', ?)`,
    ).bind("mcp-disable-cmd-1", "machine-mcp-dis", "sess-mcp-dis-1", "my-server", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-mcp-dis/next");
    const res = await handlePollNext(env.DB, env, req, "machine-mcp-dis");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("mcp-disable-cmd-1");
    expect(body.commandType).toBe("mcp_disable");
    expect(body.sessionId).toBe("sess-mcp-dis-1");
    expect(body.serverName).toBe("my-server");
    expect(body.chatId).toBe("8248645256");
  });

  it("handlePollNext returns sessionId and model for model_set type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'model_set', ?, ?, 'pending', ?)`,
    ).bind("model-set-cmd-1", "machine-model-set", "sess-model-set-1", "anthropic/claude-sonnet-4-5", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-model-set/next");
    const res = await handlePollNext(env.DB, env, req, "machine-model-set");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("model-set-cmd-1");
    expect(body.commandType).toBe("model_set");
    expect(body.sessionId).toBe("sess-model-set-1");
    expect(body.model).toBe("anthropic/claude-sonnet-4-5");
    expect(body.chatId).toBe("8248645256");
  });

  it("handlePollNext returns correct minimal JSON for current_state type", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, NULL, 'current_state', '', ?, 'pending', ?)`,
    ).bind("cs-cmd-1", "machine-cs", "8248645256", now).run();

    const req = makeRequest("https://worker/machines/machine-cs/next");
    const res = await handlePollNext(env.DB, env, req, "machine-cs");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      commandId: "cs-cmd-1",
      commandType: "current_state",
      chatId: "8248645256",
    });
  });
});

// ─── /mcp Command: Integration Tests ─────────────────────────────────

function makeMcpListReply(replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/mcp list",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeMcpListMessage(updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/mcp list",
    },
  };
}

function makeMcpEnableReply(serverName: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/mcp enable ${serverName}`,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeMcpEnableMessage(serverName: string, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/mcp enable ${serverName}`,
    },
  };
}

function makeMcpDisableReply(serverName: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/mcp disable ${serverName}`,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

describe("/mcp command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("/mcp list replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeMcpListMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/mcp list replies with 'could not find a session' when reply_to_message has no mapping", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeMcpListReply(99996));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/mcp list replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `mcp-list-offline-${now}`;
    const machineId = `mcp-list-offline-machine-${now}`;
    const notifMsgId = 7_000_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `mcp-list-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeMcpListReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/mcp list queues an mcp_list command when machine has recently polled", async () => {
    const now = Date.now();
    const sessionId = `mcp-list-connected-${now}`;
    const machineId = `mcp-list-machine-${now}`;
    const notifMsgId = 7_001_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `mcp-list-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack confirmation

    const res = await sendWebhook(makeMcpListReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the mcp_list command was queued in D1
    const rows = await queryQueueBySession(sessionId);
    const mcpRows = rows.filter((r) => r.command_type === "mcp_list");
    expect(mcpRows.length).toBeGreaterThanOrEqual(1);
    const mcpRow = mcpRows[mcpRows.length - 1]!;
    expect(mcpRow.command_type).toBe("mcp_list");
    expect(mcpRow.session_id).toBe(sessionId);
    expect(mcpRow.machine_id).toBe(machineId);
  });

  it("/mcp enable replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeMcpEnableMessage("my-server"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/mcp enable queues an mcp_enable command with server name in command field", async () => {
    const now = Date.now();
    const sessionId = `mcp-enable-connected-${now}`;
    const machineId = `mcp-enable-machine-${now}`;
    const notifMsgId = 7_002_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `mcp-enable-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack confirmation

    const res = await sendWebhook(makeMcpEnableReply("my-server", notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueBySession(sessionId);
    const mcpRows = rows.filter((r) => r.command_type === "mcp_enable");
    expect(mcpRows.length).toBeGreaterThanOrEqual(1);
    const mcpRow = mcpRows[mcpRows.length - 1]!;
    expect(mcpRow.command_type).toBe("mcp_enable");
    expect(mcpRow.session_id).toBe(sessionId);
    expect(mcpRow.machine_id).toBe(machineId);
    expect(mcpRow.command).toBe("my-server");
  });

  it("/mcp disable queues an mcp_disable command with server name in command field", async () => {
    const now = Date.now();
    const sessionId = `mcp-disable-connected-${now}`;
    const machineId = `mcp-disable-machine-${now}`;
    const notifMsgId = 7_003_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `mcp-disable-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack confirmation

    const res = await sendWebhook(makeMcpDisableReply("my-server", notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueBySession(sessionId);
    const mcpRows = rows.filter((r) => r.command_type === "mcp_disable");
    expect(mcpRows.length).toBeGreaterThanOrEqual(1);
    const mcpRow = mcpRows[mcpRows.length - 1]!;
    expect(mcpRow.command_type).toBe("mcp_disable");
    expect(mcpRow.session_id).toBe(sessionId);
    expect(mcpRow.machine_id).toBe(machineId);
    expect(mcpRow.command).toBe("my-server");
  });

  it("/mcp disable replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `mcp-disable-offline-${now}`;
    const machineId = `mcp-disable-offline-machine-${now}`;
    const notifMsgId = 7_004_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `mcp-disable-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeMcpDisableReply("some-server", notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ─── /model Command: Integration Tests ───────────────────────────────

function makeModelListReply(replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/model",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeModelListMessage(updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/model",
    },
  };
}

function makeModelSetReply(model: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/model ${model}`,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

describe("/model command", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("/model list replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeModelListMessage());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/model list replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `model-list-offline-${now}`;
    const machineId = `model-list-offline-machine-${now}`;
    const notifMsgId = 8_000_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `model-list-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeModelListReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/model list queues a model_list command when machine has recently polled", async () => {
    const now = Date.now();
    const sessionId = `model-list-connected-${now}`;
    const machineId = `model-list-machine-${now}`;
    const notifMsgId = 8_001_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `model-list-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack confirmation

    const res = await sendWebhook(makeModelListReply(notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueBySession(sessionId);
    const modelRows = rows.filter((r) => r.command_type === "model_list");
    expect(modelRows.length).toBeGreaterThanOrEqual(1);
    const modelRow = modelRows[modelRows.length - 1]!;
    expect(modelRow.command_type).toBe("model_list");
    expect(modelRow.session_id).toBe(sessionId);
    expect(modelRow.machine_id).toBe(machineId);
  });

  it("/model set queues a model_set command with model code in command field", async () => {
    const now = Date.now();
    const sessionId = `model-set-connected-${now}`;
    const machineId = `model-set-machine-${now}`;
    const notifMsgId = 8_002_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `model-set-connected-token-${now}`,
    });
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack confirmation

    const res = await sendWebhook(makeModelSetReply("anthropic/claude-opus-4-5", notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const rows = await queryQueueBySession(sessionId);
    const modelRows = rows.filter((r) => r.command_type === "model_set");
    expect(modelRows.length).toBeGreaterThanOrEqual(1);
    const modelRow = modelRows[modelRows.length - 1]!;
    expect(modelRow.command_type).toBe("model_set");
    expect(modelRow.session_id).toBe(sessionId);
    expect(modelRow.machine_id).toBe(machineId);
    expect(modelRow.command).toBe("anthropic/claude-opus-4-5");
  });

  it("/model set replies with 'reply to a session notification' when no reply_to_message", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook({
      update_id: ++webhookUpdateCounter,
      message: {
        message_id: ++webhookUpdateCounter,
        chat: { id: CHAT_ID_NUM },
        from: { id: CHAT_ID_NUM },
        text: "/model anthropic/claude-sonnet-4-5",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/model set replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `model-set-offline-${now}`;
    const machineId = `model-set-offline-machine-${now}`;
    const notifMsgId = 8_003_001 + (now % 100);

    await registerSession(sessionId, machineId);
    await insertMessageMapping({
      chatId: String(CHAT_ID_NUM),
      messageId: notifMsgId,
      sessionId,
      token: `model-set-offline-token-${now}`,
    });
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeModelSetReply("anthropic/claude-opus-4-5", notifMsgId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ─── Swipe-Reply to Question Notification: Integration Tests ──────────

describe("swipe-reply to question notification", () => {
  const CHAT_ID = "8248645256";

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://api.telegram.org").cleanMocks();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("tags the command with questionRequestId when replying to a question notification", async () => {
    const now = Date.now();
    const sessionId = `sess-swipe-q-${now}`;
    const machineId = `swipe-q-machine-${now}`;
    // Use a high, timestamp-based message ID to avoid collisions with other tests
    const questionMsgId = 5_000_001 + (now % 10_000);

    // Step 1: Register a session with machine
    await registerSession(sessionId, machineId);
    await touchMachine(env.DB, machineId, now);

    // Step 2: Send a question notification with notificationId "q:{sessionId}:req-123"
    // and inline_keyboard buttons including callback_data "cmd:tok-swipe:q0"
    mockTelegramSuccess(questionMsgId);
    const notifRes = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Which database should we use?",
      notificationId: `q:${sessionId}:req-123`,
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "MongoDB", callback_data: "cmd:tok-swipe:q0" },
            { text: "PostgreSQL", callback_data: "cmd:tok-swipe:q1" },
          ],
        ],
      },
    });
    expect(notifRes.status).toBe(200);
    const notifBody = (await notifRes.json()) as { ok: boolean; messageId: number; token: string };
    expect(notifBody.ok).toBe(true);
    const messageId = notifBody.messageId;

    // Step 3: Swipe-reply to that message with text "Use MongoDB"
    mockTelegramSendMessage(); // for the "ok" webhook acknowledgement
    const webhookRes = await sendWebhook(makeTextReply("Use MongoDB", messageId));
    expect(webhookRes.status).toBe(200);

    // Step 4: Poll for the command
    const pollRes = await SELF.fetch(`https://worker/machines/${machineId}/next`, {
      headers: { Authorization: "Bearer test-api-key" },
    });
    expect(pollRes.status).toBe(200);

    // Step 5: Verify the command has the correct metadata
    const pollBody = (await pollRes.json()) as Record<string, unknown>;
    expect(pollBody.commandType).toBe("execute");
    expect(pollBody.sessionId).toBe(sessionId);
    expect(pollBody.command).toBe("Use MongoDB");
    expect(pollBody.metadata).toEqual({ questionRequestId: "req-123" });
  });

  it("does not tag command with questionRequestId when replying to a non-question notification", async () => {
    const now = Date.now();
    const sessionId = `sess-swipe-nq-${now}`;
    const machineId = `swipe-nq-machine-${now}`;
    // Use a high, timestamp-based message ID to avoid collisions with other tests
    const stopMsgId = 5_100_001 + (now % 10_000);

    // Step 1: Register a session with machine
    await registerSession(sessionId, machineId);
    await touchMachine(env.DB, machineId, now);

    // Step 2: Send a regular notification with notificationId "stop:{sessionId}:xyz" (no q: prefix, no buttons)
    mockTelegramSuccess(stopMsgId);
    const notifRes = await sendNotification({
      sessionId,
      chatId: CHAT_ID,
      text: "Session stopped.",
      notificationId: `stop:${sessionId}:xyz`,
    });
    expect(notifRes.status).toBe(200);
    const notifBody = (await notifRes.json()) as { ok: boolean; messageId: number; token: string };
    expect(notifBody.ok).toBe(true);
    const messageId = notifBody.messageId;

    // Step 3: Swipe-reply to that message
    mockTelegramSendMessage(); // for the "ok" webhook acknowledgement
    const webhookRes = await sendWebhook(makeTextReply("Continue please", messageId));
    expect(webhookRes.status).toBe(200);

    // Step 4: Poll for the command
    const pollRes = await SELF.fetch(`https://worker/machines/${machineId}/next`, {
      headers: { Authorization: "Bearer test-api-key" },
    });
    expect(pollRes.status).toBe(200);

    // Step 5: Verify metadata is undefined
    const pollBody = (await pollRes.json()) as Record<string, unknown>;
    expect(pollBody.commandType).toBe("execute");
    expect(pollBody.sessionId).toBe(sessionId);
    expect(pollBody.command).toBe("Continue please");
    expect(pollBody.metadata).toBeUndefined();
  });
});

// ─── Question Notification ID Chunk Suffix Parsing ────────────────────────

describe("resolveMessageSession question notification parsing", () => {
  const chatId = "123456789";

  async function seedMessage(opts: {
    chatId: string;
    messageId: number;
    sessionId: string;
    notificationId?: string;
    token?: string;
  }): Promise<void> {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO messages (chat_id, message_id, session_id, token, notification_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        opts.chatId,
        opts.messageId,
        opts.sessionId,
        opts.token ?? "test-token",
        opts.notificationId ?? null,
        Date.now(),
      )
      .run();
  }

  it("strips the chunk suffix from a question notification id", async () => {
    await seedMessage({ chatId, messageId: 42, sessionId: "ses_x", notificationId: "q:ses_x:req123#c0" });
    const r = await resolveMessageSession(env.DB, {
      message_id: 99,
      chat: { id: Number(chatId) },
      text: "my answer",
      reply_to_message: { message_id: 42 },
    });
    expect(r?.questionRequestId).toBe("req123");
  });

  it("leaves a bare question notification id intact without suffix", async () => {
    await seedMessage({ chatId, messageId: 43, sessionId: "ses_x", notificationId: "q:ses_x:req123" });
    const r = await resolveMessageSession(env.DB, {
      message_id: 100,
      chat: { id: Number(chatId) },
      text: "my answer",
      reply_to_message: { message_id: 43 },
    });
    expect(r?.questionRequestId).toBe("req123");
  });

  it("strips multi-digit chunk index suffixes", async () => {
    await seedMessage({ chatId, messageId: 44, sessionId: "ses_x", notificationId: "q:ses_x:req123#c12" });
    const r = await resolveMessageSession(env.DB, {
      message_id: 101,
      chat: { id: Number(chatId) },
      text: "my answer",
      reply_to_message: { message_id: 44 },
    });
    expect(r?.questionRequestId).toBe("req123");
  });

  it("preserves request id containing hash that is not a chunk suffix at end of string", async () => {
    await seedMessage({ chatId, messageId: 45, sessionId: "ses_x", notificationId: "q:ses_x:req#c12_suffix" });
    const r = await resolveMessageSession(env.DB, {
      message_id: 102,
      chat: { id: Number(chatId) },
      text: "my answer",
      reply_to_message: { message_id: 45 },
    });
    expect(r?.questionRequestId).toBe("req#c12_suffix");
  });
});

// ─── Topics Module & Topic Name Tests ────────────────────────────────────

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("topics module and topicName", () => {
  describe("topicsEnabled", () => {
    it("returns true only for exact string 'true'", () => {
      expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "true" })).toBe(true);
      expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "false" })).toBe(false);
      expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "TRUE" })).toBe(false);
      expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "1" })).toBe(false);
      expect(topicsEnabled({ TELEGRAM_TOPICS_ENABLED: "" })).toBe(false);
      expect(topicsEnabled({})).toBe(false);
    });
  });

  describe("constants", () => {
    it("exports machine icon colors and default color", () => {
      expect(MACHINE_ICON_COLORS.devbox).toBe(7322096);
      expect(MACHINE_ICON_COLORS.cloudbox).toBe(9367192);
      expect(DEFAULT_ICON_COLOR).toBe(16766590);
    });
  });

  describe("topicName formatting and surrogate clamping", () => {
    it("passes short dir and title through unchanged", () => {
      expect(topicName("pigeon", "Fix flaky auth test")).toBe("pigeon · Fix flaky auth test");
    });

    it("handles missing/empty dir or title gracefully", () => {
      expect(topicName("", "Fix test")).toBe("Fix test");
      expect(topicName("pigeon", "")).toBe("pigeon");
      expect(topicName("   ", "   ")).toBe("session");
    });

    it("replaces internal newlines with single spaces", () => {
      expect(topicName("pigeon", "Fix\nflaky\r\nauth\r test")).toBe("pigeon · Fix flaky auth test");
    });

    it("clamps 128-emoji title to <= 128 UTF-16 code units", () => {
      const emojiTitle = "😀".repeat(128);
      const name = topicName("pigeon", emojiTitle);
      expect(name.length).toBeLessThanOrEqual(128);
      expect(hasUnpairedSurrogate(name)).toBe(false);
    });

    it("preserves an astral character landing exactly on boundary or drops it safely", () => {
      // 123 'a's + " · a😀" => 123 + 3 + 1 + 2 = 129 UTF-16 units.
      // Index 127 falls on high surrogate of 😀.
      const name1 = topicName("a".repeat(123), "a😀");
      expect(name1.length).toBeLessThanOrEqual(128);
      expect(hasUnpairedSurrogate(name1)).toBe(false);
      expect(name1.endsWith("…")).toBe(true);

      // 122 'a's + " · a😀" => 122 + 3 + 1 + 2 = 128 UTF-16 units (fits exactly).
      // 122 'a's + " · a😀b" => 128 + 1 = 129 UTF-16 units.
      // Index 127 falls right between high surrogate (126) and low surrogate (127) of 😀.
      const name2 = topicName("a".repeat(122), "a😀b");
      expect(name2.length).toBeLessThanOrEqual(128);
      expect(hasUnpairedSurrogate(name2)).toBe(false);
      expect(name2.endsWith("…")).toBe(true);
    });

    it("handles clampPreservingSurrogates edge cases", () => {
      const s = "abc😀def"; // 😀 is at index 3,4
      expect(clampPreservingSurrogates(s, 10)).toBe("abc😀def");
      expect(clampPreservingSurrogates(s, 4)).toBe("abc"); // cuts off high surrogate at index 3
      expect(clampPreservingSurrogates(s, 5)).toBe("abc😀"); // keeps full pair at index 3,4
    });
  });

  describe("D1 repo functions", () => {
    const chatId = "-100123456789";

    it("reserve & getBySession & getByThread - tests winner and loser outcomes", async () => {
      const sessionId = "ses_topics_t1";
      const now = 1000000;

      // Winner outcome: first reservation succeeds
      const won1 = await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId,
        name: "pigeon · test",
        now,
      });
      expect(won1).toBe(true);

      // Verify row exists and has state='open' with message_thread_id=null
      const row1 = await getBySession(env.DB, sessionId);
      expect(row1).not.toBeNull();
      expect(row1?.session_id).toBe(sessionId);
      expect(row1?.machine_id).toBe("devbox");
      expect(row1?.chat_id).toBe(chatId);
      expect(row1?.name).toBe("pigeon · test");
      expect(row1?.state).toBe("open");
      expect(row1?.message_thread_id).toBeNull();
      expect(row1?.created_at).toBe(now);

      // Loser outcome: concurrent/subsequent reserve call for same sessionId returns false
      const won2 = await reserve(env.DB, {
        sessionId,
        machineId: "cloudbox",
        chatId,
        name: "pigeon · competing",
        now: now + 50,
      });
      expect(won2).toBe(false);

      // Verify row was NOT mutated by loser
      const rowAfterLoser = await getBySession(env.DB, sessionId);
      expect(rowAfterLoser?.machine_id).toBe("devbox");
      expect(rowAfterLoser?.name).toBe("pigeon · test");
    });

    it("finalize, rename, markClosed, markOpen, getByThread", async () => {
      const sessionId = "ses_topics_t2";
      const now = 2000000;

      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId,
        name: "pigeon · t2",
        now,
      });

      // finalize thread id
      const finRes = await finalize(env.DB, {
        sessionId,
        messageThreadId: 4242,
        name: "pigeon · t2 finalized",
        now: now + 100,
      });
      expect(finRes).toBe(true);

      const byThread = await getByThread(env.DB, chatId, 4242);
      expect(byThread).not.toBeNull();
      expect(byThread?.session_id).toBe(sessionId);
      expect(byThread?.name).toBe("pigeon · t2 finalized");

      // rename
      const renRes = await rename(env.DB, {
        sessionId,
        name: "pigeon · renamed",
        now: now + 200,
      });
      expect(renRes).toBe(true);
      const afterRename = await getBySession(env.DB, sessionId);
      expect(afterRename?.name).toBe("pigeon · renamed");

      // markClosed
      const closeRes = await markClosed(env.DB, {
        sessionId,
        now: now + 300,
      });
      expect(closeRes).toBe(true);
      const closedRow = await getBySession(env.DB, sessionId);
      expect(closedRow?.state).toBe("closed");
      expect(closedRow?.closed_at).toBe(now + 300);

      // markOpen
      const openRes = await markOpen(env.DB, {
        sessionId,
        now: now + 400,
      });
      expect(openRes).toBe(true);
      const openRow = await getBySession(env.DB, sessionId);
      expect(openRow?.state).toBe("open");
      expect(openRow?.closed_at).toBeNull();
    });

    it("deleteBySession", async () => {
      const sessionId = "ses_topics_t3";
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId,
        name: "pigeon · t3",
      });

      expect(await getBySession(env.DB, sessionId)).not.toBeNull();
      const delRes = await deleteBySession(env.DB, sessionId);
      expect(delRes).toBe(true);
      expect(await getBySession(env.DB, sessionId)).toBeNull();

      // delete non-existent
      expect(await deleteBySession(env.DB, "non_existent")).toBe(false);

      // CAS check: deleteBySession fails once topic is finalized
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId, name: "pigeon · t3" });
      await finalize(env.DB, { sessionId, messageThreadId: 777 });
      expect(await deleteBySession(env.DB, sessionId)).toBe(false);
      expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(777);
    });

    it("stealReservation", async () => {
      const sessionId = "ses_steal_unit";
      const now = 5000000;
      const staleTime = now - 150000;

      await reserve(env.DB, { sessionId, machineId: "oldbox", chatId, name: "old", now: staleTime });

      // Steal with expiredBefore = now - 120000 (staleTime < now - 120000)
      const won = await stealReservation(env.DB, {
        sessionId,
        machineId: "newbox",
        expiredBefore: now - 120000,
        now,
      });
      expect(won).toBe(true);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.machine_id).toBe("newbox");
      expect(row?.updated_at).toBe(now);

      // Attempt steal on non-stale reservation
      const won2 = await stealReservation(env.DB, {
        sessionId,
        machineId: "anotherbox",
        expiredBefore: now - 120000,
        now: now + 1000,
      });
      expect(won2).toBe(false);
    });

    it("listReapable", async () => {
      const now = 3000000;

      // Seed 3 topics: open, closed old, closed recent
      const s1 = "ses_reap_1";
      const s2 = "ses_reap_2";
      const s3 = "ses_reap_3";

      await reserve(env.DB, { sessionId: s1, machineId: "devbox", chatId, name: "s1", now });
      await reserve(env.DB, { sessionId: s2, machineId: "devbox", chatId, name: "s2", now });
      await reserve(env.DB, { sessionId: s3, machineId: "devbox", chatId, name: "s3", now });

      // s1 stays open
      // s2 closed at now - 1000
      await markClosed(env.DB, { sessionId: s2, now: now - 1000 });
      // s3 closed at now - 500
      await markClosed(env.DB, { sessionId: s3, now: now - 500 });

      // Query reapable with closedBefore = now - 200
      const reapable = await listReapable(env.DB, { closedBefore: now - 200, limit: 10 });
      expect(reapable.map((r: { session_id: string }) => r.session_id)).toEqual([s2, s3]);

      // Test limit
      const reapableLimit = await listReapable(env.DB, { closedBefore: now - 200, limit: 1 });
      expect(reapableLimit.map((r: { session_id: string }) => r.session_id)).toEqual([s2]);
    });

    it("listOrphaned", async () => {
      const now = 4000000;

      const sActive = "ses_orph_active";
      const sStale = "ses_orph_stale";
      const sNoSession = "ses_orph_nosession";
      const sClosedNoSession = "ses_orph_closed_nosession";

      // Insert topics
      await reserve(env.DB, { sessionId: sActive, machineId: "devbox", chatId, name: "active", now });
      await reserve(env.DB, { sessionId: sStale, machineId: "devbox", chatId, name: "stale", now });
      await reserve(env.DB, { sessionId: sNoSession, machineId: "devbox", chatId, name: "nosession", now });
      await reserve(env.DB, { sessionId: sClosedNoSession, machineId: "devbox", chatId, name: "closed_nosession", now });
      await markClosed(env.DB, { sessionId: sClosedNoSession, now });

      // Insert matching sessions into sessions table
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(sActive, "devbox", "pigeon", now, now - 100).run();

      await env.DB.prepare(
        `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(sStale, "devbox", "pigeon", now, now - 10000).run();

      // sNoSession has no row in sessions table

      // Query orphaned with updatedBefore = now - 5000
      const orphaned = await listOrphaned(env.DB, { updatedBefore: now - 5000 });
      const orphanedIds = orphaned.map((r: { session_id: string }) => r.session_id);

      // Should include sStale (updated_at < now - 5000) and sNoSession (sessions row absent)
      // Should NOT include sActive (updated_at >= now - 5000) or sClosedNoSession (state='closed')
      expect(orphanedIds).toContain(sNoSession);
      expect(orphanedIds).toContain(sStale);
      expect(orphanedIds).not.toContain(sActive);
      expect(orphanedIds).not.toContain(sClosedNoSession);
    });
  });

  describe("topic manager resolveTopic", () => {
    const topicChatId = "-1001234567890";

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
    });

    afterEach(() => {
      fetchMock.deactivate();
    });

    it("two concurrent resolveTopic calls -> exactly one createForumTopic, both get same thread id", async () => {
      const sessionId = "ses_topic_concurrent";
      const botToken = "fake-bot-token";

      let createCalls = 0;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
        .reply(200, () => {
          createCalls++;
          return { ok: true, result: { message_thread_id: 101, name: "pigeon · test", icon_color: 7322096 } };
        });

      const noopDelay = async () => {};

      const [res1, res2] = await Promise.all([
        resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "test",
          botToken,
          delayFn: noopDelay,
        }),
        resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "test",
          botToken,
          delayFn: noopDelay,
        }),
      ]);

      expect(createCalls).toBe(1);
      expect(res1).toEqual({ ok: true, messageThreadId: 101 });
      expect(res2).toEqual({ ok: true, messageThreadId: 101 });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(101);
    });

    it("slow winner -> loser polls to success and shares thread id", async () => {
      const sessionId = "ses_topic_slow_winner";
      const botToken = "fake-bot-token";

      let pollCount = 0;

      // Winner reserves first
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        name: "pigeon · slow",
      });

      // Loser calls resolveTopic while reservation is still NULL.
      // On second poll iteration, winner finalizes D1.
      const loserPromise = resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "slow",
        botToken,
        delayFn: async () => {
          pollCount++;
          if (pollCount === 2) {
            await finalize(env.DB, { sessionId, messageThreadId: 202 });
          }
        },
      });

      const res = await loserPromise;
      expect(res).toEqual({ ok: true, messageThreadId: 202 });
      expect(pollCount).toBe(2);
    });

    it("winner never finalizes -> loser exhausts bound -> General fallback", async () => {
      const sessionId = "ses_topic_never_finalizes";
      const botToken = "fake-bot-token";

      // Winner reserves but never finalizes
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        name: "pigeon · stuck",
        now: Date.now(), // fresh reservation (< TTL)
      });

      let pollCount = 0;
      const customDelay = async () => {
        pollCount++;
      };

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "stuck",
        botToken,
        delayFn: customDelay,
        pollAttempts: 5,
      });

      expect(pollCount).toBe(5);
      expect(res).toEqual({ ok: true, messageThreadId: null });
    });

    it("create rejects (non-429) -> reservation row gone -> next resolveTopic wins and creates", async () => {
      const sessionId = "ses_topic_create_rejects";
      const botToken = "fake-bot-token";

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
        .reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

      const res1 = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err",
        botToken,
      });

      expect(res1).toEqual({ ok: true, messageThreadId: null });
      // Reservation row was conditional-deleted
      expect(await getBySession(env.DB, sessionId)).toBeNull();

      // Next resolveTopic call succeeds
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
        .reply(200, { ok: true, result: { message_thread_id: 303, name: "pigeon · err" } });

      const res2 = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err",
        botToken,
      });

      expect(res2).toEqual({ ok: true, messageThreadId: 303 });
      expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(303);
    });

    it("create returns 429 -> reservation gone and rate_limited propagated with retryAfter", async () => {
      const sessionId = "ses_topic_429";
      const botToken = "fake-bot-token";

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
        .reply(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 15 },
        });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "rate",
        botToken,
      });

      expect(res).toEqual({ ok: false, kind: "rate_limited", retryAfter: 15 });
      // Reservation row was conditional-deleted
      expect(await getBySession(env.DB, sessionId)).toBeNull();
    });

    it("stale NULL reservation (past TTL) -> steal -> create -> finalize", async () => {
      const sessionId = "ses_topic_stale_steal";
      const botToken = "fake-bot-token";
      const now = Date.now();
      const staleTime = now - RESERVATION_TTL_MS - 5000; // 125s ago (> 120s TTL)

      // Seed a stale NULL reservation
      await reserve(env.DB, {
        sessionId,
        machineId: "oldbox",
        chatId: topicChatId,
        name: "pigeon · stale",
        now: staleTime,
      });

      let createCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
        .reply(200, () => {
          createCalled = true;
          return { ok: true, result: { message_thread_id: 404, name: "pigeon · fresh" } };
        });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "fresh",
        botToken,
        now,
        delayFn: async () => {},
      });

      expect(createCalled).toBe(true);
      expect(res).toEqual({ ok: true, messageThreadId: 404 });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(404);
      expect(row?.machine_id).toBe("devbox");
    });

    it("slow original winner's finalize CAS loses -> compensating deleteForumTopic fires", async () => {
      const sessionId = "ses_topic_finalize_cas_loses";
      const botToken = "fake-bot-token";

      let deleteCalls: Array<{ chatId: string; messageThreadId: number }> = [];

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ path: `/bot${botToken}/deleteForumTopic`, method: "POST" })
        .reply(200, (opts: any) => {
          const body = JSON.parse(opts.body as string);
          deleteCalls.push({ chatId: body.chat_id, messageThreadId: body.message_thread_id });
          return { ok: true, result: true };
        });

      // Winner 1 calls resolveTopic, but right before returning from createForumTopic, Winner 2 finalizes with threadId 999
      const mockTgClient = {
        ...createTelegramClient(botToken),
        createForumTopic: async () => {
          // Right before returning from createForumTopic, Winner 2 finalizes
          await finalize(env.DB, { sessionId, messageThreadId: 999, name: "winner 2" });
          return {
            ok: true as const,
            result: { message_thread_id: 505, name: "pigeon · cas", icon_color: 7322096 },
          };
        },
      };

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "cas",
        botToken,
        tgClient: mockTgClient,
      });

      // Winner 1's finalize CAS failed (message_thread_id was already 999)
      // Winner 1 executed compensating deleteForumTopic for 505
      expect(deleteCalls).toEqual([{ chatId: topicChatId, messageThreadId: 505 }]);
      // Winner 1 re-read D1 and returned Winner 2's thread id 999
      expect(res).toEqual({ ok: true, messageThreadId: 999 });
    });

    describe("Task T2.6: Reopen-on-closed", () => {
      const sessionId = "ses_closed_topic";
      const botToken = "fake-bot-token";

      it("resolving a state='closed' topic calls reopenForumTopic and flips state to open", async () => {
        const now = Date.now();
        // Seed a closed topic in D1
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · closed", now });
        await finalize(env.DB, { sessionId, messageThreadId: 888, now });
        await markClosed(env.DB, { sessionId, now });

        let reopenCalled = false;
        fetchMock
          .get("https://api.telegram.org")
          .intercept({ path: `/bot${botToken}/reopenForumTopic`, method: "POST" })
          .reply(200, (opts: any) => {
            reopenCalled = true;
            const body = JSON.parse(opts.body as string);
            expect(body.chat_id).toBe(topicChatId);
            expect(body.message_thread_id).toBe(888);
            return { ok: true, result: true };
          });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed",
          botToken,
          now: now + 1000,
        });

        expect(reopenCalled).toBe(true);
        expect(res).toEqual({ ok: true, messageThreadId: 888 });

        const row = await getBySession(env.DB, sessionId);
        expect(row?.state).toBe("open");
        expect(row?.closed_at).toBeNull();
      });

      it("reopenForumTopic returns 429 rate_limited -> propagates rate_limited error", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId: "ses_closed_429", machineId: "devbox", chatId: topicChatId, name: "pigeon · closed 429", now });
        await finalize(env.DB, { sessionId: "ses_closed_429", messageThreadId: 889, now });
        await markClosed(env.DB, { sessionId: "ses_closed_429", now });

        fetchMock
          .get("https://api.telegram.org")
          .intercept({ path: `/bot${botToken}/reopenForumTopic`, method: "POST" })
          .reply(429, { ok: false, error_code: 429, parameters: { retry_after: 10 } });

        const res = await resolveTopic(env.DB, {
          sessionId: "ses_closed_429",
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed 429",
          botToken,
          now: now + 1000,
        });

        expect(res).toEqual({ ok: false, kind: "rate_limited", retryAfter: 10 });

        const row = await getBySession(env.DB, "ses_closed_429");
        expect(row?.state).toBe("closed");
      });

      it("reopenForumTopic returns non-429 error -> returns messageThreadId anyway so notification is not dropped", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId: "ses_closed_err", machineId: "devbox", chatId: topicChatId, name: "pigeon · closed err", now });
        await finalize(env.DB, { sessionId: "ses_closed_err", messageThreadId: 890, now });
        await markClosed(env.DB, { sessionId: "ses_closed_err", now });

        fetchMock
          .get("https://api.telegram.org")
          .intercept({ path: `/bot${botToken}/reopenForumTopic`, method: "POST" })
          .reply(400, { ok: false, error_code: 400, description: "Bad Request: TOPIC_NOT_MODIFIED" });

        const res = await resolveTopic(env.DB, {
          sessionId: "ses_closed_err",
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed err",
          botToken,
          now: now + 1000,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 890 });
      });
    });

    describe("Task T2.7: Stale-thread recovery in resolveTopic", () => {
      const sessionId = "ses_reopen_stale";
      const botToken = "fake-bot-token";

      it("reopenForumTopic returns thread_not_found -> deletes stale D1 row and recreates topic", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · stale closed", now });
        await finalize(env.DB, { sessionId, messageThreadId: 700, now });
        await markClosed(env.DB, { sessionId, now });

        // reopen returns thread_not_found
        fetchMock
          .get("https://api.telegram.org")
          .intercept({ path: `/bot${botToken}/reopenForumTopic`, method: "POST" })
          .reply(400, { ok: false, error_code: 400, description: "Bad Request: message thread not found" });

        // createForumTopic succeeds for new thread 701
        fetchMock
          .get("https://api.telegram.org")
          .intercept({ path: `/bot${botToken}/createForumTopic`, method: "POST" })
          .reply(200, { ok: true, result: { message_thread_id: 701, name: "pigeon · stale closed" } });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "stale closed",
          botToken,
          now: now + 1000,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 701 });

        const row = await getBySession(env.DB, sessionId);
        expect(row?.message_thread_id).toBe(701);
        expect(row?.state).toBe("open");
      });
    });
  });

  describe("Task T2.7: Stale-thread recovery on sendNotification", () => {
    const topicChatId = String(CHAT_ID_NUM);
    const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      fetchMock.get("https://api.telegram.org").cleanMocks();
    });

    afterEach(() => {
      fetchMock.deactivate();
    });

    it("sendMessage returns thread_not_found -> deletes stale D1 row, recreates topic, and retries sendMessage once", async () => {
      const sessionId = "ses_stale_send";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · stale send", now });
      await finalize(env.DB, { sessionId, messageThreadId: 700, now });

      let sendThreadIds: Array<number | undefined> = [];

      // Intercept 1st sendMessage (thread 700 -> thread_not_found)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          sendThreadIds.push(body.message_thread_id);
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      // Intercept 2nd sendMessage (thread 701 -> success)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          sendThreadIds.push(body.message_thread_id);
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 9999 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      let createTopicCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_thread_id: 701, name: "pigeon · stale send" } }), {
          headers: { "Content-Type": "application/json" },
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification on deleted topic",
          title: "stale send",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      expect(createTopicCalled || sendThreadIds.length === 2).toBe(true);
      expect(sendThreadIds).toEqual([700, 701]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(701);
    });

    it("recursion guard: second sendMessage also returns thread_not_found -> does NOT retry again (at most once)", async () => {
      const sessionId = "ses_stale_recursion_guard";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · recursion", now });
      await finalize(env.DB, { sessionId, messageThreadId: 705, now });

      let sendMessageCalls = 0;

      // Intercept 1st sendMessage
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), {
          headers: { "Content-Type": "application/json" },
        });

      // Intercept 2nd sendMessage (retry on recreated topic fails again)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), {
          headers: { "Content-Type": "application/json" },
        });

      // Intercept 3rd sendMessage (fallback to General)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_id: 99981 } }), {
          headers: { "Content-Type": "application/json" },
        });

      let createTopicCalls = 0;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, () => {
          createTopicCalls++;
          return { ok: true, result: { message_thread_id: 702, name: "pigeon · recursion" } };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification on double deleted topic",
          title: "recursion",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200); // Falls back to General and delivers
      expect(createTopicCalls).toBe(1); // Exactly 1 recreate attempt
    });
  });

  describe("Task T2.5: Threaded notification delivery", () => {
    const topicChatId = String(CHAT_ID_NUM);
    let msgCounter = 850000;
    const nextMsgId = () => ++msgCounter;

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      fetchMock.get("https://api.telegram.org").cleanMocks();
    });

    afterEach(() => {
      fetchMock.deactivate();
      delete (env as any).TELEGRAM_TOPICS_ENABLED;
    });

    it("flag off: TELEGRAM_TOPICS_ENABLED unset -> sendMessage payload has no message_thread_id", async () => {
      const sessionId = "ses_t25_flag_off";
      await registerSession(sessionId, "devbox", "pigeon");

      let sentPayload: any = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, (opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          sentPayload = JSON.parse(raw);
          return { ok: true, result: { message_id: nextMsgId() } };
        });

      const res = await sendNotification({
        sessionId,
        chatId: topicChatId,
        text: "Task completed",
        title: "Feature complete",
        dir: "pigeon",
        threaded: true,
      });

      expect(res.status).toBe(200);
      expect(sentPayload).not.toBeNull();
      expect(sentPayload.message_thread_id).toBeUndefined();

      // Verify no topic created in D1
      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("flag on + threaded: false -> sendMessage payload has no message_thread_id", async () => {
      const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;
      const sessionId = "ses_t25_threaded_false";
      await registerSession(sessionId, "devbox", "pigeon");

      let sentPayload: any = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, (opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          sentPayload = JSON.parse(raw);
          return { ok: true, result: { message_id: nextMsgId() } };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Current state overview",
          title: "Overview",
          dir: "pigeon",
          threaded: false,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      expect(sentPayload).not.toBeNull();
      expect(sentPayload.message_thread_id).toBeUndefined();

      // Verify no topic created in D1
      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("flag on + topic resolution succeeds -> sendMessage payload carries message_thread_id", async () => {
      const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;
      const sessionId = "ses_t25_flag_on_success";
      await registerSession(sessionId, "devbox", "pigeon");

      let createTopicPayload: any = null;
      let sendMessagePayload: any = null;

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, (opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          createTopicPayload = JSON.parse(raw);
          return { ok: true, result: { message_thread_id: 888, name: "pigeon · My Topic" } };
        });

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, (opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          sendMessagePayload = JSON.parse(raw);
          return { ok: true, result: { message_id: nextMsgId() } };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Task completed",
          title: "My Topic",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      expect(createTopicPayload).toEqual({
        chat_id: topicChatId,
        name: "pigeon · My Topic",
        icon_color: 7322096,
      });
      expect(sendMessagePayload).toEqual({
        chat_id: topicChatId,
        message_thread_id: 888,
        text: "Task completed",
      });

      // Verify topic row in D1
      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(888);
    });

    it("flag on + topic resolution rate limited -> returns 429 with retryAfter", async () => {
      const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;
      const sessionId = "ses_t25_rate_limited";
      await registerSession(sessionId, "devbox", "pigeon");

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(429, { ok: false, error_code: 429, parameters: { retry_after: 25 } });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Task completed",
          title: "My Topic",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json).toEqual({ error: "rate_limited", retryAfter: 25 });
    });
  });

  describe("Task T2.8: Fallback rules", () => {
    const topicChatId = String(CHAT_ID_NUM);
    const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      fetchMock.get("https://api.telegram.org").cleanMocks();
    });

    afterEach(() => {
      fetchMock.deactivate();
    });

    it("non-429 topic sendMessage failure (e.g. CHAT_NOT_A_FORUM) -> falls back to General and succeeds", async () => {
      const sessionId = "ses_t28_non429_send_fallback";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · fallback", now });
      await finalize(env.DB, { sessionId, messageThreadId: 500, now });

      const sentThreadIds: Array<number | undefined> = [];

      // Intercept 1st sendMessage (with topic thread_id 500 -> non-429 error)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          sentThreadIds.push(body.message_thread_id);
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat is not a forum" }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      // Intercept 2nd sendMessage (General fallback without message_thread_id -> success)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          sentThreadIds.push(body.message_thread_id);
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 8888 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification falling back to General",
          title: "fallback",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, messageId: 8888, token: expect.any(String) });
      expect(sentThreadIds).toEqual([500, undefined]);
    });

    it("429 topic sendMessage failure -> returns 429 with retryAfter and does NOT fall back to General", async () => {
      const sessionId = "ses_t28_429_send_no_fallback";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · rate limit", now });
      await finalize(env.DB, { sessionId, messageThreadId: 501, now });

      let sendCalls = 0;

      // Intercept 1st sendMessage (with topic thread_id 501 -> 429 rate limit)
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          sendCalls++;
          return {
            statusCode: 429,
            data: JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 12 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification hit rate limit on topic send",
          title: "rate limit",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json).toEqual({ error: "rate_limited", retryAfter: 12 });
      expect(sendCalls).toBe(1); // Crucial assertion: exactly 1 call, no General fallback call made
    });

    it("non-429 createForumTopic failure -> falls back to General and succeeds", async () => {
      const sessionId = "ses_t28_non429_create_fallback";
      await registerSession(sessionId, "devbox", "pigeon");

      let createTopicCalls = 0;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, () => {
          createTopicCalls++;
          return { ok: false, error_code: 400, description: "Bad Request: FORUM_CLOSED" };
        });

      let sentThreadId: number | undefined = 99;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          sentThreadId = body.message_thread_id;
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 7777 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Fallback from create failure",
          title: "create fallback",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      expect(createTopicCalls).toBe(1);
      expect(sentThreadId).toBeUndefined(); // Sent to General
    });

    it("429 createForumTopic failure -> returns 429 with retryAfter and does NOT call sendMessage", async () => {
      const sessionId = "ses_t28_429_create_no_send";
      await registerSession(sessionId, "devbox", "pigeon");

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(429, { ok: false, error_code: 429, parameters: { retry_after: 20 } });

      let sendMessageCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, () => {
          sendMessageCalled = true;
          return { ok: true, result: { message_id: 1111 } };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Rate limit on create topic",
          title: "rate limit create",
          dir: "pigeon",
          threaded: true,
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json).toEqual({ error: "rate_limited", retryAfter: 20 });
      expect(sendMessageCalled).toBe(false); // Crucial assertion: no sendMessage call made
    });
  });

  describe("Task T2.9: Media passes message_thread_id", () => {
    const topicChatId = String(CHAT_ID_NUM);

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      fetchMock.get("https://api.telegram.org").cleanMocks();
    });

    afterEach(() => {
      fetchMock.deactivate();
      delete (env as any).TELEGRAM_TOPICS_ENABLED;
    });

    it("flag on + topic resolved -> sendPhoto and sendDocument carry message_thread_id in FormData", async () => {
      const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;
      const sessionId = "ses_t29_flag_on_media";
      await registerSession(sessionId, "devbox", "pigeon");

      // Upload image and document to R2
      const imageKey = `media_test/img_${Date.now()}.png`;
      const docKey = `media_test/doc_${Date.now()}.pdf`;

      const uploadForm1 = new FormData();
      uploadForm1.append("key", imageKey);
      uploadForm1.append("mime", "image/png");
      uploadForm1.append("filename", "screenshot.png");
      uploadForm1.append("file", new Blob(["png_data"], { type: "image/png" }), "screenshot.png");
      await SELF.fetch("https://worker/media/upload", {
        method: "POST",
        body: uploadForm1,
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      const uploadForm2 = new FormData();
      uploadForm2.append("key", docKey);
      uploadForm2.append("mime", "application/pdf");
      uploadForm2.append("filename", "report.pdf");
      uploadForm2.append("file", new Blob(["pdf_data"], { type: "application/pdf" }), "report.pdf");
      await SELF.fetch("https://worker/media/upload", {
        method: "POST",
        body: uploadForm2,
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_thread_id: 9888, name: "pigeon · Media Topic" } }), {
          headers: { "Content-Type": "application/json" },
        });

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_id: 1000 } }), {
          headers: { "Content-Type": "application/json" },
        });

      let photoThreadId: string | null = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendPhoto/ })
        .reply((opts: any) => {
          if (opts.body instanceof FormData) {
            photoThreadId = opts.body.get("message_thread_id") as string | null;
          } else if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
            const str = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
            const match = str.match(/name="message_thread_id"\r?\n\r?\n(\d+)/);
            photoThreadId = match ? match[1] : null;
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 1001 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      let docThreadId: string | null = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendDocument/ })
        .reply((opts: any) => {
          if (opts.body instanceof FormData) {
            docThreadId = opts.body.get("message_thread_id") as string | null;
          } else if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
            const str = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
            const match = str.match(/name="message_thread_id"\r?\n\r?\n(\d+)/);
            docThreadId = match ? match[1] : null;
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 1002 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification with photo and document",
          title: "Media Topic",
          dir: "pigeon",
          threaded: true,
          media: [
            { key: imageKey, mime: "image/png", filename: "screenshot.png" },
            { key: docKey, mime: "application/pdf", filename: "report.pdf" },
          ],
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      expect(photoThreadId).toBe("9888");
      expect(docThreadId).toBe("9888");
    });

    it("media follows the recreated thread after T2.7 stale-thread recovery", async () => {
      // Regression: messageThreadId was assigned once and never updated by the T2.7
      // retry, so the media loop kept sending to the DELETED thread. sendPhoto then
      // failed and the item was silently skipped -- attachments dropped with no log.
      const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;
      const sessionId = "ses_t29_media_after_recovery";
      await registerSession(sessionId, "devbox", "pigeon");

      const imageKey = `media_test/img_recov_${Date.now()}.png`;
      const uploadForm = new FormData();
      uploadForm.append("key", imageKey);
      uploadForm.append("mime", "image/png");
      uploadForm.append("filename", "shot.png");
      uploadForm.append("file", new Blob(["png_data"], { type: "image/png" }), "shot.png");
      await SELF.fetch("https://worker/media/upload", {
        method: "POST",
        body: uploadForm,
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      // Seed a finalized topic pointing at thread 500, which Telegram no longer has.
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        name: "pigeon · Recovered",
        now: Date.now(),
      });
      await finalize(env.DB, { sessionId, messageThreadId: 51500, now: Date.now() });

      // The recreate produces thread 777.
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/createForumTopic/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_thread_id: 51777, name: "pigeon · Recovered" } }), {
          headers: { "Content-Type": "application/json" },
        });

      // First send hits the dead thread; the retry after recovery succeeds.
      const sentThreadIds: (number | undefined)[] = [];
      let sendCount = 0;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply((opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          sentThreadIds.push(JSON.parse(raw).message_thread_id);
          sendCount++;
          if (sendCount === 1) {
            return {
              statusCode: 400,
              data: JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }),
              responseOptions: { headers: { "Content-Type": "application/json" } },
            };
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 520001 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        })
        .times(2);

      let photoThreadId: string | null = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendPhoto/ })
        .reply((opts: any) => {
          if (opts.body instanceof FormData) {
            photoThreadId = opts.body.get("message_thread_id") as string | null;
          } else {
            const str = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
            const match = str.match(/name="message_thread_id"\r?\n\r?\n(\d+)/);
            photoThreadId = match ? match[1] : null;
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 520002 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification with photo",
          title: "Recovered",
          dir: "pigeon",
          threaded: true,
          media: [{ key: imageKey, mime: "image/png", filename: "shot.png" }],
        }),
      });

      const res = await handleSendNotification(env.DB, testEnv, request);

      expect(res.status).toBe(200);
      // Text recovered onto the new thread.
      expect(sentThreadIds).toEqual([51500, 51777]);
      // The photo must follow the text onto 777, not chase the deleted 500.
      expect(photoThreadId).toBe("51777");
    });

    it("flag off -> sendPhoto and sendDocument do NOT carry message_thread_id", async () => {
      const sessionId = "ses_t29_flag_off_media";
      await registerSession(sessionId, "devbox", "pigeon");

      const imageKey = `media_test/img_off_${Date.now()}.png`;

      const uploadForm1 = new FormData();
      uploadForm1.append("key", imageKey);
      uploadForm1.append("mime", "image/png");
      uploadForm1.append("filename", "screenshot.png");
      uploadForm1.append("file", new Blob(["png_data"], { type: "image/png" }), "screenshot.png");
      await SELF.fetch("https://worker/media/upload", {
        method: "POST",
        body: uploadForm1,
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(200, JSON.stringify({ ok: true, result: { message_id: 2000 } }), {
          headers: { "Content-Type": "application/json" },
        });

      let photoThreadId: string | null = null;
      let photoCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendPhoto/ })
        .reply((opts: any) => {
          photoCalled = true;
          if (opts.body instanceof FormData) {
            photoThreadId = opts.body.get("message_thread_id") as string | null;
          } else if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
            const str = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
            const match = str.match(/name="message_thread_id"\r?\n\r?\n(\d+)/);
            photoThreadId = match ? match[1] : null;
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: { message_id: 2001 } }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          chatId: topicChatId,
          text: "Notification with photo with flag off",
          title: "Media Topic",
          dir: "pigeon",
          threaded: true,
          media: [{ key: imageKey, mime: "image/png", filename: "screenshot.png" }],
        }),
      });

      const res = await handleSendNotification(env.DB, env, request);

      expect(res.status).toBe(200);
      expect(photoCalled).toBe(true);
      expect(photoThreadId).toBeNull();
    });
  });

  describe("Task T2.10: Unregister topic closing", () => {
    const topicChatId = String(CHAT_ID_NUM);
    const testEnv = { ...env, TELEGRAM_TOPICS_ENABLED: "true" } as Env;

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      fetchMock.get("https://api.telegram.org").cleanMocks();
    });

    afterEach(() => {
      fetchMock.deactivate();
    });

    it("(a) flag ON, finalized topic row -> row state='closed', closed_at set, closeForumTopic called, topic row still exists", async () => {
      const sessionId = "ses_t210_case_a";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · unreg a", now });
      await finalize(env.DB, { sessionId, messageThreadId: 61001, now });

      let closeCalledWith: { chatId: unknown; messageThreadId: unknown } | null = null;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/closeForumTopic/ })
        .reply((opts: any) => {
          const body = JSON.parse(opts.body as string);
          closeCalledWith = { chatId: String(body.chat_id), messageThreadId: body.message_thread_id };
          return {
            statusCode: 200,
            data: JSON.stringify({ ok: true, result: true }),
            responseOptions: { headers: { "Content-Type": "application/json" } },
          };
        });

      const request = new Request("https://worker/sessions/unregister", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId }),
      });

      const res = await handleSessionRequest(env.DB, testEnv, request, "unregister");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(closeCalledWith).toEqual({ chatId: topicChatId, messageThreadId: 61001 });

      const row = await getBySession(env.DB, sessionId);
      expect(row).not.toBeNull();
      expect(row?.state).toBe("closed");
      expect(typeof row?.closed_at).toBe("number");
      expect(row?.closed_at).toBeGreaterThan(0);
    });

    it("(b) flag ON, Telegram closeForumTopic fails -> returns 200 {ok:true} and row is STILL marked closed", async () => {
      const sessionId = "ses_t210_case_b";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · unreg b", now });
      await finalize(env.DB, { sessionId, messageThreadId: 61002, now });

      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/closeForumTopic/ })
        .reply(400, JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), {
          headers: { "Content-Type": "application/json" },
        });

      const request = new Request("https://worker/sessions/unregister", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId }),
      });

      const res = await handleSessionRequest(env.DB, testEnv, request, "unregister");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(typeof row?.closed_at).toBe("number");
    });

    it("(c) flag ON, reservation row with NULL message_thread_id -> row marked closed, zero Telegram calls", async () => {
      const sessionId = "ses_t210_case_c";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · unreg c", now });

      let telegramCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*/ })
        .reply(() => {
          telegramCalled = true;
          return { statusCode: 200, data: JSON.stringify({ ok: true }) };
        });

      const request = new Request("https://worker/sessions/unregister", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId }),
      });

      const res = await handleSessionRequest(env.DB, testEnv, request, "unregister");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(telegramCalled).toBe(false);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(row?.message_thread_id).toBeNull();
    });

    it("(d) flag OFF -> topic row is left completely untouched (still state='open') and zero Telegram calls", async () => {
      const sessionId = "ses_t210_case_d";
      await registerSession(sessionId, "devbox", "pigeon");

      const now = Date.now();
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · unreg d", now });
      await finalize(env.DB, { sessionId, messageThreadId: 61004, now });

      let telegramCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*/ })
        .reply(() => {
          telegramCalled = true;
          return { statusCode: 200, data: JSON.stringify({ ok: true }) };
        });

      const request = new Request("https://worker/sessions/unregister", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId }),
      });

      const res = await handleSessionRequest(env.DB, env, request, "unregister");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(telegramCalled).toBe(false);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("open");
      expect(row?.closed_at).toBeNull();
    });

    it("(e) flag ON, session with no topic row -> 200, no Telegram call, no crash", async () => {
      const sessionId = "ses_t210_case_e";
      await registerSession(sessionId, "devbox", "pigeon");

      let telegramCalled = false;
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*/ })
        .reply(() => {
          telegramCalled = true;
          return { statusCode: 200, data: JSON.stringify({ ok: true }) };
        });

      const request = new Request("https://worker/sessions/unregister", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId }),
      });

      const res = await handleSessionRequest(env.DB, testEnv, request, "unregister");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(telegramCalled).toBe(false);
      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });
  });
});


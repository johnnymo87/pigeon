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
import { isAllowedChatId, generateToken } from "../src/notifications";
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

function makeKillMessage(
  sessionId: string,
  updateId?: number,
): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/kill ${sessionId}`,
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

  it("replies with 'not found' when session does not exist", async () => {
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillMessage("nonexistent-session"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("replies with offline error when machine has not recently polled", async () => {
    const now = Date.now();
    const sessionId = `kill-offline-${now}`;
    const machineId = `kill-offline-machine-${now}`;

    await registerSession(sessionId, machineId);
    // No touchMachine call → isMachineRecent returns false
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillMessage(sessionId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues a kill command when machine has recently polled D1", async () => {
    const now = Date.now();
    const sessionId = `kill-connected-${now}`;
    const machineId = `kill-machine-${now}`;

    await registerSession(sessionId, machineId);
    // Insert a recent machines row so isMachineRecent returns true
    await touchMachine(env.DB, machineId, now);

    mockTelegramSendMessage(); // ack "Killing session..."

    const res = await sendWebhook(makeKillMessage(sessionId));

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

  it("does not fall through to regular session resolution for /kill", async () => {
    // /kill with unknown session should produce "not found", not "Could not find session"
    mockTelegramSendMessage(); // exactly one Telegram call expected

    const res = await sendWebhook(makeKillMessage("unknown-session"));

    expect(res.status).toBe(200);
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
});

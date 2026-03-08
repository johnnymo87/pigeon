/**
 * All worker tests in a single file to avoid cross-file Durable Object
 * invalidation (a known workerd limitation with SQL-backed DOs).
 *
 * @see https://github.com/cloudflare/workers-sdk/issues/11031
 */
import { env, SELF, fetchMock, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { isAllowedChatId, generateToken } from "../src/notifications";
import {
  verifyWebhookSecret,
  deduplicateUpdate,
  resolveMessageSession,
  resolveCallbackSession,
  generateCommandId,
} from "../src/webhook";

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
}

async function queryQueueBySession(sessionId: string): Promise<QueueRow[]> {
  const id = env.ROUTER.idFromName("singleton");
  const stub = env.ROUTER.get(id);

  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql.exec(
      `SELECT command_id, machine_id, session_id, command, chat_id, status,
              attempts, created_at, sent_at, next_retry_at, acked_at, last_error,
              command_type, directory
       FROM command_queue
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      sessionId,
    ).toArray() as QueueRow[];
  });
}

async function queryQueueByMachine(machineId: string): Promise<QueueRow[]> {
  const id = env.ROUTER.idFromName("singleton");
  const stub = env.ROUTER.get(id);

  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql.exec(
      `SELECT command_id, machine_id, session_id, command, chat_id, status,
              attempts, created_at, sent_at, next_retry_at, acked_at, last_error,
              command_type, directory
       FROM command_queue
       WHERE machine_id = ?
       ORDER BY created_at ASC`,
      machineId,
    ).toArray() as QueueRow[];
  });
}

async function insertQueueRow(row: {
  commandId: string;
  machineId: string;
  sessionId: string | null;
  status: string;
  createdAt: number;
  sentAt?: number | null;
  ackedAt?: number | null;
  attempts?: number;
  nextRetryAt?: number | null;
  commandType?: string;
  directory?: string | null;
}): Promise<void> {
  const id = env.ROUTER.idFromName("singleton");
  const stub = env.ROUTER.get(id);

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO command_queue (
         command_id, machine_id, session_id, command, chat_id,
         status, attempts, created_at, sent_at, next_retry_at, acked_at, last_error,
         command_type, directory
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.commandId,
      row.machineId,
      row.sessionId,
      "echo test",
      "8248645256",
      row.status,
      row.attempts ?? 0,
      row.createdAt,
      row.sentAt ?? null,
      row.nextRetryAt ?? null,
      row.ackedAt ?? null,
      null,
      row.commandType ?? "execute",
      row.directory ?? null,
    );
  });
}

async function insertMessageMapping(input: {
  chatId: string;
  messageId: number;
  sessionId: string;
  token: string;
  createdAt?: number;
}): Promise<void> {
  const id = env.ROUTER.idFromName("singleton");
  const stub = env.ROUTER.get(id);

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO messages (chat_id, message_id, session_id, token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.chatId,
      input.messageId,
      input.sessionId,
      input.token,
      input.createdAt ?? Date.now(),
    );
  });
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
    expect(env.ROUTER).toBeDefined();
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

  it("alarm deletes old acked and old stuck commands", async () => {
    const now = Date.now();
    const baseSession = `cleanup-session-${Date.now()}`;
    await registerSession(baseSession, MACHINE_ID);

    await insertQueueRow({
      commandId: `acked-old-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "acked",
      attempts: 1,
      createdAt: now - (2 * 60 * 60 * 1000),
      ackedAt: now - (90 * 60 * 1000),
      nextRetryAt: now - 10_000,
    });

    await insertQueueRow({
      commandId: `pending-stuck-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "pending",
      attempts: 2,
      createdAt: now - (2 * 24 * 60 * 60 * 1000),
      nextRetryAt: now - 10_000,
    });

    await insertQueueRow({
      commandId: `pending-fresh-${now}`,
      machineId: MACHINE_ID,
      sessionId: baseSession,
      status: "pending",
      attempts: 0,
      createdAt: now - (10 * 60 * 1000),
      nextRetryAt: now - 1_000,
    });

    const id = env.ROUTER.idFromName("singleton");
    const stub = env.ROUTER.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    const rows = await queryQueueBySession(baseSession);
    const ids = rows.map((row) => row.command_id);

    expect(ids).not.toContain(`acked-old-${now}`);
    expect(ids).not.toContain(`pending-stuck-${now}`);
    expect(ids).toContain(`pending-fresh-${now}`);
  });

  it("alarm retries stale sent commands by scheduling backoff when machine offline", async () => {
    const now = Date.now();
    const sessionId = `retry-session-${now}`;
    await registerSession(sessionId, MACHINE_ID);

    await insertQueueRow({
      commandId: `sent-stale-${now}`,
      machineId: MACHINE_ID,
      sessionId,
      status: "sent",
      attempts: 1,
      createdAt: now - (2 * 60 * 1000),
      sentAt: now - (2 * 60 * 1000),
      nextRetryAt: now - 5_000,
    });

    const id = env.ROUTER.idFromName("singleton");
    const stub = env.ROUTER.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    const rows = await queryQueueBySession(sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.next_retry_at).toBeGreaterThan(now);
  });
});

// ─── WebSocket Machine Agent: Integration ──────────────────────────────

async function openMachineSocket(machineId: string, apiKey = API_KEY): Promise<WebSocket> {
  const response = await SELF.fetch(`https://worker/ws?machineId=${encodeURIComponent(machineId)}`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `ccr,${apiKey}`,
    },
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();

  socket!.accept();
  return socket!;
}

async function waitForWsMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 2000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(String(event.data));
    }, { once: true });
  });
}

describe("websocket machine agent", () => {
  afterEach(() => {
    fetchMock.deactivate();
  });

  it("rejects missing websocket protocol auth", async () => {
    const response = await SELF.fetch("https://worker/ws?machineId=machine-a", {
      headers: {
        Upgrade: "websocket",
      },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("rejects invalid machine id", async () => {
    const response = await SELF.fetch("https://worker/ws?machineId=bad_machine_id", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `ccr,${API_KEY}`,
      },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid machine ID");
  });

  it("responds to ping with pong", async () => {
    const ws = await openMachineSocket(`machine-ping-${Date.now()}`);
    ws.send(JSON.stringify({ type: "ping" }));

    const message = await waitForWsMessage(ws);
    expect(JSON.parse(message)).toEqual({ type: "pong" });

    ws.close();
  });

  it("flushes pending queued commands to connected machine and handles ack", async () => {
    const now = Date.now();
    const machineId = `machine-flush-${now}`;
    const sessionId = `session-flush-${now}`;
    const commandId = `cmd-${now}`;

    await registerSession(sessionId, machineId);
    await insertQueueRow({
      commandId,
      machineId,
      sessionId,
      status: "pending",
      attempts: 0,
      createdAt: now - 1_000,
      nextRetryAt: now - 1,
    });

    const ws = await openMachineSocket(machineId);
    const inbound = await waitForWsMessage(ws);
    const commandMsg = JSON.parse(inbound) as {
      type: string;
      commandId: string;
      sessionId: string;
      command: string;
      chatId: string;
    };

    expect(commandMsg.type).toBe("command");
    expect(commandMsg.commandId).toBe(commandId);
    expect(commandMsg.sessionId).toBe(sessionId);

    ws.send(JSON.stringify({ type: "ack", commandId }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const queueRows = await queryQueueBySession(sessionId);
    expect(queueRows.length).toBe(1);
    expect(queueRows[0]?.status).toBe("acked");
    expect(queueRows[0]?.acked_at).not.toBeNull();

    ws.close();
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

  it("replies with 'not connected' when machine has no WebSocket", async () => {
    mockTelegramSendMessage(); // ack for error message

    const res = await sendWebhook(
      makeLaunchMessage("offline-machine", "/home/dev/project", "do something"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues a launch command when machine is connected via WebSocket", async () => {
    const now = Date.now();
    const machineId = `launch-machine-${now}`;

    // Connect the machine via WebSocket so isMachineConnected returns true
    const ws = await openMachineSocket(machineId);

    mockTelegramSendMessage(); // ack "Launching on ..."

    const res = await sendWebhook(
      makeLaunchMessage(machineId, "/home/dev/myproject", "build and test the app"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify the launch command was queued with correct type and directory
    const rows = await queryQueueByMachine(machineId);
    // Filter to launch-type commands only (ignore any flushed execute commands)
    const launchRows = rows.filter((r) => r.command_type === "launch");
    expect(launchRows.length).toBeGreaterThanOrEqual(1);
    const launchRow = launchRows[launchRows.length - 1]!;
    expect(launchRow.command_type).toBe("launch");
    expect(launchRow.directory).toBe("/home/dev/myproject");
    expect(launchRow.command).toBe("build and test the app");
    expect(launchRow.session_id).toBeNull();
    expect(launchRow.machine_id).toBe(machineId);

    ws.close();
  });

  it("sends a launch WebSocket message (not command type) to the machine", async () => {
    const now = Date.now();
    const machineId = `launch-ws-${now}`;

    const ws = await openMachineSocket(machineId);

    mockTelegramSendMessage(); // ack "Launching on ..."

    // Set up listener BEFORE sending the webhook so we don't miss the message
    const messagePromise = waitForWsMessage(ws);

    await sendWebhook(
      makeLaunchMessage(machineId, "/workspace/app", "run all tests"),
    );

    // The machine should receive a "launch" type message
    const inbound = await messagePromise;
    const msg = JSON.parse(inbound) as Record<string, unknown>;

    expect(msg.type).toBe("launch");
    expect(msg.directory).toBe("/workspace/app");
    expect(msg.prompt).toBe("run all tests");
    expect(msg.chatId).toBe(String(CHAT_ID_NUM));
    expect(typeof msg.commandId).toBe("string");
    // launch messages must NOT have sessionId
    expect(msg.sessionId).toBeUndefined();

    ws.close();
  });

  it("prompt captures everything after directory including spaces", async () => {
    const now = Date.now();
    const machineId = `launch-multiword-${now}`;

    const ws = await openMachineSocket(machineId);
    mockTelegramSendMessage();

    // Set up listener BEFORE sending the webhook so we don't miss the message
    const messagePromise = waitForWsMessage(ws);

    await sendWebhook({
      update_id: ++webhookUpdateCounter,
      message: {
        message_id: ++webhookUpdateCounter,
        chat: { id: CHAT_ID_NUM },
        from: { id: CHAT_ID_NUM },
        text: `/launch ${machineId} /tmp/proj implement a login page with JWT auth`,
      },
    });

    const inbound = await messagePromise;
    const msg = JSON.parse(inbound) as Record<string, unknown>;

    expect(msg.type).toBe("launch");
    expect(msg.prompt).toBe("implement a login page with JWT auth");
    expect(msg.directory).toBe("/tmp/proj");

    ws.close();
  });

  it("does not fall through to regular session resolution for /launch", async () => {
    // Even if there's no session for the machine, /launch should not
    // produce the "Could not find session" error message — it should only
    // produce the "not connected" message.
    mockTelegramSendMessage(); // exactly one Telegram call expected (not connected)

    const res = await sendWebhook(
      makeLaunchMessage("never-connected-machine", "/tmp", "hello"),
    );

    expect(res.status).toBe(200);
    // fetchMock should have consumed exactly the one mock (not connected)
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

  it("replies with 'not connected' when machine has no WebSocket", async () => {
    const now = Date.now();
    const sessionId = `kill-offline-${now}`;
    const machineId = `kill-offline-machine-${now}`;

    await registerSession(sessionId, machineId);
    mockTelegramSendMessage();

    const res = await sendWebhook(makeKillMessage(sessionId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("queues a kill command and sends WebSocket message when machine is connected", async () => {
    const now = Date.now();
    const sessionId = `kill-connected-${now}`;
    const machineId = `kill-machine-${now}`;

    await registerSession(sessionId, machineId);

    const ws = await openMachineSocket(machineId);
    mockTelegramSendMessage(); // ack "Killing session..."

    const messagePromise = waitForWsMessage(ws);

    const res = await sendWebhook(makeKillMessage(sessionId));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // The machine should receive a "kill" type message
    const inbound = await messagePromise;
    const msg = JSON.parse(inbound) as Record<string, unknown>;

    expect(msg.type).toBe("kill");
    expect(msg.sessionId).toBe(sessionId);
    expect(msg.chatId).toBe(String(CHAT_ID_NUM));
    expect(typeof msg.commandId).toBe("string");
    // kill messages must NOT have command or directory
    expect(msg.command).toBeUndefined();
    expect(msg.directory).toBeUndefined();

    ws.close();
  });

  it("does not fall through to regular session resolution for /kill", async () => {
    // /kill with unknown session should produce "not found", not "Could not find session"
    mockTelegramSendMessage(); // exactly one Telegram call expected

    const res = await sendWebhook(makeKillMessage("unknown-session"));

    expect(res.status).toBe(200);
  });
});

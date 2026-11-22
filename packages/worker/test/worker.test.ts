/**
 * All worker tests in a single file.
 * The worker uses D1 + HTTP polling (no Durable Objects).
 */
import { env, SELF, fetchMock } from "cloudflare:test";
import worker from "../src/index";
import { describe, it, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { SESSION_TTL_MS as DAEMON_SESSION_TTL_MS } from "../../daemon/src/storage/schema";
import {
  generateCommandId,
  queueCommand,
  pollNextCommand,
  ackCommand,
  touchMachine,
  touchMachineStatement,
  isMachineRecent,
  cleanupCommands,
  checkSessionHighWaterAlert,
  sweepStaleSessions,
  SESSION_SWEEP_TTL_MS,
  SWEEP_ID_CHUNK,
  MAX_QUEUE_PER_MACHINE,
} from "../src/d1-ops";
import { HEARTBEAT_WRITE_INTERVAL_MS, MACHINE_ONLINE_MS } from "../src/machine-liveness";
import { RELAY_ONLINE_MS } from "../src/relay";
import { LAUNCH_ONLINE_MS } from "../src/remote-launch";
import {
  generateToken,
  handleSendNotification,
  handleEditNotification,
  alertRelocation,
} from "../src/notifications";
import {
  topicName,
  clampPreservingSurrogates,
  getBySession,
  getByThread,
  reserve,
  finalize,
  rename,
  renameProvisional,
  isPlaceholderTitle,
  markClosed,
  markOpen,
  deleteBySession,
  deleteTopicBySession,
  stealReservation,
  listReapable,
  listOrphaned,
} from "../src/topics";
import { IN_REPLY_TO_MAX_CHARS, MAX_FILE_SIZE } from "../src/chat/limits";
import { failureDetails } from "../src/chat/failures";
import { resolveTopic, RESERVATION_TTL_MS } from "../src/topic-manager";
import {
  runTopicReaper,
  reapTopics,
  closeOrphanedTopics,
  shouldCloseOrphans,
  REAP_TTL_MS,
  ORPHAN_TTL_MS,
  DEFAULT_ORPHAN_CAP,
  TOPIC_CLOSE_WINDOW_START_HOUR_UTC,
  TOPIC_CLOSE_WINDOW_HOURS,
} from "../src/topic-reaper";
import { cleanupExpiredMedia } from "../src/media";
import {
  handleNamedTopic,
  handleNamedTopicBind,
  handleNamedTopicUnbind,
  maybeAnswerInNamedTopic,
  getBoundSessionByThread,
  getBindingForSession,
  NAMED_TOPIC_HINT_TEXT,
} from "../src/named-topics";
import { handlePollNext, handleAckCommand } from "../src/poll";
import { handleSessionRequest, MAX_SESSIONS } from "../src/sessions";
import { withD1, StorageError } from "../src/d1";
import d1Schema from "../src/d1-schema.sql?raw";
import { handleTopicLookup } from "../src/topic-lookup";
import { SLACK_HANDLE_MIN, slackChatId } from "../src/chat/slack-config";
import {
  envWith,
  fakeSlack,
  fakeTransport,
  mkSlackMachine,
  postJson,
  posted,
  resetSlackCalls,
  results,
  seedAlerts,
  seedChannel,
  seedSession,
  seedSlackTopic,
  slack,
  slackCalls,
  slackCreate,
  slackOf,
  stamp,
  type SlackMachine,
} from "./slack-harness";

// ─── Global D1 Schema Setup ─────────────────────────────────────────────

// Initialize D1 schema once before all tests (sessions, messages,
// commands, machines are all used by sessions/notifications modules).
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
    intended_thread_id INTEGER,
    actual_thread_id   INTEGER,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
    ON messages(notification_id) WHERE notification_id IS NOT NULL`,
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
    message_thread_id INTEGER,
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
    name_provisional  INTEGER NOT NULL DEFAULT 0,
    state             TEXT NOT NULL DEFAULT 'open',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    closed_at         INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
    ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at)`,
  `CREATE TABLE IF NOT EXISTS named_topics (
    chat_id            TEXT NOT NULL,
    topic_key          TEXT NOT NULL,
    message_thread_id  INTEGER NOT NULL,
    name               TEXT NOT NULL,
    reopen_checked_at  INTEGER,
    hint_at            INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (chat_id, topic_key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_named_topics_thread
    ON named_topics(chat_id, message_thread_id)`,
  `CREATE TABLE IF NOT EXISTS named_topic_bindings (
    chat_id     TEXT NOT NULL,
    topic_key   TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    bound_at    INTEGER NOT NULL,
    PRIMARY KEY (chat_id, topic_key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_named_topic_bindings_session
    ON named_topic_bindings(session_id)`,
];

beforeAll(async () => {
  for (const stmt of d1SchemaStatements) {
    await env.DB.prepare(stmt).run();
  }
  // The shipped schema as well: the Slack tables, machine credentials, ...
  for (const stmt of d1Schema.split(";").map((x) => x.trim()).filter(Boolean)) {
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
  metadata_json?: string | null;
  message_thread_id?: number | null;
}

// Query D1 `commands` table (used by sessions/notifications tests)
async function queryQueueBySession(sessionId: string): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT command_id, machine_id, session_id, command, chat_id, status,
            0 as attempts, created_at, NULL as sent_at, NULL as next_retry_at, acked_at, NULL as last_error,
            command_type, directory, media_json, metadata_json, message_thread_id
     FROM commands
     WHERE session_id = ?
     ORDER BY created_at ASC`,
  ).bind(sessionId).all<QueueRow>();
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

// ─── Session Owner (pigeon-k0qn.1) ─────────────────────────────────────

describe("GET /sessions/:id/owner", () => {
  test("returns the owning machine and last_seen", async () => {
    await registerSession("sess-owner", "cloudbox");
    const row = await env.DB.prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
      .bind("sess-owner")
      .first<{ updated_at: number }>();

    const res = await SELF.fetch("https://worker/sessions/sess-owner/owner", { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machine_id: "cloudbox", last_seen: row!.updated_at });
  });

  test("returns 404 for an unknown session", async () => {
    const res = await SELF.fetch("https://worker/sessions/sess-nobody/owner", { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  test("requires auth", async () => {
    await registerSession("sess-owner-auth", "cloudbox");
    const res = await SELF.fetch("https://worker/sessions/sess-owner-auth/owner");
    expect(res.status).toBe(401);
  });

  test("decodes a percent-encoded id", async () => {
    await registerSession("ses_a b", "devbox");
    const res = await SELF.fetch(`https://worker/sessions/${encodeURIComponent("ses_a b")}/owner`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { machine_id: string }).machine_id).toBe("devbox");
  });

  test("does not touch updated_at (read-only)", async () => {
    await registerSession("sess-owner-ro", "cloudbox");
    await env.DB.prepare("UPDATE sessions SET updated_at = 1 WHERE session_id = ?").bind("sess-owner-ro").run();

    const res = await SELF.fetch("https://worker/sessions/sess-owner-ro/owner", { headers: authHeaders });

    expect(((await res.json()) as { last_seen: number }).last_seen).toBe(1);
    const row = await env.DB.prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
      .bind("sess-owner-ro")
      .first<{ updated_at: number }>();
    expect(row!.updated_at).toBe(1);
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

// ─── Session Cap & High-Water Alert (pigeon-bea) ──────────────────────────

describe("session cap and high-water alert (pigeon-bea)", () => {
  afterEach(async () => {
    try {
      fetchMock.get("https://slack.com").cleanMocks();
    } catch {}
    await env.DB.prepare(
      "DELETE FROM sessions WHERE session_id LIKE 'ses_cap_%' OR session_id LIKE 'ses_hw_%'"
    ).run();
  });

  test("registration succeeds below cap and returns 429 only at/above cap (and existing sessions bypass cap)", async () => {
    const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
    const initialCount = initialRow?.count ?? 0;
    const customCap = initialCount + 2;

    const req1 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_1", machineId: "devbox" }),
    });
    const res1 = await handleSessionRequest(env.DB, env, req1, "register", { maxSessions: customCap });
    expect(res1.status).toBe(200);

    const req2 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_2", machineId: "devbox" }),
    });
    const res2 = await handleSessionRequest(env.DB, env, req2, "register", { maxSessions: customCap });
    expect(res2.status).toBe(200);

    // At cap (initial + 2 registered), a new session request returns 429
    const req3 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_3", machineId: "devbox" }),
    });
    const res3 = await handleSessionRequest(env.DB, env, req3, "register", { maxSessions: customCap });
    expect(res3.status).toBe(429);
    expect(await res3.json()).toEqual({ error: "Session limit reached" });

    // Existing session bypasses cap check and re-registers successfully
    const reqReReg = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_1", machineId: "devbox", label: "updated" }),
    });
    const resReReg = await handleSessionRequest(env.DB, env, reqReReg, "register", { maxSessions: customCap });
    expect(resReReg.status).toBe(200);
  });

  test("the 429 path logs via console.error", async () => {
    const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
    const initialCount = initialRow?.count ?? 0;
    const customCap = initialCount + 1;

    const req1 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_1", machineId: "devbox" }),
    });
    await handleSessionRequest(env.DB, env, req1, "register", { maxSessions: customCap });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const req2 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_cap_2", machineId: "devbox" }),
    });
    const res2 = await handleSessionRequest(env.DB, env, req2, "register", { maxSessions: customCap });
    expect(res2.status).toBe(429);

    expect(spy).toHaveBeenCalled();
    const loggedStr = spy.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(loggedStr).toMatch(/Session limit reached/i);
    expect(loggedStr).toMatch(new RegExp(String(customCap)));

    spy.mockRestore();
  });

  test("high-water check does NOT alert below 80%", async () => {
    const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
    const initialCount = initialRow?.count ?? 0;

    // Insert 1 session
    const req1 = new Request("https://worker/sessions/register", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_hw_1", machineId: "devbox" }),
    });
    await handleSessionRequest(env.DB, env, req1, "register");

    // With cap: initialCount + 10, (initialCount + 1) / (initialCount + 10) < 80%
    const maxSessions = initialCount + 10;
    const result = await checkSessionHighWaterAlert(env.DB, env, {
      maxSessions,
      thresholdRatio: 0.8,
    });
    expect(result.alerted).toBe(false);
  });

  test("high-water check DOES alert at/above 80% and includes count and cap in text", async () => {
    const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
    const initialCount = initialRow?.count ?? 0;

    // Suppose target total count is 10. We insert (10 - initialCount) sessions or set maxSessions dynamically.
    // E.g., if targetCap = initialCount + 10, we insert 8 sessions so total = initialCount + 8 (exactly 80%).
    const maxSessions = initialCount + 10;
    for (let i = 1; i <= 8; i++) {
      const req = new Request("https://worker/sessions/register", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: `ses_hw_${i}`, machineId: "devbox" }),
      });
      await handleSessionRequest(env.DB, env, req, "register");
    }

    const hwMachine = await mkSlackMachine();
    await seedAlerts(hwMachine.ws);
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    slack("chat.postMessage", posted("CALERTS"));

    // The alert goes to the first allowlisted chat, here the workspace's `#alerts`.
    const testEnv = envWith([hwMachine]);
    const result = await checkSessionHighWaterAlert(env.DB, testEnv, {
      maxSessions,
      thresholdRatio: 0.8,
    });
    const sentText = slackCalls[0]?.params.get("text") ?? "";

    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();

    const expectedPct = Math.round(((initialCount + 8) / maxSessions) * 100);
    expect(result.alerted).toBe(true);
    expect(sentText).toContain(String(initialCount + 8)); // count
    expect(sentText).toContain(String(maxSessions)); // cap
    expect(sentText).toContain(`${expectedPct}%`); // percentage
  });

  test("a sendMessage rejection inside high-water check does not propagate", async () => {
    const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
    const initialCount = initialRow?.count ?? 0;
    const maxSessions = initialCount + 10;

    for (let i = 1; i <= 8; i++) {
      const req = new Request("https://worker/sessions/register", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: `ses_hw_${i}`, machineId: "devbox" }),
      });
      await handleSessionRequest(env.DB, env, req, "register");
    }

    const hwMachine = await mkSlackMachine();
    await seedAlerts(hwMachine.ws);
    fetchMock.activate();
    fetchMock.disableNetConnect();
    slack("chat.postMessage", { ok: false, error: "fatal_error" }, 500);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const testEnv = envWith([hwMachine]);
    // Should NOT throw
    await expect(
      checkSessionHighWaterAlert(env.DB, testEnv, {
        maxSessions,
        thresholdRatio: 0.8,
      }),
    ).resolves.toBeDefined();

    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  describe("goes to every configured workspace's #alerts, once per team", () => {
    const overCap = async () => {
      await seedSession("devbox"); // so the table is never empty
      const initialRow = await env.DB.prepare("SELECT COUNT(*) as count FROM sessions").first<{ count: number }>();
      return Math.max(1, initialRow?.count ?? 0);
    };

    beforeEach(() => {
      resetSlackCalls();
      fetchMock.activate();
      fetchMock.disableNetConnect();
    });

    afterEach(() => {
      fetchMock.get("https://slack.com").cleanMocks();
      fetchMock.deactivate();
      vi.restoreAllMocks();
    });

    test("two machines on one team and a third on another: two posts, one per team, each to its own #alerts", async () => {
      const teamA = `TA${stamp()}`.toUpperCase();
      const a1 = await mkSlackMachine({ teamId: teamA });
      const a2 = await mkSlackMachine({ teamId: teamA });
      const b = await mkSlackMachine();
      const alertsA = await seedAlerts(a1.ws);
      const alertsB = await seedAlerts(b.ws);
      slack("chat.postMessage", posted(alertsA));
      slack("chat.postMessage", posted(alertsB));

      const cap = await overCap();
      const result = await checkSessionHighWaterAlert(env.DB, envWith([a1, a2, b]), { maxSessions: cap, thresholdRatio: 0.5 });

      expect(result.alerted).toBe(true);
      expect(slackOf("chat.postMessage").map((c) => c.params.get("channel")).sort()).toEqual([alertsA, alertsB].sort());
    });

    test("one workspace failing does not stop the others; the cron never throws", async () => {
      const a = await mkSlackMachine();
      const b = await mkSlackMachine();
      const alertsA = await seedAlerts(a.ws);
      const alertsB = await seedAlerts(b.ws);
      // The first workspace's post fails (and its plain retry), the second's goes through.
      slack("chat.postMessage", { ok: false, error: "fatal_error" }, 500);
      slack("chat.postMessage", posted(alertsB));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const cap = await overCap();
      const result = await checkSessionHighWaterAlert(env.DB, envWith([a, b]), { maxSessions: cap, thresholdRatio: 0.5 });

      expect(result.alerted).toBe(true);
      expect(slackOf("chat.postMessage").map((c) => c.params.get("channel"))).toEqual([alertsA, alertsB]);
    });

    test("no workspace configured: nothing is posted, alerted is false, and it says so", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cap = await overCap();
      const result = await checkSessionHighWaterAlert(env.DB, env, { maxSessions: cap, thresholdRatio: 0.5 });
      expect(result.alerted).toBe(false);
      expect(slackCalls).toHaveLength(0);
      expect(String(spy.mock.calls[0]?.[0])).toContain("no Slack workspace is configured");
    });
  });
});

// ─── Stale Session TTL Sweep (pigeon-bea) ──────────────────────────────────

describe("stale-session TTL sweep (pigeon-bea)", () => {
  const PREFIX = "ses_sweep_";

  // The sweep is global by design: it deletes every stale row, not just this file's
  // fixtures. All worker tests share ONE D1 instance, so a stale row left behind by any
  // other test would land inside the LIMIT window and break the exact-count assertions
  // here. Clear the stale population first so each test's fixtures are the only rows the
  // predicate can match. Rows with fresh timestamps -- everything else in this suite --
  // are untouched by definition.
  beforeEach(async () => {
    await sweepStaleSessions(env.DB, { limit: 10_000 });
  });

  afterEach(async () => {
    await env.DB.prepare(
      "DELETE FROM messages WHERE session_id LIKE 'ses_sweep_%'"
    ).run();
    await env.DB.prepare(
      "DELETE FROM sessions WHERE session_id LIKE 'ses_sweep_%'"
    ).run();
  });

  test("guard: worker sweep TTL is strictly greater than daemon SESSION_TTL_MS", () => {
    // Daemon SESSION_TTL_MS is 7 days (7 * 24 * 60 * 60 * 1000) defined in
    // packages/daemon/src/storage/schema.ts.
    // The worker sweep TTL (14 days) must be strictly greater than the daemon's
    // 7-day SESSION_TTL_MS. If the worker TTL dropped below the daemon's TTL,
    // the worker would mass-expire active sessions that the daemon still holds locally.
    expect(SESSION_SWEEP_TTL_MS).toBeGreaterThan(DAEMON_SESSION_TTL_MS);
  });

  test("sweeps session with updated_at older than 14d", async () => {
    const now = Date.now();
    const staleTime = now - (SESSION_SWEEP_TTL_MS + 10_000);
    const sessionId = `${PREFIX}stale_1`;

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(sessionId, "devbox", "stale", staleTime, staleTime).run();

    const result = await sweepStaleSessions(env.DB, { now });
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);

    const check = await env.DB.prepare(
      "SELECT * FROM sessions WHERE session_id = ?"
    ).bind(sessionId).first();
    expect(check).toBeNull();
  });

  test("does NOT sweep session with updated_at inside 14d even if created_at is old", async () => {
    const now = Date.now();
    const oldCreated = now - (SESSION_SWEEP_TTL_MS + 10 * 24 * 60 * 60 * 1000);
    const recentUpdated = now - (1 * 24 * 60 * 60 * 1000);
    const sessionId = `${PREFIX}active_recently_touched`;

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(sessionId, "devbox", "active", oldCreated, recentUpdated).run();

    await sweepStaleSessions(env.DB, { now });

    const check = await env.DB.prepare(
      "SELECT * FROM sessions WHERE session_id = ?"
    ).bind(sessionId).first();
    expect(check).not.toBeNull();
  });

  test("deletes messages rows belonging to swept session but keeps messages for surviving session", async () => {
    const now = Date.now();
    const staleTime = now - (SESSION_SWEEP_TTL_MS + 10_000);
    const freshTime = now - (1 * 24 * 60 * 60 * 1000);

    const sweptSessionId = `${PREFIX}swept_msg_ses`;
    const freshSessionId = `${PREFIX}fresh_msg_ses`;

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(sweptSessionId, "devbox", "swept", staleTime, staleTime).run();

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(freshSessionId, "devbox", "fresh", freshTime, freshTime).run();

    const chatId = "9988776655";
    const sweptMsgId = 993101;
    const freshMsgId = 993102;

    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(chatId, sweptMsgId, sweptSessionId, "tok1", "notif_swept", staleTime).run();

    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(chatId, freshMsgId, freshSessionId, "tok2", "notif_fresh", freshTime).run();

    const sweepResult = await sweepStaleSessions(env.DB, { now });
    expect(sweepResult.messagesDeleted).toBeGreaterThanOrEqual(1);

    const sweptMsgCheck = await env.DB.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND message_id = ?"
    ).bind(chatId, sweptMsgId).first();
    expect(sweptMsgCheck).toBeNull();

    const freshMsgCheck = await env.DB.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND message_id = ?"
    ).bind(chatId, freshMsgId).first();
    expect(freshMsgCheck).not.toBeNull();
  });

  test("respects limit parameter when sweeping stale sessions", async () => {
    const now = Date.now();
    const staleTime = now - (SESSION_SWEEP_TTL_MS + 10_000);

    const ses1 = `${PREFIX}limit_1`;
    const ses2 = `${PREFIX}limit_2`;
    const ses3 = `${PREFIX}limit_3`;

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(ses1, "devbox", "lim1", staleTime - 3000, staleTime - 3000).run();
    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(ses2, "devbox", "lim2", staleTime - 2000, staleTime - 2000).run();
    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(ses3, "devbox", "lim3", staleTime - 1000, staleTime - 1000).run();

    const result = await sweepStaleSessions(env.DB, { now, limit: 2 });
    expect(result.sessionsDeleted).toBe(2);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE session_id LIKE 'ses_sweep_limit_%'"
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  test("guard: SWEEP_ID_CHUNK stays within D1's 100-bound-parameter limit", () => {
    // D1 allows at most 100 bound parameters PER STATEMENT, including each statement
    // inside a db.batch: https://developers.cloudflare.com/d1/platform/limits/
    // The sweep binds one parameter per victim id, so a chunk over 100 throws the whole
    // batch rather than degrading. This actually happened in production: the first run had
    // 126 victims and silently deleted nothing for two hourly ticks.
    expect(SWEEP_ID_CHUNK).toBeLessThanOrEqual(100);
  });

  test("chunks deletes so no statement ever exceeds D1's bound-parameter limit", async () => {
    // The real limit does not exist in miniflare (plain SQLite allows 999 parameters), so
    // inserting many rows and sweeping them would pass with or without the bug. Assert the
    // shape of the calls instead: capture every statement's bind count against a stub.
    const bindCounts: number[] = [];
    const victims = Array.from({ length: 250 }, (_, i) => ({ session_id: `ses_chunk_${i}` }));
    const stubDb = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          bindCounts.push(args.length);
          return { all: async () => ({ results: victims }) };
        },
      }),
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    } as unknown as D1Database;

    await sweepStaleSessions(stubDb, { now: Date.now(), limit: 500 });

    // First bind is the SELECT (cutoff + limit = 2 params); the rest are DELETE chunks.
    const deleteBinds = bindCounts.slice(1);
    expect(deleteBinds.length).toBeGreaterThan(2); // 250 ids must span multiple chunks
    for (const n of deleteBinds) {
      expect(n).toBeLessThanOrEqual(100);
    }
    // Every victim is accounted for across the chunks (two statements per chunk).
    expect(deleteBinds.reduce((a, b) => a + b, 0)).toBe(250 * 2);
  });

  test("scheduled() actually invokes the sweep (pins the cron wiring, not just the function)", async () => {
    // Every other test in this block calls sweepStaleSessions directly, which means they
    // all still pass if the call is deleted from scheduled(). This one fails in that case:
    // it drives the real cron entry point and asserts the row is gone afterwards.
    const now = Date.now();
    const staleTime = now - (SESSION_SWEEP_TTL_MS + 60_000);
    const sessionId = `${PREFIX}cron_wiring`;

    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(sessionId, "devbox", "cron", staleTime, staleTime).run();

    await worker.scheduled(
      { scheduledTime: now, cron: "0 * * * *", noRetry: () => {} } as ScheduledController,
      env,
    );

    const check = await env.DB.prepare(
      "SELECT * FROM sessions WHERE session_id = ?"
    ).bind(sessionId).first();
    expect(check).toBeNull();
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

  test("bound session unregistered -> binding row gone", async () => {
    const sessionId = `sess-unreg-bound-${Date.now()}`;
    const key = `test:unreg-key-${Date.now()}`;
    const chat = "slack:TUNREG";
    const now = Date.now();
    await registerSession(sessionId, "devbox");
    await env.DB.prepare(
      "INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)",
    ).bind(chat, key, sessionId, now).run();

    const res = await SELF.fetch("https://worker/sessions/unregister", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId }),
    });
    expect(res.status).toBe(200);

    const binding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE session_id = ?").bind(sessionId).first();
    expect(binding).toBeNull();
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

// ─── Topic Lookup ──────────────────────────────────────────────────────

describe("POST /topics/lookup", () => {
  // Rows live in one Slack workspace; an entry carries the conversation's archive url.
  let lm: SlackMachine;
  let lEnv: Env;
  let CHAT: string;
  const channels = new Map<string, string>();

  beforeAll(async () => {
    lm = await mkSlackMachine({ domain: "acme" });
    lEnv = envWith([lm]);
    CHAT = slackChatId(lm.ws);
  });

  /** A row over a conversation Slack knows, unless the thread is null (a reservation). */
  async function seedTopic(row: {
    sessionId: string;
    threadId: "new" | null;
    state?: "open" | "closed";
  }): Promise<number | null> {
    let thread: number | null = null;
    if (row.threadId === "new") {
      const channelId = `CL${stamp()}`.toUpperCase();
      thread = await seedChannel(lm.ws.teamId, channelId);
      channels.set(row.sessionId, channelId);
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.sessionId, "m1", CHAT, thread, "n", row.state ?? "open", 1, 1)
      .run();
    return thread;
  }
  const url = (sessionId: string) => `https://acme.slack.com/archives/${channels.get(sessionId)}`;

  function lookup(body: unknown, key: string | null = "test-api-key"): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    return handleTopicLookup(
      env.DB,
      lEnv,
      new Request("https://worker/topics/lookup", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  test("requires auth", async () => {
    const res = await lookup({ sessionIds: ["x"] }, null);
    expect(res.status).toBe(401);
  });

  test("returns the topic for each known session and null for unknown ones", async () => {
    const t1 = await seedTopic({ sessionId: "tl-open", threadId: "new" });
    const t2 = await seedTopic({ sessionId: "tl-closed", threadId: "new", state: "closed" });
    await seedTopic({ sessionId: "tl-reserved", threadId: null });

    const res = await lookup({ sessionIds: ["tl-open", "tl-closed", "tl-reserved", "tl-missing"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      topics: {
        "tl-open": { chatId: CHAT, messageThreadId: t1, state: "open", url: url("tl-open") },
        "tl-closed": { chatId: CHAT, messageThreadId: t2, state: "closed", url: url("tl-closed") },
        "tl-reserved": { chatId: CHAT, messageThreadId: null, state: "open", url: null },
        "tl-missing": null,
      },
    });
  });

  test("empty list returns an empty map", async () => {
    const res = await lookup({ sessionIds: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topics: {} });
  });

  test("rejects a non-array, non-string ids, and an oversized batch with 400", async () => {
    expect((await lookup({})).status).toBe(400);
    expect((await lookup({ sessionIds: "x" })).status).toBe(400);
    expect((await lookup({ sessionIds: [1] })).status).toBe(400);
    expect((await lookup({ sessionIds: [""] })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, (_, i) => `s${i}`);
    expect((await lookup({ sessionIds: tooMany })).status).toBe(400);
  });

  test("duplicate ids are answered once", async () => {
    const t = await seedTopic({ sessionId: "tl-dup", threadId: "new" });
    const res = await lookup({ sessionIds: ["tl-dup", "tl-dup"] });
    expect(await res.json()).toEqual({
      topics: { "tl-dup": { chatId: CHAT, messageThreadId: t, state: "open", url: url("tl-dup") } },
    });
  });
});

// ─── Notification: Unit Tests ──────────────────────────────────────────

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
  let nm: SlackMachine;
  let nEnv: Env;
  let SESSION_ID: string;
  let channelId: string;

  const sendN = (body: Record<string, unknown>, key: string | null = nm.key, e: Env = nEnv) =>
    handleSendNotification(
      env.DB,
      e,
      key === null
        ? new Request("https://worker/notifications/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : postJson("/notifications/send", key, body),
    );

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    nm = await mkSlackMachine();
    nEnv = envWith([nm]);
    SESSION_ID = await seedSession(nm.machineId, "test");
    ({ channelId } = await seedSlackTopic(SESSION_ID, nm.machineId, nm.ws));
  });

  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
  });

  it("requires authentication", async () => {
    const res = await sendN({ sessionId: SESSION_ID, text: "hello" }, null);
    expect(res.status).toBe(401);
  });

  it("validates required fields", async () => {
    const res = await sendN({ sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sessionId, chatId, and text required");
  });

  it("returns 404 for unknown session", async () => {
    const res = await sendN({ sessionId: "nonexistent", text: "hello" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("refuses a principal that is not on a workspace (the shared key) with 403", async () => {
    const res = await sendN({ sessionId: SESSION_ID, chatId: slackChatId(nm.ws), text: "hello" }, "test-api-key");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Chat ID not allowed");
    expect(slackCalls).toHaveLength(0);
  });

  it("sends notification and returns messageId + token", async () => {
    slack("chat.postMessage", posted(channelId));

    const res = await sendN({ sessionId: SESSION_ID, text: "Session stopped" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number; token: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe(channelId);
  });

  it("passes reply_markup to the provider when provided", async () => {
    slack("chat.postMessage", posted(channelId));
    const markup = {
      inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]],
    };

    const res = await sendN({ sessionId: SESSION_ID, text: "Approve?", replyMarkup: markup });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const blocks = JSON.parse(slackCalls[0]!.params.get("blocks") ?? "[]") as Array<{ type: string; elements?: unknown[] }>;
    expect(blocks.find((b) => b.type === "actions")?.elements).toMatchObject([{ type: "button", value: "approve" }]);
  });

  it("returns 502 when the provider fails", async () => {
    slack("chat.postMessage", { ok: false, error: "fatal_error" }, 500);
    const res = await sendN({ sessionId: SESSION_ID, text: "hello" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details: unknown; errorClass?: string };
    expect(body.error).toBe("provider_error");
    expect(body.errorClass).toBe("upstream");
  });

  it("returns 429 when the provider rate limits with retryAfter", async () => {
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "17" });

    const res = await sendN({ sessionId: SESSION_ID, text: "hello" });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body).toMatchObject({ error: "rate_limited", retryAfter: 17 });
  });

  it("stores unique tokens per notification", async () => {
    slack("chat.postMessage", posted(channelId, "1.1"));
    const res1 = await sendN({ sessionId: SESSION_ID, text: "first" });
    const body1 = (await res1.json()) as { token: string };

    slack("chat.postMessage", posted(channelId, "1.2"));
    const res2 = await sendN({ sessionId: SESSION_ID, text: "second" });
    const body2 = (await res2.json()) as { token: string };

    expect(body1.token).not.toBe(body2.token);
  });

  it("reuses daemon token from callback_data instead of generating own", async () => {
    const DAEMON_TOKEN = "daemon-supplied-token-abc";
    slack("chat.postMessage", posted(channelId));

    const res = await sendN({
      sessionId: SESSION_ID,
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
    slack("chat.postMessage", posted(channelId));

    const res = await sendN({ sessionId: SESSION_ID, text: "Stop notification", replyMarkup: { inline_keyboard: [] } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    // Token should be a base64url string (not a specific daemon token)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.token).not.toBe("");
  });

  /** A named topic bound to `sessionId`, over a conversation Slack knows. */
  async function bindNamedTopic(sessionId: string, key: string): Promise<{ handle: number; channel: string }> {
    const channel = `CB${stamp()}`.toUpperCase();
    const handle = await seedChannel(nm.ws.teamId, channel);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Topic', ?, ?)",
    ).bind(slackChatId(nm.ws), key, handle, now, now).run();
    await env.DB.prepare(
      "INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)",
    ).bind(slackChatId(nm.ws), key, sessionId, now).run();
    return { handle, channel };
  }

  it("bound session's notification -> sent with the named thread id, no topics row", async () => {
    const sessionId = await seedSession(nm.machineId, "test");
    const { channel } = await bindNamedTopic(sessionId, `test:notif-key-${stamp()}`);
    slack("chat.postMessage", posted(channel));

    const res = await sendN({
      sessionId,
      text: "hello in bound named topic",
      title: "Bound Title",
      dir: "pigeon",
      threaded: true,
    });
    expect(res.status).toBe(200);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe(channel);

    // Verify no session topic was created in topics table
    const topicRow = await env.DB.prepare("SELECT * FROM topics WHERE session_id = ?").bind(sessionId).first();
    expect(topicRow).toBeNull();
  });

  it("bound session's notification with thread_not_found skips T2.7 and relocates to General", async () => {
    const sessionId = await seedSession(nm.machineId, "test");
    const { channel } = await bindNamedTopic(sessionId, `test:notif-key-del-${stamp()}`);
    const alerts = await seedAlerts(nm.ws);
    // First send to the bound channel finds it gone, the second relocates to #alerts and succeeds.
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    slack("chat.postMessage", posted(alerts));

    const res = await sendN({ sessionId, text: "hello in deleted thread", threaded: true });
    expect(res.status).toBe(200);

    // Relocated to General (the workspace's #alerts)
    const posts = slackOf("chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.params.get("channel")).toBe(channel);
    expect(posts[1]!.params.get("channel")).toBe(alerts);

    // Verify no session topic was created in topics table (T2.7 did NOT run)
    const topicRow = await env.DB.prepare("SELECT * FROM topics WHERE session_id = ?").bind(sessionId).first();
    expect(topicRow).toBeNull();
    expect(slackOf("conversations.create")).toHaveLength(0);
  });
});


// ─── Command Queue + Alarm: Integration ───────────────────────────────

describe("command queue lifecycle", () => {
  const MACHINE_ID = "queue-machine";

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
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
    // Just verify cleanupCommands doesn't throw
    const commandResult = await cleanupCommands(env.DB);
    expect(typeof commandResult.ackedDeleted).toBe("number");
    expect(typeof commandResult.stuckDeleted).toBe("number");
  });
});

// ─── /launch Command: Integration Tests ──────────────────────────────

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

// ─── /interrupt Command: Integration Tests ──────────────────────────────

// ─── /compact Command: Integration Tests ─────────────────────────────

// ─── Outbound Media: POST /notifications/send with media ──────────────

describe("POST /notifications/send with media", () => {
  let mm: SlackMachine;
  let mEnv: Env;
  let sessionId: string;
  let channelId: string;

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    mm = await mkSlackMachine();
    mEnv = envWith([mm]);
    sessionId = await seedSession(mm.machineId, "outbound-test");
    ({ channelId } = await seedSlackTopic(sessionId, mm.machineId, mm.ws));
  });

  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
  });

  const sendM = (body: Record<string, unknown>) =>
    handleSendNotification(env.DB, mEnv, postJson("/notifications/send", mm.key, { sessionId, ...body }));

  /** Upload a file to R2 first, the way the daemon does. */
  async function uploadToR2(key: string, mime: string, filename: string, content: string) {
    const uploadForm = new FormData();
    uploadForm.append("key", key);
    uploadForm.append("mime", mime);
    uploadForm.append("filename", filename);
    uploadForm.append("file", new Blob([content], { type: mime }), filename);
    await SELF.fetch("https://worker/media/upload", {
      method: "POST",
      body: uploadForm,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  /** The three provider steps of one file post (Slack's external upload). */
  function expectFileUpload(fileId: string) {
    slack("files.getUploadURLExternal", { ok: true, upload_url: `https://files.slack.com/upload/v1/${fileId}`, file_id: fileId });
    fetchMock
      .get("https://files.slack.com")
      .intercept({ method: "POST", path: `/upload/v1/${fileId}` })
      .reply(200, "OK - 1");
    slack("files.completeUploadExternal", { ok: true, files: [{ id: fileId }] });
  }

  it("sends text message then photo for image mime type", async () => {
    const now = Date.now();
    const imageKey = `outbound/${now}-aaa/screenshot.png`;
    await uploadToR2(imageKey, "image/png", "screenshot.png", "fake-png-data");
    slack("chat.postMessage", posted(channelId));
    expectFileUpload("FPHOTO1");

    const res = await sendM({
      text: "Session completed with screenshot",
      media: [{ key: imageKey, mime: "image/png", filename: "screenshot.png" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(slackOf("files.getUploadURLExternal")[0]?.params.get("filename")).toBe("screenshot.png");
    expect(slackOf("files.completeUploadExternal")[0]?.params.get("channel_id")).toBe(channelId);
  });

  it("sends text message then document for non-image mime type", async () => {
    const now = Date.now();
    const docKey = `outbound/${now}-bbb/report.pdf`;
    await uploadToR2(docKey, "application/pdf", "report.pdf", "fake-pdf-data");
    slack("chat.postMessage", posted(channelId));
    expectFileUpload("FDOC1");

    const res = await sendM({
      text: "Session completed with document",
      media: [{ key: docKey, mime: "application/pdf", filename: "report.pdf" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(slackOf("files.getUploadURLExternal")[0]?.params.get("filename")).toBe("report.pdf");
  });

  it("stores media message mapping for reply routing", async () => {
    const now = Date.now();
    const imgKey = `outbound/${now}-ccc/photo.jpg`;
    await uploadToR2(imgKey, "image/jpeg", "photo.jpg", "fake-jpg");
    slack("chat.postMessage", posted(channelId));
    expectFileUpload("FMAP1");

    const res = await sendM({
      text: "Done with photo",
      media: [{ key: imgKey, mime: "image/jpeg", filename: "photo.jpg" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number; token: string };
    expect(body.ok).toBe(true);

    // The media message should be stored in the messages table for reply routing, next to the
    // text's own row. Verify by querying D1 directly.
    const { results: rows } = await env.DB.prepare(
      "SELECT message_id, session_id, token FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY message_id",
    ).bind(slackChatId(mm.ws), sessionId).all<{ message_id: number; session_id: string; token: string }>();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.token)).toEqual([body.token, body.token]);
    expect(rows.map((r) => r.message_id)).toContain(body.messageId);
  });

  it("backward compat: notification without media still works normally", async () => {
    slack("chat.postMessage", posted(channelId));

    const res = await sendM({ text: "Just text, no media" });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(slackOf("files.getUploadURLExternal")).toHaveLength(0);
  });

  it("continues if media key not found in R2 (best-effort)", async () => {
    // Don't upload anything — key won't exist in R2
    slack("chat.postMessage", posted(channelId));

    const res = await sendM({
      text: "Text with missing media",
      media: [{ key: "outbound/nonexistent/file.jpg", mime: "image/jpeg", filename: "file.jpg" }],
    });

    // Text notification should still succeed
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messageId: number };
    expect(body.ok).toBe(true);
    expect(slackOf("files.getUploadURLExternal")).toHaveLength(0);
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
      message_thread_id INTEGER,
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
      intended_thread_id INTEGER,
      actual_thread_id   INTEGER,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
      ON messages(notification_id) WHERE notification_id IS NOT NULL`,
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
      name_provisional  INTEGER NOT NULL DEFAULT 0,
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
    await env.DB.exec("DELETE FROM topics");
  });

  // ─── generateCommandId ───────────────────────────────────────────────

  it("generateCommandId returns 32-char hex string", () => {
    const id = generateCommandId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generateCommandId returns unique values", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateCommandId()));
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

  it("queueCommand persists messageThreadId and pollNextCommand returns it", async () => {
    const commandId = await queueCommand(env.DB, {
      machineId: "machine-t214a",
      sessionId: "ses_t214_d1ops",
      command: "test topic command",
      chatId: "8248645256",
      messageThreadId: 64001,
    });

    expect(commandId).not.toBeNull();

    const result = await pollNextCommand(env.DB, "machine-t214a");
    expect(result).not.toBeNull();
    expect(result!.messageThreadId).toBe(64001);
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

  it("touchMachine inserts on first call and updates once the stored value is stale", async () => {
    const id = "machine-touch";
    const lastPoll = async () =>
      (await env.DB.prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?").bind(id).first())!
        .last_poll_at;
    const t1 = Date.now();

    await touchMachine(env.DB, id, t1);
    expect(await lastPoll()).toBe(t1);

    // A poll inside the write interval writes nothing: this is what keeps D1 rows_written
    // under the free-tier cap (pigeon-wl7a).
    await touchMachine(env.DB, id, t1 + 5_000);
    await touchMachine(env.DB, id, t1 + HEARTBEAT_WRITE_INTERVAL_MS - 1);
    expect(await lastPoll()).toBe(t1);

    await touchMachine(env.DB, id, t1 + HEARTBEAT_WRITE_INTERVAL_MS);
    expect(await lastPoll()).toBe(t1 + HEARTBEAT_WRITE_INTERVAL_MS);
  });

  it("touchMachine reports zero rows written for a throttled poll", async () => {
    const id = "machine-touch-rows";
    const t1 = Date.now();
    await touchMachine(env.DB, id, t1);
    const stmt = touchMachineStatement(env.DB, id, t1 + 5_000);
    const result = await stmt.run();
    expect(result.meta.rows_written).toBe(0);
  });

  it("touchMachine repairs a last_poll_at that is in the future", async () => {
    const id = "machine-touch-future";
    const now = Date.now();
    await env.DB.prepare("INSERT INTO machines (machine_id, last_poll_at) VALUES (?, ?)")
      .bind(id, now + 3_600_000)
      .run();

    await touchMachine(env.DB, id, now);

    const row = await env.DB.prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?").bind(id).first();
    expect(row!.last_poll_at).toBe(now);
  });

  it("the online threshold tolerates a throttled heartbeat plus a long poll stall", () => {
    // Longest known single-tick stall in the daemon: a remote launch (health 5s + create 20s +
    // prompt 20s). See machine-liveness.ts.
    const DAEMON_POLL_INTERVAL_MS = 5_000;
    const LONGEST_TICK_STALL_MS = 45_000;
    expect(MACHINE_ONLINE_MS).toBeGreaterThanOrEqual(
      HEARTBEAT_WRITE_INTERVAL_MS + DAEMON_POLL_INTERVAL_MS + LONGEST_TICK_STALL_MS,
    );
    expect(RELAY_ONLINE_MS).toBe(MACHINE_ONLINE_MS);
    expect(LAUNCH_ONLINE_MS).toBe(MACHINE_ONLINE_MS);
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
    expect(rows.results[0]!.session_id).toBe("ses-1");
    expect(rows.results[1]!.session_id).toBe("ses-2");
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
  let em: SlackMachine;
  let eEnv: Env;
  let SESSION_ID: string;
  let channelId: string;
  const NOTIFICATION_ID = "edit-notif-id-001";

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    em = await mkSlackMachine();
    eEnv = envWith([em]);
    SESSION_ID = await seedSession(em.machineId, "edit-test");
    ({ channelId } = await seedSlackTopic(SESSION_ID, em.machineId, em.ws));
  });

  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
  });

  async function editNotification(body: Record<string, unknown>, key: string | null = em.key): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    return handleEditNotification(
      env.DB,
      eEnv,
      new Request("https://worker/notifications/edit", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  /** Send the original notification, so a messages row (and a post to edit) exists. */
  async function sendOriginal(notificationId: string, text: string): Promise<number> {
    slack("chat.postMessage", posted(channelId, `1.${stamp()}`));
    const res = await handleSendNotification(
      env.DB,
      eEnv,
      postJson("/notifications/send", em.key, { sessionId: SESSION_ID, text, notificationId }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { messageId: number }).messageId;
  }

  it("returns 401 for unauthenticated requests", async () => {
    const res = await editNotification({ notificationId: NOTIFICATION_ID, text: "new text" }, null);
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
    const id = `${NOTIFICATION_ID}-${stamp()}`;
    const messageId = await sendOriginal(id, "original text");
    expect(messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);

    slack("chat.update", { ok: true, ts: "1.1", channel: channelId });

    const editRes = await editNotification({ notificationId: id, text: "updated text" });

    expect(editRes.status).toBe(200);
    const editBody = (await editRes.json()) as { ok: boolean };
    expect(editBody.ok).toBe(true);
    expect(slackOf("chat.update")[0]?.params.get("channel")).toBe(channelId);
    expect(slackOf("chat.update")[0]?.params.get("text")).toContain("updated text");
  });

  it("passes replyMarkup to the edit when provided", async () => {
    const uniqueNotifId = `edit-markup-notif-${stamp()}`;
    await sendOriginal(uniqueNotifId, "original with markup");

    slack("chat.update", { ok: true, ts: "1.1", channel: channelId });

    const markup = { inline_keyboard: [[{ text: "Next step", callback_data: "next" }]] };
    const editRes = await editNotification({
      notificationId: uniqueNotifId,
      text: "updated with markup",
      replyMarkup: markup,
    });

    expect(editRes.status).toBe(200);
    const editBody = (await editRes.json()) as { ok: boolean };
    expect(editBody.ok).toBe(true);
    const blocks = JSON.parse(slackOf("chat.update")[0]!.params.get("blocks") ?? "[]") as Array<{ type: string; elements?: unknown[] }>;
    expect(blocks.find((b) => b.type === "actions")?.elements).toMatchObject([{ type: "button", value: "next" }]);
  });

  it("returns 502 when the provider's edit API fails", async () => {
    const uniqueNotifId = `edit-fail-notif-${stamp()}`;
    await sendOriginal(uniqueNotifId, "original text");

    slack("chat.update", { ok: false, error: "cant_update_message" });

    const editRes = await editNotification({
      notificationId: uniqueNotifId,
      text: "same or bad text",
    });

    expect(editRes.status).toBe(502);
    const editBody = (await editRes.json()) as { error: string };
    expect(editBody.error).toBe("provider_error");
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
      message_thread_id INTEGER,
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

  it("handlePollNext returns the tag for a launch carrying one", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, directory, metadata_json, status, created_at)
       VALUES (?, ?, NULL, 'launch', ?, ?, ?, ?, 'pending', ?)`,
    ).bind("launch-cmd-tag-1", "machine-launch-tag", "run all tests", "8248645256", "/home/dev/project",
           JSON.stringify({ tag: "launch-tag" }), now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-launch-tag/next"), "machine-launch-tag");
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("launch");
    expect(body.prompt).toBe("run all tests");
    expect(body.tag).toBe("launch-tag");
  });

  it("handlePollNext leaves the launch tag undefined when there is no metadata", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, directory, status, created_at)
       VALUES (?, ?, NULL, 'launch', ?, ?, ?, 'pending', ?)`,
    ).bind("launch-cmd-tag-2", "machine-launch-untagged", "run all tests", "8248645256", "/home/dev/project", now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-launch-untagged/next"), "machine-launch-untagged");
    const body = await res.json() as Record<string, unknown>;
    // Undefined, not "": an empty-string tag would fail the daemon's validator
    // and put a spurious "Tag not applied" line on every ordinary launch.
    expect(body.tag).toBeUndefined();
    expect("inheritFromSessionId" in body).toBe(false);
  });

  it("handlePollNext forwards inheritFromSessionId for a launch carrying one", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, directory, metadata_json, status, created_at)
       VALUES (?, ?, NULL, 'launch', ?, ?, ?, ?, 'pending', ?)`,
    ).bind("launch-cmd-inherit-1", "machine-launch-inherit", "run all tests", "8248645256", "/home/dev/project",
           JSON.stringify({ inheritFromSessionId: "ses_parent123" }), now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-launch-inherit/next"), "machine-launch-inherit");
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("launch");
    expect(body.inheritFromSessionId).toBe("ses_parent123");
    expect(body.tag).toBeUndefined();
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

  it("handlePollNext includes messageThreadId in response body for multiple command types", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, ?, 'execute', 'echo test', '8248645256', 64002, 'pending', ?)`
    ).bind("cmd-t214-exec", "machine-t214b", "ses_t214_exec", now).run();

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, ?, 'kill', '', '8248645256', 64002, 'pending', ?)`
    ).bind("cmd-t214-kill", "machine-t214b", "ses_t214_kill", now + 1).run();

    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, ?, 'mcp_list', '', '8248645256', 64002, 'pending', ?)`
    ).bind("cmd-t214-mcp", "machine-t214b", "ses_t214_mcp", now + 2).run();

    const res1 = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-t214b/next"), "machine-t214b");
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1.commandType).toBe("execute");
    expect(body1.messageThreadId).toBe(64002);

    const res2 = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-t214b/next"), "machine-t214b");
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2.commandType).toBe("kill");
    expect(body2.messageThreadId).toBe(64002);

    const res3 = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-t214b/next"), "machine-t214b");
    expect(res3.status).toBe(200);
    const body3 = await res3.json() as Record<string, unknown>;
    expect(body3.commandType).toBe("mcp_list");
    expect(body3.messageThreadId).toBe(64002);
  });

  it("handlePollNext yields null for messageThreadId when thread id is absent", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'execute', 'echo test', '8248645256', 'pending', ?)`
    ).bind("cmd-t214-nothread", "machine-t214c", "ses_t214_nothread", now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-t214c/next"), "machine-t214c");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandId).toBe("cmd-t214-nothread");
    expect(body.messageThreadId).toBeNull();
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

  it("handlePollNext returns sessionId only for tag_top", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'tag_top', '', ?, 'pending', ?)`,
    ).bind("tag-top-cmd-1", "machine-tag-top", "sess-tag-top-1", "8248645256", now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-tag-top/next"), "machine-tag-top");
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("tag_top");
    expect(body.sessionId).toBe("sess-tag-top-1");
  });

  it("handlePollNext returns tag and targetSessionId for tag_set", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, metadata_json, status, created_at)
       VALUES (?, ?, ?, 'tag_set', ?, ?, ?, 'pending', ?)`,
    ).bind("tag-set-cmd-1", "machine-tag-set", "sess-tag-ctx-1", "billing", "8248645256",
           JSON.stringify({ targetSessionId: "ses_other" }), now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-tag-set/next"), "machine-tag-set");
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("tag_set");
    expect(body.sessionId).toBe("sess-tag-ctx-1");
    expect(body.targetSessionId).toBe("ses_other");
    expect(body.tag).toBe("billing");
  });

  it("handlePollNext leaves targetSessionId undefined when tag_set metadata is missing", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES (?, ?, ?, 'tag_set', ?, ?, 'pending', ?)`,
    ).bind("tag-set-cmd-2", "machine-tag-set-2", "sess-tag-ctx-2", "billing", "8248645256", now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-tag-set-2/next"), "machine-tag-set-2");
    const body = await res.json() as Record<string, unknown>;
    // Deliberately NOT the context session: tagging the wrong session silently
    // is worse than the daemon rejecting an absent id out loud.
    expect(body.targetSessionId).toBeUndefined();
  });

  it("handlePollNext returns tag and pattern for tag_set_dir", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, metadata_json, status, created_at)
       VALUES (?, ?, ?, 'tag_set_dir', ?, ?, ?, 'pending', ?)`,
    ).bind("tag-dir-cmd-1", "machine-tag-dir", "sess-tag-ctx-3", "fbm", "8248645256",
           JSON.stringify({ pattern: "/home/dev/projects/mono/.worktrees/*" }), now).run();

    const res = await handlePollNext(env.DB, env, makeRequest("https://worker/machines/machine-tag-dir/next"), "machine-tag-dir");
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("tag_set_dir");
    expect(body.tag).toBe("fbm");
    expect(body.pattern).toBe("/home/dev/projects/mono/.worktrees/*");
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
});

// ─── /mcp Command: Integration Tests ─────────────────────────────────

// ─── /model Command: Integration Tests ───────────────────────────────

// ─── /rename Command: Integration Tests ─────────────────────────────────

// ─── Bot Username Command Suffix (/cmd@bot) Tests ─────────────────────────

// ─── Swipe-Reply to Question Notification: Integration Tests ──────────

// ─── Question Notification ID Chunk Suffix Parsing ────────────────────────

// ─── resolveCallbackSession Question Notification Parsing ───────────────────

// ─── Task T2.13: Inbound message resolution by forum topic membership ──

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
  describe("topicName formatting and surrogate clamping", () => {
    it("passes short dir and title through unchanged in title · dir order", () => {
      expect(topicName("pigeon", "Fix flaky auth test")).toBe("Fix flaky auth test · pigeon");
    });

    it("abbreviates home directory in dir suffix", () => {
      expect(topicName("/home/dev/projects/pigeon", "Fix bug")).toBe("Fix bug · ~/projects/pigeon");
      expect(topicName("/Users/jonathan/projects/pigeon", "Fix bug")).toBe("Fix bug · ~/projects/pigeon");
      expect(topicName("/var/tmp/build", "Fix bug")).toBe("Fix bug · /var/tmp/build");
      expect(topicName("/home/dev", "Fix bug")).toBe("Fix bug · ~");
      expect(topicName("/homework/notes", "Fix bug")).toBe("Fix bug · /homework/notes");
      expect(topicName("~/projects/pigeon", "Fix bug")).toBe("Fix bug · ~/projects/pigeon");
    });

    it("truncates long dir suffix while preserving full title", () => {
      const longPath = "/home/dev/projects/workstation/.worktrees/monitoring-mergequeue-fix-and-very-long-path-segment-that-keeps-going-and-going-until-it-exceeds-128-chars";
      const shortTitle = "Merge-queue deploy monitoring gap";
      const name = topicName(longPath, shortTitle);
      expect(name.startsWith(shortTitle)).toBe(true);
      expect(name.endsWith("…")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(128);
      // The surviving suffix must still be an abbreviated, usable path. Without this the test
      // would pass even if clamping dropped the directory entirely.
      expect(name).toContain("· ~/projects/workstation");
    });

    it("handles missing/empty dir or title gracefully", () => {
      expect(topicName("", "Fix test")).toBe("Fix test");
      expect(topicName("pigeon", "")).toBe("pigeon");
      expect(topicName("/home/dev", "")).toBe("~");
      expect(topicName("   ", "   ")).toBe("session");
    });

    it("replaces internal newlines with single spaces", () => {
      expect(topicName("pigeon", "Fix\nflaky\r\nauth\r test")).toBe("Fix flaky auth test · pigeon");
    });

    it("clamps 128-emoji title to <= 128 UTF-16 code units", () => {
      const emojiTitle = "😀".repeat(128);
      const name = topicName("pigeon", emojiTitle);
      expect(name.length).toBeLessThanOrEqual(128);
      expect(hasUnpairedSurrogate(name)).toBe(false);
    });

    it("preserves an astral character landing exactly on boundary or drops it safely", () => {
      // 122 'a's (title) + " · " + "a😀b" (dir) => 122 + 3 + 1 + 2 + 1 = 129 UTF-16 units.
      // Index 126 falls on high surrogate of 😀, index 127 on low surrogate.
      // max=127 checks index 126, finds high surrogate, drops it safely to prevent orphan high surrogate.
      const name1 = topicName("a😀b", "a".repeat(122));
      expect(name1.length).toBeLessThanOrEqual(128);
      expect(hasUnpairedSurrogate(name1)).toBe(false);
      expect(name1.endsWith("…")).toBe(true);

      // 122 'a's (title) + " · " + "😀bc" (dir) => 122 + 3 + 2 + 1 + 1 = 129 UTF-16 units.
      // Index 125 falls on high surrogate of 😀, index 126 on low surrogate.
      // max=127 checks index 126, finds low surrogate, keeps complete pair.
      const name2 = topicName("😀bc", "a".repeat(122));
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
      const reapable = await listReapable(env.DB, { closedBefore: now - 200, updatedBefore: now - 100, limit: 10 });
      expect(reapable.map((r: { session_id: string }) => r.session_id)).toEqual([s2, s3]);

      // Test limit
      const reapableLimit = await listReapable(env.DB, { closedBefore: now - 200, updatedBefore: now - 100, limit: 1 });
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

  describe("deleteTopicBySession scoping and reaper counter honesty (pigeon-5o7)", () => {
    const chatId = "-1001234567890";

    beforeEach(() => {
      fetchMock.activate();
      fetchMock.disableNetConnect();
    });

    afterEach(() => {
      fetchMock.deactivate();
    });

    it("1. The race: a late delete scoped to stale thread T is a no-op; T2 row survives", async () => {
      const sessionId = "ses_5o7_race";
      const staleThreadId = 885501;
      const newThreadId = 885502;
      const now = Date.now();

      // Finalized topic row exists for newThreadId T2
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId, name: "race topic", now });
      await finalize(env.DB, { sessionId, messageThreadId: newThreadId, now });

      // Late caller B observed stale thread T1 and attempts to delete it
      const deleted = await deleteTopicBySession(env.DB, sessionId, chatId, staleThreadId);
      expect(deleted).toBe(false);

      // Finalized T2 row must still exist in D1
      const row = await getBySession(env.DB, sessionId);
      expect(row).not.toBeNull();
      expect(row?.message_thread_id).toBe(newThreadId);
    });

    it("2. Normal path: delete scoped to matching thread id removes the row", async () => {
      const sessionId = "ses_5o7_normal";
      const threadId = 885503;
      const now = Date.now();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId, name: "normal topic", now });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now });

      const deleted = await deleteTopicBySession(env.DB, sessionId, chatId, threadId);
      expect(deleted).toBe(true);

      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("3. NULL-thread row: delete scoped to null removes reservation row with message_thread_id IS NULL", async () => {
      const sessionId = "ses_5o7_null";
      const now = Date.now();

      // Reservation row with message_thread_id IS NULL
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId, name: "reservation topic", now });

      const deleted = await deleteTopicBySession(env.DB, sessionId, chatId, null);
      expect(deleted).toBe(true);

      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("4. Reaper NULL branch end-to-end: reapTopics reaps a NULL-thread row and reports it", async () => {
      await env.DB.prepare("DELETE FROM topics").run();
      const sessionId = "ses_5o7_reap_null";
      const now = Date.now();
      const closedLongAgo = now - REAP_TTL_MS - 10000;

      // Seed closed topic row with message_thread_id IS NULL
      await env.DB.prepare(
        `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at, closed_at)
         VALUES (?, 'devbox', ?, NULL, 'reap null topic', 'closed', ?, ?, ?)`
      ).bind(sessionId, chatId, closedLongAgo, closedLongAgo, closedLongAgo).run();

      const res = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });
      expect(res.reaped).toBe(1);

      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });
  });

  describe("topic manager resolveTopic", () => {
    // Provider results are scripted through an injected transport (Slack-shaped addresses).
    const topicChatId = "slack:TTOPICMGR";

    it("two concurrent resolveTopic calls -> exactly one createConversation, both get same thread id", async () => {
      const sessionId = "ses_topic_concurrent";

      const { client, calls } = fakeTransport({
        createConversation: () => ({
          ok: true,
          result: { messageThreadId: 101, name: "pigeon · test" },
        }),
      });

      const noopDelay = async () => {};

      const [res1, res2] = await Promise.all([
        resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "test",
          delayFn: noopDelay,
          transport: client,
        }),
        resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "test",
          delayFn: noopDelay,
          transport: client,
        }),
      ]);

      expect(calls.createConversation).toHaveLength(1);
      expect(res1).toMatchObject({ ok: true, messageThreadId: 101 });
      expect(res2).toMatchObject({ ok: true, messageThreadId: 101 });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(101);
    });

    it("slow winner -> loser polls to success and shares thread id", async () => {
      const sessionId = "ses_topic_slow_winner";

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
        delayFn: customDelay,
        pollAttempts: 5,
      });

      expect(pollCount).toBe(5);
      expect(res).toEqual({ ok: true, messageThreadId: null, reason: "poll_exhausted", transient: true });
    });

    // pigeon-bit4 / S2: reachable without an isolate race -- finalize's CAS also returns false
    // when the reservation row has been DELETED, so a rival that cleaned up rather than
    // finalizing leaves this caller with a created topic it cannot claim and no winner to
    // defer to. That path sent to General in silence.
    it("lost finalize CAS with no winner row warns that the notification will go to General", async () => {
      const sessionId = "ses_bit4_warn_no_winner";

      const { client, calls } = fakeTransport({
        createConversation: async () => {
          // A rival deletes the reservation instead of finalizing it, so the CAS below
          // matches zero rows AND the re-read finds nothing.
          await deleteBySession(env.DB, sessionId);
          return {
            ok: true as const,
            result: { messageThreadId: 606, name: "pigeon · no winner" },
          };
        },
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "no winner",
          transport: client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: null, reason: "finalize_lost_no_winner", transient: true });
        expect(calls.deleteConversation).toEqual([{ chatId: topicChatId, messageThreadId: 606 }]);
        const warn = warnSpy.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("no topic resolved"),
        );
        expect(warn).toBeDefined();
        expect(warn![1]).toMatchObject({ sessionId, reason: "finalize_lost_no_winner" });
      } finally {
        warnSpy.mockRestore();
      }
    });

    // pigeon-bit4 / S2: poll exhaustion is a plausible cause of a misfiled notification under
    // exactly the kind of load that produced the incident, and it returned null in silence.
    it("poll exhaustion warns that the notification will go to General", async () => {
      const sessionId = "ses_bit4_warn_poll_exhausted";

      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        name: "pigeon · exhausted",
        now: Date.now(),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "exhausted",
          delayFn: async () => {},
          pollAttempts: 2,
        });

        expect(res).toEqual({ ok: true, messageThreadId: null, reason: "poll_exhausted", transient: true });
        const warn = warnSpy.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("no topic resolved"),
        );
        expect(warn).toBeDefined();
        expect(warn![1]).toMatchObject({ sessionId, reason: "poll_exhausted" });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("create rejects (non-429) -> reservation row gone -> next resolveTopic wins and creates", async () => {
      const sessionId = "ses_topic_create_rejects";

      let call = 0;
      const { client } = fakeTransport({
        createConversation: () =>
          ++call === 1
            ? results.error(400, "Bad Request: chat not found")
            : { ok: true, result: { messageThreadId: 303, name: "pigeon · err" } },
      });

      const res1 = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err",
        transport: client,
      });

      expect(res1).toEqual({
        ok: true,
        messageThreadId: null,
        reason: "create_failed",
        transient: false,
        createError: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      });
      // Reservation row was conditional-deleted
      expect(await getBySession(env.DB, sessionId)).toBeNull();

      // Next resolveTopic call succeeds
      const res2 = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err",
        transport: client,
      });

      expect(res2).toEqual({ ok: true, messageThreadId: 303 });
      expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(303);
    });

    it("create rejects with a 5xx (520) -> transient true, createError carries error_code", async () => {
      const sessionId = "ses_topic_create_520";

      const { client } = fakeTransport({
        createConversation: () => results.error(520, "Unknown Error"),
      });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err520",
        transport: client,
      });

      expect(res).toEqual({
        ok: true,
        messageThreadId: null,
        reason: "create_failed",
        transient: true,
        createError: { ok: false, error_code: 520, description: "Unknown Error" },
      });
    });

    it("create rejects with 4xx (400 not enough rights) -> transient false, createError carries error_code", async () => {
      const sessionId = "ses_topic_create_400_rights";

      const { client } = fakeTransport({
        createConversation: () => results.error(400, "Bad Request: not enough rights to create a topic"),
      });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "err400",
        transport: client,
      });

      expect(res).toEqual({
        ok: true,
        messageThreadId: null,
        reason: "create_failed",
        transient: false,
        createError: { ok: false, error_code: 400, description: "Bad Request: not enough rights to create a topic" },
      });
    });

    it("topic_in_other_chat -> transient false", async () => {
      const sessionId = "ses_topic_in_other_chat";
      const now = Date.now();
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: "slack:TOTHERCHAT", // different chat
        name: "pigeon · other",
        now,
      });
      await finalize(env.DB, { sessionId, messageThreadId: 777, now });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "other",
      });

      expect(res).toEqual({
        ok: true,
        messageThreadId: null,
        reason: "topic_in_other_chat",
        transient: false,
      });
    });

    it("create returns 429 -> reservation gone and rate_limited propagated with retryAfter", async () => {
      const sessionId = "ses_topic_429";

      const { client } = fakeTransport({ createConversation: () => results.rateLimited(15) });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "rate",
        transport: client,
      });

      expect(res).toEqual({ ok: false, kind: "rate_limited", retryAfter: 15 });
      // Reservation row was conditional-deleted
      expect(await getBySession(env.DB, sessionId)).toBeNull();
    });

    it("stale NULL reservation (past TTL) -> steal -> create -> finalize", async () => {
      const sessionId = "ses_topic_stale_steal";
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

      const { client, calls } = fakeTransport({
        createConversation: () => ({ ok: true, result: { messageThreadId: 404, name: "pigeon · fresh" } }),
      });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "fresh",
        now,
        delayFn: async () => {},
        transport: client,
      });

      expect(calls.createConversation).toHaveLength(1);
      expect(res).toEqual({ ok: true, messageThreadId: 404 });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(404);
      expect(row?.machine_id).toBe("devbox");
    });

    it("slow original winner's finalize CAS loses -> compensating deleteConversation fires", async () => {
      const sessionId = "ses_topic_finalize_cas_loses";

      // Winner 1 calls resolveTopic, but right before returning from createConversation, Winner 2 finalizes with threadId 999
      const { client, calls } = fakeTransport({
        createConversation: async () => {
          // Right before returning from createConversation, Winner 2 finalizes
          await finalize(env.DB, { sessionId, messageThreadId: 999, name: "winner 2" });
          return {
            ok: true as const,
            result: { messageThreadId: 505, name: "pigeon · cas" },
          };
        },
      });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "cas",
        transport: client,
      });

      // Winner 1's finalize CAS failed (message_thread_id was already 999)
      // Winner 1 executed compensating deleteConversation for 505
      expect(calls.deleteConversation).toEqual([{ chatId: topicChatId, messageThreadId: 505 }]);
      // Winner 1 re-read D1 and returned Winner 2's thread id 999
      expect(res).toEqual({ ok: true, messageThreadId: 999 });
    });

    describe("Task T2.6: Reopen-on-closed", () => {
      const sessionId = "ses_closed_topic";

      it("resolving a state='closed' topic calls unarchiveConversation and flips state to open", async () => {
        const now = Date.now();
        // Seed a closed topic in D1
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · closed", now });
        await finalize(env.DB, { sessionId, messageThreadId: 888, now });
        await markClosed(env.DB, { sessionId, now });

        const { client, calls } = fakeTransport();

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed",
          now: now + 1000,
          transport: client,
        });

        expect(calls.unarchiveConversation).toEqual([{ chatId: topicChatId, messageThreadId: 888 }]);
        expect(res).toEqual({ ok: true, messageThreadId: 888 });

        const row = await getBySession(env.DB, sessionId);
        expect(row?.state).toBe("open");
        expect(row?.closed_at).toBeNull();
      });

      it("unarchiveConversation returns 429 rate_limited -> propagates rate_limited error", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId: "ses_closed_429", machineId: "devbox", chatId: topicChatId, name: "pigeon · closed 429", now });
        await finalize(env.DB, { sessionId: "ses_closed_429", messageThreadId: 889, now });
        await markClosed(env.DB, { sessionId: "ses_closed_429", now });

        const { client } = fakeTransport({ unarchiveConversation: () => results.rateLimited(10) });

        const res = await resolveTopic(env.DB, {
          sessionId: "ses_closed_429",
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed 429",
          now: now + 1000,
          transport: client,
        });

        expect(res).toEqual({ ok: false, kind: "rate_limited", retryAfter: 10 });

        const row = await getBySession(env.DB, "ses_closed_429");
        expect(row?.state).toBe("closed");
      });

      it("unarchiveConversation returns topic_not_modified -> returns messageThreadId and flips state to open", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId: "ses_closed_not_mod", machineId: "devbox", chatId: topicChatId, name: "pigeon · closed not mod", now });
        await finalize(env.DB, { sessionId: "ses_closed_not_mod", messageThreadId: 994001, now });
        await markClosed(env.DB, { sessionId: "ses_closed_not_mod", now });

        const { client } = fakeTransport({ unarchiveConversation: () => results.notModified() });

        const res = await resolveTopic(env.DB, {
          sessionId: "ses_closed_not_mod",
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed not mod",
          now: now + 1000,
          transport: client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 994001 });

        const row = await getBySession(env.DB, "ses_closed_not_mod");
        expect(row?.state).toBe("open");
      });

      it("unarchiveConversation returns generic error (e.g. not enough rights) -> returns messageThreadId but leaves state closed", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId: "ses_closed_rights_err", machineId: "devbox", chatId: topicChatId, name: "pigeon · closed rights err", now });
        await finalize(env.DB, { sessionId: "ses_closed_rights_err", messageThreadId: 994002, now });
        await markClosed(env.DB, { sessionId: "ses_closed_rights_err", now });

        const { client } = fakeTransport({
          unarchiveConversation: () => results.error(400, "Bad Request: not enough rights to manage topics"),
        });

        const res = await resolveTopic(env.DB, {
          sessionId: "ses_closed_rights_err",
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "closed rights err",
          now: now + 1000,
          transport: client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 994002 });

        const row = await getBySession(env.DB, "ses_closed_rights_err");
        expect(row?.state).toBe("closed");
      });
    });

    describe("Task T2.7: Stale-thread recovery in resolveTopic", () => {
      const sessionId = "ses_reopen_stale";

      it("unarchiveConversation returns thread_not_found -> deletes stale D1 row and recreates topic", async () => {
        const now = Date.now();
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · stale closed", now });
        await finalize(env.DB, { sessionId, messageThreadId: 700, now });
        await markClosed(env.DB, { sessionId, now });

        // reopen returns thread_not_found; createConversation succeeds for new thread 701
        const { client } = fakeTransport({
          unarchiveConversation: () => results.threadNotFound(),
          createConversation: () => ({ ok: true, result: { messageThreadId: 701, name: "pigeon · stale closed" } }),
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "pigeon",
          title: "stale closed",
          now: now + 1000,
          transport: client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 701 });

        const row = await getBySession(env.DB, sessionId);
        expect(row?.message_thread_id).toBe(701);
        expect(row?.state).toBe("open");
      });
    });

    describe("pigeon-353p: provisional names and the one-shot upgrade rename", () => {

      /**
       * These tests inject a fake transport rather than using `fetchMock`.
       * That is deliberate: `upgradeProvisionalName` swallows every error, so an unexpected call
       * against an unregistered undici interceptor throws MockNotMatchedError, is caught, and the
       * "no Telegram call was made" assertions pass whether or not the call happened. A counting
       * fake makes those assertions capable of failing, and it also avoids leaking unconsumed
       * interceptors into later tests in this file.
       */
      // A view over the typed fakeTransport, so a renamed transport method fails typecheck instead
      // of throwing into upgradeProvisionalName's catch-all and passing the `edit === 0` cases.
      function fakeChat(handlers: Parameters<typeof fakeTransport>[0]) {
        const { client, calls: byMethod } = fakeTransport(handlers);
        const calls = {
          get create() { return byMethod.createConversation.length; },
          get reopen() { return byMethod.unarchiveConversation.length; },
          get edit() { return byMethod.renameConversation.length; },
          get delete() { return byMethod.deleteConversation.length; },
        };
        return {
          client,
          calls,
          get editedNames() { return byMethod.renameConversation.map((o) => o.name); },
        };
      }

      async function seedProvisionalTopic(
        sessionId: string,
        messageThreadId: number,
        name: string,
        now = Date.now(),
      ): Promise<void> {
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name, now });
        await finalize(env.DB, { sessionId, messageThreadId, name, provisional: true, now });
      }

      it("isPlaceholderTitle matches opencode's default title and nothing a human would type", () => {
        expect(isPlaceholderTitle("New session - 2026-08-11T10:11:16.127Z")).toBe(true);
        expect(isPlaceholderTitle("  New session - 2026-08-11T10:11:16.127Z  ")).toBe(true);
        expect(isPlaceholderTitle("New session - 2026-08-11T10:11:16Z")).toBe(true);
        expect(isPlaceholderTitle("")).toBe(false);
        expect(isPlaceholderTitle("New session handling in the reaper")).toBe(false);
        expect(isPlaceholderTitle("Fix New session - 2026-08-11T10:11:16.127Z parsing")).toBe(false);
      });

      it("isPlaceholderTitle matches goose's default title exactly", () => {
        expect(isPlaceholderTitle("New Chat")).toBe(true);
        expect(isPlaceholderTitle(" New Chat ")).toBe(true);
        expect(isPlaceholderTitle("New Chat button styling")).toBe(false);
      });

      it("a placeholder title never reaches the topic name; the topic is marked provisional", async () => {
        const sessionId = "ses_prov_create";
        const tg = fakeChat({ createConversation: (o) => ({ ok: true, result: { messageThreadId: 900, name: o.name } }) });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/protos/.worktrees/pr-698",
          title: "New session - 2026-08-11T10:11:16.127Z",
          transport: tg.client,
        });

        expect(res).toMatchObject({ ok: true, messageThreadId: 900 });
        const row = await getBySession(env.DB, sessionId);
        expect(row?.name).toBe("~/projects/protos/.worktrees/pr-698");
        expect(row?.name_provisional).toBe(1);
      });

      it("a real title at creation is not provisional", async () => {
        const sessionId = "ses_prov_real";
        const tg = fakeChat({ createConversation: (o) => ({ ok: true, result: { messageThreadId: 901, name: o.name } }) });

        await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          transport: tg.client,
        });

        const row = await getBySession(env.DB, sessionId);
        expect(row?.name).toBe("Real title · ~/projects/pigeon");
        expect(row?.name_provisional).toBe(0);
      });

      it("a later notification carrying a real title renames the topic once and clears the flag", async () => {
        const sessionId = "ses_prov_upgrade";
        await seedProvisionalTopic(sessionId, 902, "~/projects/protos/.worktrees/pr-698");
        const tg = fakeChat({});

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/protos/.worktrees/pr-698",
          title: "PR review using .lgtm-review-prompt.md",
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 902 });
        expect(tg.calls.edit).toBe(1);
        expect(tg.editedNames[0]).toBe(
          "PR review using .lgtm-review-prompt.md · ~/projects/protos/.worktrees/pr-698",
        );

        const row = await getBySession(env.DB, sessionId);
        expect(row?.name).toBe("PR review using .lgtm-review-prompt.md · ~/projects/protos/.worktrees/pr-698");
        expect(row?.name_provisional).toBe(0);

        // Second notification for the same session must not touch Telegram again — the whole
        // point of the flag is that the upgrade is one-shot, not per-notification.
        const res2 = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/protos/.worktrees/pr-698",
          title: "A drifted TUI title",
          transport: tg.client,
        });
        expect(res2).toEqual({ ok: true, messageThreadId: 902 });
        expect(tg.calls.edit).toBe(1);
        expect((await getBySession(env.DB, sessionId))?.name).toBe(
          "PR review using .lgtm-review-prompt.md · ~/projects/protos/.worktrees/pr-698",
        );
      });

      it("a provisional topic with no title yet burns no Telegram call", async () => {
        const sessionId = "ses_prov_notitle";
        await seedProvisionalTopic(sessionId, 903, "~/projects/pigeon");
        const tg = fakeChat({});

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "New session - 2026-08-11T10:11:16.127Z",
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 903 });
        expect(tg.calls.edit).toBe(0);
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(1);
      });

      it("a failed edit leaves the flag set and never fails the notification", async () => {
        const sessionId = "ses_prov_editfail";
        await seedProvisionalTopic(sessionId, 904, "~/projects/pigeon");
        const tg = fakeChat({
          renameConversation: () => results.rateLimited(30),
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          transport: tg.client,
        });

        // Delivery is unaffected: a cosmetic rename must never turn into a 429 for the caller.
        expect(res).toEqual({ ok: true, messageThreadId: 904 });
        const row = await getBySession(env.DB, sessionId);
        expect(row?.name).toBe("~/projects/pigeon");
        expect(row?.name_provisional).toBe(1);
      });

      it("an renameConversation that throws is swallowed and leaves the flag set", async () => {
        const sessionId = "ses_prov_editthrow";
        await seedProvisionalTopic(sessionId, 912, "~/projects/pigeon");
        const tg = fakeChat({
          renameConversation: () => {
            throw new Error("network down");
          },
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 912 });
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(1);
      });

      it("topic_not_modified counts as success and clears the flag", async () => {
        const sessionId = "ses_prov_notmodified";
        await seedProvisionalTopic(sessionId, 905, "~/projects/pigeon");
        const tg = fakeChat({
          renameConversation: () => results.notModified(),
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 905 });
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(0);
      });

      it("falls back to the provisional name as the dir when the notification carries none", async () => {
        const sessionId = "ses_prov_nodir";
        await seedProvisionalTopic(sessionId, 906, "~/projects/pigeon");
        const tg = fakeChat({});

        await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "",
          title: "Real title",
          transport: tg.client,
        });

        expect(tg.editedNames).toEqual(["Real title · ~/projects/pigeon"]);
      });

      it("never reuses a backfilled placeholder NAME as the directory", async () => {
        // The one-off runbook backfill marks pre-existing rows provisional, and their names are
        // `New session - <ISO> · ~/path`, not a bare directory. Feeding one back in as the dir
        // would permanently bake the timestamp into the upgraded name.
        const sessionId = "ses_prov_backfilled";
        await seedProvisionalTopic(
          sessionId,
          908,
          "New session - 2026-08-11T10:11:16.127Z · ~/projects/pigeon",
        );
        const tg = fakeChat({});

        await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "",
          title: "Real title",
          transport: tg.client,
        });

        expect(tg.editedNames).toEqual(["Real title"]);
        expect((await getBySession(env.DB, sessionId))?.name).toBe("Real title");
      });

      it("a backfilled row still gets its path back when the notification carries a dir", async () => {
        const sessionId = "ses_prov_backfilled_dir";
        await seedProvisionalTopic(
          sessionId,
          913,
          "New session - 2026-08-11T10:11:16.127Z · ~/projects/pigeon",
        );
        const tg = fakeChat({});

        await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          transport: tg.client,
        });

        expect(tg.editedNames).toEqual(["Real title · ~/projects/pigeon"]);
      });

      it("upgrades on the reopen-succeeded branch of a closed topic", async () => {
        const sessionId = "ses_prov_reopened";
        const now = Date.now();
        await seedProvisionalTopic(sessionId, 909, "~/projects/pigeon", now);
        await markClosed(env.DB, { sessionId, now });
        const tg = fakeChat({});

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          now: now + 1000,
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 909 });
        expect(tg.editedNames).toEqual(["Real title · ~/projects/pigeon"]);
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(0);
      });

      it("upgrades on the reopen topic_not_modified branch", async () => {
        const sessionId = "ses_prov_reopen_notmod";
        const now = Date.now();
        await seedProvisionalTopic(sessionId, 910, "~/projects/pigeon", now);
        await markClosed(env.DB, { sessionId, now });
        const tg = fakeChat({
          unarchiveConversation: () => results.notModified(),
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          now: now + 1000,
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 910 });
        expect(tg.editedNames).toEqual(["Real title · ~/projects/pigeon"]);
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(0);
      });

      it("does NOT spend a rename call on the branch where reopen genuinely failed", async () => {
        const sessionId = "ses_prov_reopen_failed";
        const now = Date.now();
        await seedProvisionalTopic(sessionId, 911, "~/projects/pigeon", now);
        await markClosed(env.DB, { sessionId, now });
        const tg = fakeChat({
          unarchiveConversation: () => results.error(500, "boom"),
        });

        const res = await resolveTopic(env.DB, {
          sessionId,
          machineId: "devbox",
          chatId: topicChatId,
          dir: "/home/dev/projects/pigeon",
          title: "Real title",
          now: now + 1000,
          transport: tg.client,
        });

        expect(res).toEqual({ ok: true, messageThreadId: 911 });
        expect(tg.calls.edit).toBe(0);
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(1);
      });

      it("renameProvisional is a CAS: it cannot overwrite a name a /rename already claimed", async () => {
        const sessionId = "ses_prov_cas";
        await seedProvisionalTopic(sessionId, 907, "~/projects/pigeon");

        // A manual /rename lands first: it clears the provisional flag unconditionally.
        expect(await rename(env.DB, { sessionId, name: "Human chosen" })).toBe(true);
        expect((await getBySession(env.DB, sessionId))?.name_provisional).toBe(0);

        // The in-flight auto-rename then loses the CAS and writes nothing.
        expect(await renameProvisional(env.DB, { sessionId, name: "Robot chosen · ~/projects/pigeon" })).toBe(false);
        const row = await getBySession(env.DB, sessionId);
        expect(row?.name).toBe("Human chosen");
      });
    });
  });

  // The threading, recovery, fallback and hold rules of POST /notifications/send (T2.5, T2.7, T2.8,
  // T2.9, pigeon-iqpd, pigeon-533h, pigeon-bit4), run against a Slack workspace. A "topic" is a
  // channel and its thread id a handle; "thread not found" is `channel_not_found`.
  describe("notification delivery on Slack: threads, recovery, fallback and holds", () => {
    let dm: SlackMachine;
    let dEnv: Env;
    let srv: ReturnType<typeof fakeSlack>;

    beforeEach(async () => {
      resetSlackCalls();
      fetchMock.activate();
      fetchMock.disableNetConnect();
      dm = await mkSlackMachine();
      dEnv = envWith([dm]);
      srv = fakeSlack();
    });

    afterEach(() => {
      fetchMock.get("https://slack.com").cleanMocks();
      fetchMock.get("https://files.slack.com").cleanMocks();
      fetchMock.deactivate();
    });

    const chat = () => slackChatId(dm.ws);
    const newSession = (label = "pigeon") => seedSession(dm.machineId, label);
    const send = (sessionId: string, extra: Record<string, unknown> = {}, key = dm.key, e = dEnv) =>
      handleSendNotification(
        env.DB,
        e,
        postJson("/notifications/send", key, {
          sessionId,
          text: "Task completed",
          title: "My Topic",
          dir: "pigeon",
          threaded: true,
          ...extra,
        }),
      );
    const handleOf = async (channelId: string) =>
      (await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
        .bind(dm.ws.teamId, channelId)
        .first<{ handle: number }>())!.handle;
    const gone = { ok: false, error: "channel_not_found" };
    const badGateway = { status: 502, body: { ok: false, error: "bad_gateway" } };
    const messagesFor = (sessionId: string) =>
      env.DB.prepare("SELECT * FROM messages WHERE session_id = ?").bind(sessionId).first();
    const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});

    // ── T2.5: threaded delivery ──

    it("threaded: false -> the post is unthreaded (the workspace's #alerts) and no topic is created", async () => {
      const sessionId = await newSession();
      const alerts = await seedAlerts(dm.ws);

      const res = await send(sessionId, { threaded: false });

      expect(res.status).toBe(200);
      expect(srv.postedTo()).toEqual([alerts]);
      expect(srv.created).toEqual([]);
      expect(await getBySession(env.DB, sessionId)).toBeNull();
    });

    it("topic resolution succeeds -> a channel is created and the post carries its handle", async () => {
      const sessionId = await newSession();

      const res = await send(sessionId);

      expect(res.status).toBe(200);
      expect(srv.created).toHaveLength(1);
      expect(srv.created[0]!.name).toMatch(/^my-topic-/);
      expect(srv.postedTo()).toEqual([srv.created[0]!.id]);
      const row = await getBySession(env.DB, sessionId);
      expect(row?.chat_id).toBe(chat());
      expect(row?.message_thread_id).toBe(await handleOf(srv.created[0]!.id));
    });

    // ── T2.7: stale-thread recovery ──

    it("a conversation deleted out of band -> deletes the stale row, recreates the topic, retries the send once", async () => {
      const sessionId = await newSession();
      const old = await seedSlackTopic(sessionId, dm.machineId, dm.ws, "pigeon · stale send");
      srv.gone.add(old.channelId);

      const res = await send(sessionId, { title: "stale send" });

      expect(res.status).toBe(200);
      expect(srv.created).toHaveLength(1);
      expect(srv.postedTo()).toEqual([old.channelId, srv.created[0]!.id]);
      const row = await getBySession(env.DB, sessionId);
      expect(row?.message_thread_id).toBe(await handleOf(srv.created[0]!.id));
      expect(row?.message_thread_id).not.toBe(old.handle);
    });

    it("recursion guard: the retry also finds nothing -> does NOT recreate again (at most once)", async () => {
      const sessionId = await newSession();
      const old = await seedSlackTopic(sessionId, dm.machineId, dm.ws, "pigeon · recursion");
      const alerts = await seedAlerts(dm.ws);
      srv.script("chat.postMessage", gone, gone);

      const res = await send(sessionId, { title: "recursion" });

      expect(res.status).toBe(200); // Falls back to General and delivers
      expect(srv.created).toHaveLength(1); // Exactly 1 recreate attempt
      const posted = srv.postedTo();
      expect(posted[0]).toBe(old.channelId);
      expect(posted[1]).toBe(srv.created[0]!.id);
      expect(posted[2]).toBe(alerts); // then General
    });

    // ── T2.8: fallback rules ──

    it("a permanent failure of a topic send -> falls back to General and succeeds", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws, "pigeon · fallback");
      const alerts = await seedAlerts(dm.ws);
      // Slack refuses the payload, and refuses the transport's own plain retry too.
      const refused = { ok: false, error: "invalid_blocks" };
      srv.script("chat.postMessage", refused, refused);

      const res = await send(sessionId, { title: "fallback" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, messageId: expect.any(Number), token: expect.any(String) });
      const posted = srv.postedTo();
      expect(posted.slice(0, 2)).toEqual([topic.channelId, topic.channelId]);
      expect(posted[2]).toBe(alerts); // General
    });

    // pigeon-bit4: a 5xx is transient, so relocating the message to General discards the topic
    // permanently for a condition that would have cleared on the next attempt. The outbox retries
    // a 502, and it retries into the RIGHT topic.
    it("5xx topic send failure -> returns 502 for outbox retry and does NOT fall back to General", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      srv.script("chat.postMessage", badGateway);

      const res = await send(sessionId);

      expect(res.status).toBe(502);
      // A second send is the bug.
      expect(srv.postedTo()).toEqual([topic.channelId]);
      // Pin the error_code that reaches the daemon: delivery-policy rule 6 keys on
      // details.error_code === 400 and would answer a retryable 502 with strip_entities.
      const body = (await res.json()) as { details?: { error_code?: number } };
      expect(body.details?.error_code).toBe(502);
    });

    it("an unparseable gateway page on a topic send -> returns 502 and does NOT fall back to General", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      srv.script("chat.postMessage", { status: 502, body: "<html><body>Bad Gateway</body></html>" });

      const res = await send(sessionId);

      expect(res.status).toBe(502);
      expect(srv.postedTo()).toEqual([topic.channelId]);
      const body = (await res.json()) as { details?: { error_code?: number } };
      expect(body.details?.error_code).toBe(502);
    });

    // The recreate path rewrites messageThreadId, so the relocation guard below it runs against a
    // DIFFERENT thread id than the one resolveTopic first returned. A 5xx on that retry must still
    // retry rather than relocate.
    it("5xx after a successful topic recreate -> returns 502 and does NOT fall back to General", async () => {
      const sessionId = await newSession();
      const old = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      srv.script("chat.postMessage", gone, badGateway);

      const res = await send(sessionId);

      expect(res.status).toBe(502);
      // The second send used the RECREATED conversation, and there was no third (General) send.
      expect(srv.postedTo()).toEqual([old.channelId, srv.created[0]!.id]);
    });

    // pigeon-bit4 / S2: every path that silently sends to General instead of the session's topic
    // must say so in the log.
    it("permanent relocation to General emits a console.warn naming the session and thread", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      const refused = { ok: false, error: "invalid_blocks" };
      srv.script("chat.postMessage", refused, refused);
      const spy = warnSpy();
      try {
        const res = await send(sessionId);
        expect(res.status).toBe(200);
        const relocateWarn = spy.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("relocating notification to General"),
        );
        expect(relocateWarn).toBeDefined();
        expect(relocateWarn![1]).toMatchObject({ sessionId, messageThreadId: topic.handle, reason: "send_failed" });
      } finally {
        spy.mockRestore();
      }
    });

    it("recreate-failed relocation to General emits a console.warn", async () => {
      const sessionId = await newSession();
      await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      srv.script("chat.postMessage", gone);
      srv.script("conversations.create", { ok: false, error: "restricted_action" });
      const spy = warnSpy();
      try {
        const res = await send(sessionId);
        expect(res.status).toBe(200);
        const warns = spy.mock.calls.filter((c) => typeof c[0] === "string");
        expect(warns.some((c) => (c[0] as string).includes("topic creation failed"))).toBe(true);
        expect(
          warns.some(
            (c) =>
              (c[0] as string).includes("relocating notification to General") &&
              (c[1] as Record<string, unknown>)?.reason === "recreate_failed",
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("media attachment failure emits a console.warn instead of being silently skipped", async () => {
      const sessionId = await newSession();
      await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      const mediaKey = `outbound/${Date.now()}-bit4/photo.png`;
      await env.MEDIA.put(mediaKey, new Uint8Array([1, 2, 3]));
      srv.script("files.getUploadURLExternal", { ok: false, error: "invalid_arguments" });
      const spy = warnSpy();
      try {
        const res = await send(sessionId, { media: [{ key: mediaKey, mime: "image/png", filename: "photo.png" }] });
        expect(res.status).toBe(200);
        expect(
          spy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("media attachment not delivered")),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    // pigeon-bit4 / S3: one column cannot express this. message_thread_id IS NULL is already
    // five-way ambiguous, so placement is recorded as the pair (intended, actual).
    it("records intended and actual thread ids as equal on a normal threaded send", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);

      const res = await send(sessionId);
      expect(res.status).toBe(200);
      const { messageId } = (await res.json()) as { messageId: number };

      const row = await env.DB.prepare(
        "SELECT intended_thread_id, actual_thread_id FROM messages WHERE chat_id = ? AND message_id = ?",
      )
        .bind(chat(), messageId)
        .first<{ intended_thread_id: number | null; actual_thread_id: number | null }>();
      expect(row).toMatchObject({ intended_thread_id: topic.handle, actual_thread_id: topic.handle });
    });

    it("records intended set and actual null when a notification is relocated to General", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      const refused = { ok: false, error: "invalid_blocks" };
      srv.script("chat.postMessage", refused, refused);
      const spy = warnSpy();
      try {
        const res = await send(sessionId);
        expect(res.status).toBe(200);
        const { messageId } = (await res.json()) as { messageId: number };
        const row = await env.DB.prepare(
          "SELECT intended_thread_id, actual_thread_id FROM messages WHERE chat_id = ? AND message_id = ?",
        )
          .bind(chat(), messageId)
          .first<{ intended_thread_id: number | null; actual_thread_id: number | null }>();
        // This pair -- intended non-null, actual null -- IS the definition of a relocation.
        expect(row).toMatchObject({ intended_thread_id: topic.handle, actual_thread_id: null });
      } finally {
        spy.mockRestore();
      }
    });

    // The columns are added to prod by a manual ALTER. If the code ships first, or the ALTER is
    // rolled back, the write MUST degrade to a warn: an INSERT that referenced a missing column
    // would throw AFTER the provider accepted the message -> 503 -> the daemon retries a message
    // that was in fact delivered.
    it("still inserts the message row, and warns, when the placement columns do not exist", async () => {
      const sessionId = await newSession();
      // Must be a THREADED send: with no thread on either side there is no placement to record.
      await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        spy = warnSpy();
        await env.DB.prepare("ALTER TABLE messages DROP COLUMN intended_thread_id").run();

        const res = await send(sessionId);

        // The notification is delivered and acknowledged; only the bookkeeping is lost.
        expect(res.status).toBe(200);
        const { messageId } = (await res.json()) as { messageId: number };
        const row = await env.DB.prepare("SELECT session_id FROM messages WHERE chat_id = ? AND message_id = ?")
          .bind(chat(), messageId)
          .first<{ session_id: string }>();
        expect(row?.session_id).toBe(sessionId);
        expect(
          spy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("thread placement not recorded")),
        ).toBe(true);
      } finally {
        // Restore before anything else: the DB is shared across the whole file.
        await env.DB.prepare("ALTER TABLE messages ADD COLUMN intended_thread_id INTEGER").run().catch(() => {});
        spy?.mockRestore();
      }
    });

    it("429 topic send failure -> returns 429 with retryAfter and does NOT fall back to General", async () => {
      const sessionId = await newSession();
      const topic = await seedSlackTopic(sessionId, dm.machineId, dm.ws);
      srv.script("chat.postMessage", { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "12" } });

      const res = await send(sessionId);

      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfter: 12 });
      expect(srv.postedTo()).toEqual([topic.channelId]); // exactly 1 call, no General fallback
    });

    it("a permanent (4xx) create failure -> falls back to General and succeeds", async () => {
      const sessionId = await newSession();
      const alerts = await seedAlerts(dm.ws);
      srv.script("conversations.create", { ok: false, error: "invalid_blocks" });

      const res = await send(sessionId);

      expect(res.status).toBe(200);
      expect(srv.of("conversations.create")).toHaveLength(1);
      expect(srv.postedTo()[0]).toBe(alerts); // Sent to General
    });

    // ── pigeon-533h: a topics row lives in ONE chat ──
    // On 2026-10-20 a push for a cloudbox session carrying the Mac's chat was handed the cloudbox
    // thread id by the chat-agnostic lookup, the provider said "not found", and the stale-thread
    // recovery deleted the cloudbox row and minted a topic in the Mac chat.

    describe("cross-chat notifications never touch another chat's topic (pigeon-533h)", () => {
      let owner: SlackMachine;
      let other: SlackMachine;
      let both: Env;

      beforeEach(async () => {
        owner = await mkSlackMachine();
        other = await mkSlackMachine();
        both = envWith([owner, other]);
      });

      const pushFrom = (m: SlackMachine, sessionId: string, notificationId: string) =>
        send(sessionId, { notificationId, text: `notice ${notificationId}`, title: "SCCM node development scoping", dir: "/home/dev/projects/mono" }, m.key, both);

      it("reproduces the incident: a push from the other workspace and one from the owner leave the owner's row intact", async () => {
        const sessionId = await seedSession(owner.machineId, "mono");
        const topic = await seedSlackTopic(sessionId, owner.machineId, owner.ws, "SCCM · ~/projects/mono");
        const otherAlerts = await seedAlerts(other.ws);

        // 1. The other machine's push. It must not be threaded into a conversation that belongs to
        //    another chat, and must neither delete the row nor create a conversation.
        const res1 = await pushFrom(other, sessionId, `w:other_${sessionId}`);
        expect(res1.status).toBe(200);
        expect(srv.created).toEqual([]);
        // It lands unthreaded in its own workspace, and the anomaly is reported like any relocation.
        expect(srv.postedTo()).toEqual([otherAlerts, otherAlerts]);

        let row = await getBySession(env.DB, sessionId);
        expect(row?.chat_id).toBe(slackChatId(owner.ws));
        expect(row?.message_thread_id).toBe(topic.handle);

        // 2. The owner's next push still lands in the original topic, with no new conversation.
        const res2 = await pushFrom(owner, sessionId, `s:own_${sessionId}`);
        expect(res2.status).toBe(200);
        expect(srv.created).toEqual([]);
        expect(srv.postedTo().slice(2)).toEqual([topic.channelId]);

        row = await getBySession(env.DB, sessionId);
        expect(row?.chat_id).toBe(slackChatId(owner.ws));
        expect(row?.message_thread_id).toBe(topic.handle);
      });

      it("a closed topic in another chat is neither reopened nor deleted by a cross-chat push", async () => {
        const sessionId = await seedSession(owner.machineId, "mono");
        await seedSlackTopic(sessionId, owner.machineId, owner.ws, "closed");
        await markClosed(env.DB, { sessionId, now: Date.now() });
        await seedAlerts(other.ws);

        const res = await pushFrom(other, sessionId, `w:other_closed_${sessionId}`);
        expect(res.status).toBe(200);
        expect(srv.of("conversations.unarchive")).toEqual([]);
        expect(srv.created).toEqual([]);

        const row = await getBySession(env.DB, sessionId);
        expect(row?.chat_id).toBe(slackChatId(owner.ws));
        expect(row?.state).toBe("closed");
      });

      it("a named-topic binding in another chat is not used for a cross-chat push", async () => {
        const sessionId = await seedSession(owner.machineId, "mono");
        const key = `test:cross-chat-${stamp()}`;
        const channelId = `CD${stamp()}`.toUpperCase();
        const handle = await seedChannel(owner.ws.teamId, channelId);
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Digest', ?, ?)",
        ).bind(slackChatId(owner.ws), key, handle, now, now).run();
        await env.DB.prepare(
          "INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)",
        ).bind(slackChatId(owner.ws), key, sessionId, now).run();
        const otherAlerts = await seedAlerts(other.ws);

        const res = await pushFrom(other, sessionId, `w:other_bound_${sessionId}`);
        expect(res.status).toBe(200);
        expect(srv.postedTo()).not.toContain(channelId);
        expect(srv.postedTo()[0]).toBe(otherAlerts);
        expect(srv.created).toEqual([]);
        const topicRow = await env.DB.prepare("SELECT * FROM topics WHERE session_id = ?").bind(sessionId).first();
        expect(topicRow).toBeNull();
      });

      it("deleteTopicBySession is scoped to the chat: the same thread id in another chat is not deleted", async () => {
        const sessionId = `ses_cross_chat_delete_${stamp()}`;
        const now = Date.now();
        await reserve(env.DB, { sessionId, machineId: owner.machineId, chatId: slackChatId(owner.ws), name: "x", now });
        await finalize(env.DB, { sessionId, messageThreadId: SLACK_HANDLE_MIN + 650, now });

        expect(await deleteTopicBySession(env.DB, sessionId, slackChatId(other.ws), SLACK_HANDLE_MIN + 650)).toBe(false);
        expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(SLACK_HANDLE_MIN + 650);
        expect(await deleteTopicBySession(env.DB, sessionId, slackChatId(owner.ws), SLACK_HANDLE_MIN + 650)).toBe(true);
        expect(await getBySession(env.DB, sessionId)).toBeNull();
      });
    });

    // ── pigeon-iqpd: hold transiently-unresolvable topics for retry ──

    describe("pigeon-iqpd: hold transiently-unresolvable topics for retry (onTopicUnavailable)", () => {
      it("first notification, the create fails (5xx), onTopicUnavailable:'retry' -> 502 topic_unavailable, no send, no alert, no messages row, no retryAfter/details", async () => {
        const sessionId = await newSession();
        srv.script("conversations.create", badGateway);

        const res = await send(sessionId, { onTopicUnavailable: "retry" });

        expect(res.status).toBe(502);
        expect(res.headers.get("Retry-After")).toBeNull();
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.error).toBe("topic_unavailable");
        expect(json.reason).toBe("create_failed");
        expect(json).not.toHaveProperty("retryAfter");
        expect(json).not.toHaveProperty("details");
        expect(json.createError).toMatchObject({ ok: false, error_code: 502 });
        expect(json.errorClass).toBe("upstream");

        expect(srv.postedTo()).toEqual([]);
        expect(await messagesFor(sessionId)).toBeNull();
      });

      it("the create fails (5xx), onTopicUnavailable absent -> relocates to General (200)", async () => {
        const sessionId = await newSession();
        const alerts = await seedAlerts(dm.ws);
        srv.script("conversations.create", badGateway);

        const res = await send(sessionId);

        expect(res.status).toBe(200);
        expect(srv.postedTo()[0]).toBe(alerts); // Posted to General
      });

      it("the create fails (5xx), onTopicUnavailable 'general' -> relocates to General (200)", async () => {
        const sessionId = await newSession();
        const alerts = await seedAlerts(dm.ws);
        srv.script("conversations.create", badGateway);

        const res = await send(sessionId, { onTopicUnavailable: "general" });

        expect(res.status).toBe(200);
        expect(srv.postedTo()[0]).toBe(alerts);
      });

      it("4xx create failure with onTopicUnavailable:'retry' -> relocates as today", async () => {
        const sessionId = await newSession();
        const alerts = await seedAlerts(dm.ws);
        srv.script("conversations.create", { ok: false, error: "invalid_blocks" });

        const res = await send(sessionId, { onTopicUnavailable: "retry" });

        expect(res.status).toBe(200);
        expect(srv.postedTo()[0]).toBe(alerts); // Relocated to General
      });

      it("topic_in_other_chat with onTopicUnavailable:'retry' -> relocates as today", async () => {
        const sessionId = await newSession();
        const alerts = await seedAlerts(dm.ws);
        const now = Date.now();
        await reserve(env.DB, {
          sessionId,
          machineId: dm.machineId,
          chatId: "slack:TDIFFERENTCHAT", // Different chat
          name: "pigeon · other chat",
          now,
        });
        await finalize(env.DB, { sessionId, messageThreadId: SLACK_HANDLE_MIN + 444, now });

        const res = await send(sessionId, { onTopicUnavailable: "retry" });

        expect(res.status).toBe(200);
        expect(srv.postedTo()[0]).toBe(alerts); // Relocated to General
      });

      it("T2.7 recreate path: the create fails (5xx) with onTopicUnavailable:'retry' -> 502 topic_unavailable, only one failed send made", async () => {
        const sessionId = await newSession();
        await seedSlackTopic(sessionId, dm.machineId, dm.ws, "pigeon · recreate5xx");
        srv.script("chat.postMessage", gone);
        srv.script("conversations.create", badGateway);

        const res = await send(sessionId, { onTopicUnavailable: "retry" });

        expect(res.status).toBe(502);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.error).toBe("topic_unavailable");
        expect(json.reason).toBe("recreate_failed:create_failed");
        expect(json.createError).toMatchObject({ ok: false, error_code: 502 });
        expect(json).not.toHaveProperty("retryAfter");
        expect(json).not.toHaveProperty("details");

        // Crucial: only the one failed send was made
        expect(srv.of("chat.postMessage")).toHaveLength(1);
        expect(await messagesFor(sessionId)).toBeNull();
      });

      it("after a held 502, a subsequent request whose create succeeds posts into the new topic", async () => {
        const sessionId = await newSession();
        srv.script("conversations.create", badGateway);

        const res1 = await send(sessionId, { onTopicUnavailable: "retry", text: "Attempt 1: held" });
        expect(res1.status).toBe(502);

        // The reservation row was cleaned up so the next attempt can reserve and create
        expect(await getBySession(env.DB, sessionId)).toBeNull();

        const res2 = await send(sessionId, { onTopicUnavailable: "retry", text: "Attempt 2: succeeds" });
        expect(res2.status).toBe(200);
        expect(srv.created).toHaveLength(1);
        expect(srv.postedTo()).toEqual([srv.created[0]!.id]); // Posted into the newly created topic!
      });

      it("poll_exhausted with onTopicUnavailable:'retry' -> 502 topic_unavailable", async () => {
        const sessionId = await newSession();
        // Reserve the session row so this caller is not the winner
        await reserve(env.DB, {
          sessionId,
          machineId: "another-machine",
          chatId: chat(),
          name: "pigeon · exhausted",
          now: Date.now(),
        });

        const res = await send(sessionId, { onTopicUnavailable: "retry" });

        expect(res.status).toBe(502);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json.error).toBe("topic_unavailable");
        expect(json.reason).toBe("poll_exhausted");
        expect(json).not.toHaveProperty("retryAfter");
        expect(json).not.toHaveProperty("details");
      });
    });

    // ── T2.9: media follows the thread ──

    describe("Task T2.9: Media passes the conversation", () => {
      async function stage(key: string, mime: string, filename: string, content: string) {
        const form = new FormData();
        form.append("key", key);
        form.append("mime", mime);
        form.append("filename", filename);
        form.append("file", new Blob([content], { type: mime }), filename);
        await SELF.fetch("https://worker/media/upload", {
          method: "POST",
          body: form,
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
      }

      it("topic resolved -> a photo and a document are both posted into the session's conversation", async () => {
        const sessionId = await newSession();
        const imageKey = `media_test/img_${stamp()}.png`;
        const docKey = `media_test/doc_${stamp()}.pdf`;
        await stage(imageKey, "image/png", "screenshot.png", "png_data");
        await stage(docKey, "application/pdf", "report.pdf", "pdf_data");

        const res = await send(sessionId, {
          title: "Media Topic",
          media: [
            { key: imageKey, mime: "image/png", filename: "screenshot.png" },
            { key: docKey, mime: "application/pdf", filename: "report.pdf" },
          ],
        });

        expect(res.status).toBe(200);
        const channel = srv.created[0]!.id;
        expect(srv.of("files.completeUploadExternal").map((c) => c.params.get("channel_id"))).toEqual([channel, channel]);
      });

      it("media follows the recreated conversation after T2.7 stale-thread recovery", async () => {
        // Regression: messageThreadId was assigned once and never updated by the T2.7 retry, so the
        // media loop kept sending to the DELETED thread and the attachments were dropped with no log.
        const sessionId = await newSession();
        const imageKey = `media_test/img_recov_${stamp()}.png`;
        await stage(imageKey, "image/png", "shot.png", "png_data");
        const old = await seedSlackTopic(sessionId, dm.machineId, dm.ws, "pigeon · Recovered");
        srv.gone.add(old.channelId);

        const res = await send(sessionId, {
          title: "Recovered",
          media: [{ key: imageKey, mime: "image/png", filename: "shot.png" }],
        });

        expect(res.status).toBe(200);
        // Text recovered onto the new conversation...
        expect(srv.postedTo()).toEqual([old.channelId, srv.created[0]!.id]);
        // ...and the photo follows the text, not the deleted one.
        expect(srv.of("files.completeUploadExternal").map((c) => c.params.get("channel_id"))).toEqual([srv.created[0]!.id]);
      });
    });
  });

  describe("Task T2.10: Unregister topic closing", () => {
    let um: SlackMachine;
    let uEnv: Env;
    let srv: ReturnType<typeof fakeSlack>;

    beforeEach(async () => {
      resetSlackCalls();
      fetchMock.activate();
      fetchMock.disableNetConnect();
      um = await mkSlackMachine();
      uEnv = envWith([um]);
      srv = fakeSlack();
    });

    afterEach(() => {
      fetchMock.get("https://slack.com").cleanMocks();
      fetchMock.deactivate();
    });

    const unregister = (sessionId: string, immediate: boolean) =>
      handleSessionRequest(
        env.DB,
        uEnv,
        new Request("https://worker/sessions/unregister", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(immediate ? { sessionId, immediate: true } : { sessionId }),
        }),
        "unregister",
      );

    it("(a) finalized topic row -> row state='closed', closed_at set, the conversation archived, topic row still exists", async () => {
      const sessionId = await seedSession(um.machineId);
      const topic = await seedSlackTopic(sessionId, um.machineId, um.ws, "pigeon · unreg a");

      const res = await unregister(sessionId, true);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(srv.of("conversations.archive").map((c) => c.params.get("channel"))).toEqual([topic.channelId]);

      const row = await getBySession(env.DB, sessionId);
      expect(row).not.toBeNull();
      expect(row?.state).toBe("closed");
      expect(typeof row?.closed_at).toBe("number");
      expect(row?.closed_at).toBeGreaterThan(0);
    });

    it("(b) the provider's close fails -> returns 200 {ok:true} and row is STILL marked closed", async () => {
      const sessionId = await seedSession(um.machineId);
      await seedSlackTopic(sessionId, um.machineId, um.ws, "pigeon · unreg b");
      srv.script("conversations.archive", { ok: false, error: "channel_not_found" });

      const res = await unregister(sessionId, true);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(typeof row?.closed_at).toBe("number");
    });

    it("(c) reservation row with NULL message_thread_id -> row marked closed, zero provider calls", async () => {
      const sessionId = await seedSession(um.machineId);
      await reserve(env.DB, { sessionId, machineId: um.machineId, chatId: slackChatId(um.ws), name: "pigeon · unreg c", now: Date.now() });

      const res = await unregister(sessionId, true);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(slackCalls).toEqual([]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(row?.message_thread_id).toBeNull();
    });

    it("(e) session with no topic row -> 200, no provider call, no crash", async () => {
      const sessionId = await seedSession(um.machineId);

      const res = await unregister(sessionId, false);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(slackCalls).toEqual([]);
      expect(await getBySession(env.DB, sessionId)).toBeNull();
    });

    it("(f) no `immediate` -> topic is LEFT OPEN for the daily close window, zero provider calls", async () => {
      // pigeon-xehy. This is the janitorial path: the daemon's hourly session reaper, dead-session
      // cleanup and the outbox's compensating unregister all land here. Leaving the row
      // state='open' with its `sessions` row deleted is precisely what `listOrphaned` selects, so
      // the windowed orphan-closer collects it instead of a service message appearing off-window.
      const sessionId = await seedSession(um.machineId);
      await seedSlackTopic(sessionId, um.machineId, um.ws, "pigeon · unreg f");

      const res = await unregister(sessionId, false);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(slackCalls).toEqual([]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("open");
      expect(row?.closed_at).toBeNull();

      // and the session row itself is still gone, which is what makes it an orphan
      const sess = await env.DB.prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first();
      expect(sess).toBeNull();
    });

    it("(g) immediate, topic ALREADY closed -> closed_at is not rewritten and no provider call", async () => {
      // `markClosed` is unconditional, so without the state guard a second unregister would reset
      // closed_at and restart the reaper's 30-day delete clock, keeping a dead topic alive.
      const sessionId = await seedSession(um.machineId);
      await seedSlackTopic(sessionId, um.machineId, um.ws, "pigeon · unreg g");
      await markClosed(env.DB, { sessionId, now: Date.now() - 29 * 24 * 60 * 60 * 1000 });
      const before = await getBySession(env.DB, sessionId);

      const res = await unregister(sessionId, true);
      expect(res.status).toBe(200);

      expect(slackCalls).toEqual([]);
      const after = await getBySession(env.DB, sessionId);
      expect(after?.closed_at).toBe(before?.closed_at);
    });
  });

  describe("Task T2.11: Topic reaper cron jobs", () => {
    // Rows live in a Slack workspace; the orphan-closer's provider is a scripted fake transport.
    // reapTopics takes neither a transport nor an env, so "no provider call" on a reap is a
    // property of its signature rather than something a fake can observe.
    const topicChatId = "slack:TREAPER";

    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM topics").run();
      await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_t211_%'").run();
    });

    it("(a) reap deletes a closed topic older than 30d: D1 row gone (Slack has nothing to delete, so no provider call)", async () => {
      const sessionId = "ses_t211_reap_old";
      const threadId = 62001;
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000); // older than 30d

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · reap old", now: closedAt - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS });

      expect(result.reaped).toBe(1);

      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("(b) reap does NOT touch a closed topic younger than 30d", async () => {
      const sessionId = "ses_t211_reap_recent";
      const threadId = 62002;
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS - 60_000); // 1 minute younger than 30d

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · reap recent", now: closedAt - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS });

      expect(result.reaped).toBe(0);

      const row = await getBySession(env.DB, sessionId);
      expect(row).not.toBeNull();
      expect(row?.state).toBe("closed");
    });

    it("(d) reap cap: with 8 eligible rows, at most 5 are processed in one run", async () => {
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000);

      for (let i = 0; i < 8; i++) {
        const sessionId = `ses_t211_reap_cap_${i}`;
        const threadId = 62010 + i;
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: `pigeon · cap ${i}`, now: closedAt - 1000 });
        await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
        await markClosed(env.DB, { sessionId, now: closedAt });
      }

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS, limit: 5 });

      expect(result.reaped).toBe(5);
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics WHERE session_id LIKE 'ses_t211_reap_cap_%'").first<{ n: number }>();
      expect(left?.n).toBe(3);
    });

    it("NULL message_thread_id reap row -> D1 row deleted, zero provider calls", async () => {
      const sessionId = "ses_t211_null_thread_reap";
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000);

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · null thread reap", now: closedAt - 1000 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS });

      expect(result.reaped).toBe(1);

      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("(e) orphan-close closes an open topic whose sessions row is absent", async () => {
      const sessionId = "ses_t211_orphan_no_session";
      const threadId = 62020;
      const now = Date.now();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · orphan no sess", now: now - 8 * 86400 * 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: now - 8 * 86400 * 1000 });

      const { client, calls } = fakeTransport();
      const result = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });

      expect(result.closedOrphans).toBe(1);
      expect(result.rateLimited).toBe(false);
      expect(calls.archiveConversation).toEqual([{ chatId: topicChatId, messageThreadId: threadId }]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(typeof row?.closed_at).toBe("number");
    });

    it("(f) orphan-close closes an open topic whose sessions.updated_at is older than 7d TTL", async () => {
      const sessionId = "ses_t211_orphan_stale_session";
      const threadId = 62021;
      const now = Date.now();
      const oldTime = now - (ORPHAN_TTL_MS + 1000);

      await registerSession(sessionId, "devbox", "stale session");
      await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(oldTime, sessionId).run();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · orphan stale sess", now: oldTime });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: oldTime });

      const { client, calls } = fakeTransport();
      const result = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });

      expect(result.closedOrphans).toBe(1);
      expect(result.rateLimited).toBe(false);
      expect(calls.archiveConversation).toEqual([{ chatId: topicChatId, messageThreadId: threadId }]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
    });

    it("(g) orphan-close does NOT touch an open topic with a fresh sessions row", async () => {
      const sessionId = "ses_t211_fresh_session";
      const threadId = 62022;
      const now = Date.now();

      await registerSession(sessionId, "devbox", "fresh session");
      await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(now - 1000, sessionId).run();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · fresh sess", now: now - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: now - 1000 });

      const { client, calls } = fakeTransport();
      const result = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });

      expect(result.closedOrphans).toBe(0);
      expect(result.rateLimited).toBe(false);
      expect(Object.values(calls).flat()).toEqual([]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("open");
    });

    it("(h) orphan cap: with 8 eligible, at most 5 processed", async () => {
      const now = Date.now();

      for (let i = 0; i < 8; i++) {
        const sessionId = `ses_t211_orphan_cap_${i}`;
        const threadId = 62030 + i;
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: `pigeon · orphan cap ${i}`, now: now - 8 * 86400 * 1000 });
        await finalize(env.DB, { sessionId, messageThreadId: threadId, now: now - 8 * 86400 * 1000 });
      }

      const { client, calls } = fakeTransport();
      const result = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, limit: 5, transport: client });

      expect(result.closedOrphans).toBe(5);
      expect(calls.archiveConversation).toHaveLength(5);
    });

    it("(i) NULL message_thread_id orphan row -> D1 row closed, zero provider calls", async () => {
      const sessionId = "ses_t211_null_thread_orphan";
      const now = Date.now();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · null thread orphan", now: now - 8 * 86400 * 1000 });

      const { client, calls } = fakeTransport();
      const result = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });

      expect(result.closedOrphans).toBe(1);
      expect(Object.values(calls).flat()).toEqual([]);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(row?.message_thread_id).toBeNull();
    });

    it("(j) a rate_limited close stops the run early: the remaining orphans stay open and rateLimited is reported", async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const sessionId = `ses_t211_rate_orphan_${i}`;
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: `pigeon · rate orphan ${i}`, now: now - 8 * 86400 * 1000 });
        await finalize(env.DB, { sessionId, messageThreadId: 62045 + i, now: now - 8 * 86400 * 1000 });
      }

      const { client, calls } = fakeTransport({ archiveConversation: () => results.rateLimited(10) });
      const result = await runTopicReaper(env.DB, { now, transport: client });

      expect(result.rateLimited).toBe(true);
      expect(result.reaped).toBe(0);
      expect(result.closedOrphans).toBe(0);
      expect(calls.archiveConversation).toHaveLength(1);
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics WHERE session_id LIKE 'ses_t211_rate_orphan_%' AND state = 'open'").first<{ n: number }>();
      expect(open?.n).toBe(3);
    });
  });

  describe("F1 Defect Fixes: sticky-closed topics and reaper liveness check", () => {
    // Rows live in a Slack workspace; the provider is a scripted fake transport.
    const topicChatId = "slack:TF1DEFECTS";

    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM topics").run();
      await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_f1_%'").run();
    });

    it("(a) reopen returns topic_not_modified (already open at the provider) -> flips D1 row state to open", async () => {
      const sessionId = "ses_f1_a_not_modified";
      const threadId = 65001;
      const now = Date.now();

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · not modified", now });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now });
      await markClosed(env.DB, { sessionId, now });

      const { client } = fakeTransport({ unarchiveConversation: () => results.notModified() });

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "not modified",
        now: now + 1000,
        transport: client,
      });

      expect(res).toEqual({ ok: true, messageThreadId: threadId });

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("open");
      expect(row?.closed_at).toBeNull();
    });

    it("(b) 429 and thread_not_found reopen branches are unchanged", async () => {
      const sessionId429 = "ses_f1_b_429";
      const threadId429 = 65002;
      const now = Date.now();

      await reserve(env.DB, { sessionId: sessionId429, machineId: "devbox", chatId: topicChatId, name: "pigeon · 429", now });
      await finalize(env.DB, { sessionId: sessionId429, messageThreadId: threadId429, now });
      await markClosed(env.DB, { sessionId: sessionId429, now });

      const limited = fakeTransport({ unarchiveConversation: () => results.rateLimited(15) });

      const res429 = await resolveTopic(env.DB, {
        sessionId: sessionId429,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "429",
        now: now + 1000,
        transport: limited.client,
      });

      expect(res429).toEqual({ ok: false, kind: "rate_limited", retryAfter: 15 });
      const row429 = await getBySession(env.DB, sessionId429);
      expect(row429?.state).toBe("closed");

      // Test thread_not_found branch
      const sessionIdTnf = "ses_f1_b_tnf";
      const threadIdTnf = 65003;
      const newThreadId = 65004;

      await reserve(env.DB, { sessionId: sessionIdTnf, machineId: "devbox", chatId: topicChatId, name: "pigeon · tnf", now });
      await finalize(env.DB, { sessionId: sessionIdTnf, messageThreadId: threadIdTnf, now });
      await markClosed(env.DB, { sessionId: sessionIdTnf, now });

      const gone = fakeTransport({
        unarchiveConversation: () => results.threadNotFound(),
        createConversation: () => ({ ok: true, result: { messageThreadId: newThreadId, name: "pigeon · tnf" } }),
      });

      const resTnf = await resolveTopic(env.DB, {
        sessionId: sessionIdTnf,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "tnf",
        now: now + 1000,
        transport: gone.client,
      });

      expect(resTnf).toEqual({ ok: true, messageThreadId: newThreadId });
      const rowTnf = await getBySession(env.DB, sessionIdTnf);
      expect(rowTnf?.message_thread_id).toBe(newThreadId);
      expect(rowTnf?.state).toBe("open");
    });

    it("(c) listReapable/reapTopics does not return or delete a 30-day-closed topic whose sessions row exists and is fresh", async () => {
      const sessionId = "ses_f1_c_fresh";
      const threadId = 65005;
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000); // older than 30 days

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · fresh sess", now: closedAt - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      // Insert fresh session row (updated within last 7 days)
      await env.DB.prepare(
        "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(sessionId, "devbox", "pigeon", now - 1000, now - 1000).run();

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });

      expect(result.reaped).toBe(0);
      const row = await getBySession(env.DB, sessionId);
      expect(row).not.toBeNull();
      expect(row?.state).toBe("closed");
    });

    it("(d) listReapable/reapTopics does reap a 30-day-closed topic whose sessions row is absent", async () => {
      const sessionId = "ses_f1_d_no_session";
      const threadId = 65006;
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000);

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · no sess", now: closedAt - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      // No sessions row created

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });

      expect(result.reaped).toBe(1);
      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("(e) listReapable/reapTopics does reap a 30-day-closed topic whose sessions row exists but is stale (older than 7d TTL)", async () => {
      const sessionId = "ses_f1_e_stale_session";
      const threadId = 65007;
      const now = Date.now();
      const closedAt = now - (REAP_TTL_MS + 1000);
      const staleSessionTime = now - (ORPHAN_TTL_MS + 1000); // 8 days ago (> 7d TTL)

      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · stale sess", now: closedAt - 1000 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: closedAt - 500 });
      await markClosed(env.DB, { sessionId, now: closedAt });

      await env.DB.prepare(
        "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(sessionId, "devbox", "pigeon", staleSessionTime, staleSessionTime).run();

      const result = await reapTopics(env.DB, { now, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });

      expect(result.reaped).toBe(1);
      const row = await getBySession(env.DB, sessionId);
      expect(row).toBeNull();
    });

    it("(f) end-to-end composition: close topic, generic error on reopen -> state stays closed, notification gets thread id, reaper 30d later does NOT delete it while session row is fresh", async () => {
      const sessionId = "ses_f1_f_generic_e2e";
      const threadId = 65008;
      const t0 = Date.now();

      // 1. Seed closed topic with active session
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · generic e2e", now: t0 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: t0 });
      await markClosed(env.DB, { sessionId, now: t0 });

      await env.DB.prepare(
        "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(sessionId, "devbox", "pigeon", t0, t0).run();

      // 2. Notification arrives -> resolveTopic reopen fails generically (e.g. lost rights)
      const { client } = fakeTransport({
        unarchiveConversation: () => results.error(400, "Bad Request: not enough rights to manage topics"),
      });

      const resolveRes = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "generic e2e",
        now: t0 + 1000,
        transport: client,
      });

      expect(resolveRes).toEqual({ ok: true, messageThreadId: threadId });

      // Confirm row state STAYS closed (reopen fails generically, retry on next notification)
      const rowAfterResolve = await getBySession(env.DB, sessionId);
      expect(rowAfterResolve?.state).toBe("closed");

      // 3. 30 days later, run reaper
      const t30d = t0 + REAP_TTL_MS + 10000;
      // Session receives notifications and stays fresh
      await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(t30d - 1000, sessionId).run();

      const reapRes = await reapTopics(env.DB, { now: t30d, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });

      expect(reapRes.reaped).toBe(0);

      const rowAfterReap = await getBySession(env.DB, sessionId);
      expect(rowAfterReap).not.toBeNull();
      expect(rowAfterReap?.state).toBe("closed");
    });

    it("(g) end-to-end composition: close topic, topic_not_modified on reopen -> state becomes open, then reaper 30d later does NOT delete it", async () => {
      const sessionId = "ses_f1_g_not_mod_e2e";
      const threadId = 65009;
      const t0 = Date.now();

      // 1. Seed closed topic with active session
      await reserve(env.DB, { sessionId, machineId: "devbox", chatId: topicChatId, name: "pigeon · not mod e2e", now: t0 });
      await finalize(env.DB, { sessionId, messageThreadId: threadId, now: t0 });
      await markClosed(env.DB, { sessionId, now: t0 });

      await env.DB.prepare(
        "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(sessionId, "devbox", "pigeon", t0, t0).run();

      // 2. Notification arrives -> resolveTopic reopen returns topic_not_modified
      const { client } = fakeTransport({ unarchiveConversation: () => results.notModified() });

      const resolveRes = await resolveTopic(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        dir: "pigeon",
        title: "not mod e2e",
        now: t0 + 1000,
        transport: client,
      });

      expect(resolveRes).toEqual({ ok: true, messageThreadId: threadId });

      // Confirm row state flips to OPEN
      const rowAfterResolve = await getBySession(env.DB, sessionId);
      expect(rowAfterResolve?.state).toBe("open");

      // 3. 30 days later, run reaper
      const t30d = t0 + REAP_TTL_MS + 10000;
      // Session receives notifications and stays fresh
      await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(t30d - 1000, sessionId).run();

      const reapRes = await reapTopics(env.DB, { now: t30d, reapTtlMs: REAP_TTL_MS, orphanTtlMs: ORPHAN_TTL_MS });

      expect(reapRes.reaped).toBe(0);

      const rowAfterReap = await getBySession(env.DB, sessionId);
      expect(rowAfterReap).not.toBeNull();
      expect(rowAfterReap?.state).toBe("open");
    });

    // ── Follow-ups from the second fable review of 601c8d4 ──────────────────

    it("(F-1) orphan-closer marks the row closed even when the provider's close fails generically, so it cannot pin a slot forever", async () => {
      const sessionId = "ses_f1b_generic";
      const threadId = 66001;
      const t0 = Date.now();
      await env.DB.prepare(
        `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
         VALUES (?, 'devbox', ?, ?, 'x', 'open', ?, ?)`,
      ).bind(sessionId, topicChatId, threadId, t0, t0).run();
      // No sessions row => orphaned.

      const { client, calls } = fakeTransport({
        archiveConversation: () => results.error(400, "Bad Request: not enough rights to manage topics"),
      });

      const now = t0 + 1000;
      const res1 = await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });
      expect(calls.archiveConversation).toHaveLength(1);
      expect(res1.closedOrphans).toBe(1);

      const row = await getBySession(env.DB, sessionId);
      expect(row?.state).toBe("closed");
      expect(row?.closed_at).not.toBeNull();

      // The point of the fix: a SECOND run must not re-select it, so it cannot pin one of the 5 slots.
      const res2 = await closeOrphanedTopics(env.DB, { now: now + 1000, orphanTtlMs: ORPHAN_TTL_MS, transport: client });
      expect(res2.closedOrphans).toBe(0);
      expect(calls.archiveConversation).toHaveLength(1);
    });

    it("(F-2) runTopicReaper forwards orphanTtlMs to reapTopics, so both jobs share one definition of live", async () => {
      const sessionId = "ses_f1b_ttl";
      const threadId = 66010;
      const t0 = Date.now();
      const closedLongAgo = t0 - REAP_TTL_MS - 10000;
      await env.DB.prepare(
        `INSERT INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at, closed_at)
         VALUES (?, 'devbox', ?, ?, 'x', 'closed', ?, ?, ?)`,
      ).bind(sessionId, topicChatId, threadId, closedLongAgo, closedLongAgo, closedLongAgo).run();
      // sessions row is 3 days stale: LIVE under the 7d default, DEAD under a 1d override.
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, 'devbox', null, ?, ?)`,
      ).bind(sessionId, closedLongAgo, t0 - 3 * 24 * 60 * 60 * 1000).run();

      // With a 1-day liveness cutoff the session reads as dead, so the reaper MUST reap.
      // If orphanTtlMs is not forwarded, reapTopics falls back to 7d, sees a live session, and reaps nothing.
      const res = await runTopicReaper(env.DB, {
        now: t0,
        orphanTtlMs: 24 * 60 * 60 * 1000,
        transport: fakeTransport().client,
      });

      expect(res.reaped).toBe(1);
      expect(await getBySession(env.DB, sessionId)).toBeNull();
    });

  });

  // ─── pigeon-4890: daily topic-close window ─────────────────────────────────
  //
  // The orphan-closer closes a topic, which (on Telegram) posts a service message and marks the
  // topic UNREAD in the sidebar. Firing it on every hourly cron trickled those into the unread
  // feed all day. It is now gated to a single UTC tick so the day's closures land in one batch.

  describe("pigeon-4890: daily topic-close window", () => {
    let wm: SlackMachine;
    let wEnv: Env;
    let topicChatId = "";

    beforeEach(async () => {
      resetSlackCalls();
      fetchMock.activate();
      fetchMock.disableNetConnect();
      wm = await mkSlackMachine();
      wEnv = envWith([wm]);
      topicChatId = slackChatId(wm.ws);
    });

    afterEach(() => {
      fetchMock.get("https://slack.com").cleanMocks();
      fetchMock.deactivate();
    });

    /**
     * Today's date at a given UTC hour.
     *
     * Deliberately NOT a fixed calendar date. These tests pin `scheduledTime`,
     * but the reaper's own `now` is the real clock, so a hardcoded date drifts
     * away from it: rows these tests marked closed sat exactly 30 days behind
     * `Date.now()` on 2026-09-17, became reapable, and the reap half then
     * consumed the tick before the orphan-closer ran — failing (e) on that day
     * and no other. Anchoring to today keeps every seeded row the same
     * distance from real now on every day the suite runs.
     */
    function atUtcHour(hour: number): number {
      const today = new Date();
      return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, 0, 0);
    }

    /** An open, finalized topic whose session row is absent => an orphan, over a conversation Slack knows. */
    async function seedOrphan(sessionId: string, now: number) {
      const old = now - 8 * 86400 * 1000;
      const channelId = `CO${stamp()}`.toUpperCase();
      const handle = await seedChannel(wm.ws.teamId, channelId);
      await reserve(env.DB, {
        sessionId,
        machineId: "devbox",
        chatId: topicChatId,
        name: `pigeon · ${sessionId}`,
        now: old,
      });
      await finalize(env.DB, { sessionId, messageThreadId: handle, now: old });
      return channelId;
    }

    it("(a) the window opens at the configured hour and spans the configured number of hours", () => {
      const start = TOPIC_CLOSE_WINDOW_START_HOUR_UTC;

      expect(shouldCloseOrphans(atUtcHour(start))).toBe(true);
      expect(shouldCloseOrphans(atUtcHour(start + TOPIC_CLOSE_WINDOW_HOURS - 1))).toBe(true);

      expect(shouldCloseOrphans(atUtcHour(start - 1))).toBe(false);
      expect(shouldCloseOrphans(atUtcHour(start + TOPIC_CLOSE_WINDOW_HOURS))).toBe(false);
      expect(shouldCloseOrphans(atUtcHour(0))).toBe(false);
    });

    it("(a2) pigeon-ln8z: exactly ONE tick per day closes orphans, at 04:00 UTC (midnight ET)", () => {
      // A multi-hour window does not batch: new orphans (sessions crossing the 7-day TTL,
      // deferred unregisters from the daemon's hourly reaper) keep appearing, so every
      // "catch-up" tick found and closed a few more — observed 12/2/4/5 closes at 12–15 UTC.
      const open = Array.from({ length: 24 }, (_, h) => h).filter((h) =>
        shouldCloseOrphans(atUtcHour(h)),
      );
      expect(open).toEqual([4]);
    });

    it("(b) closeOrphans:false skips the orphan-closer entirely, leaving the row open", async () => {
      const now = atUtcHour(3);
      await seedOrphan("ses_4890_gated", now);

      const { client, calls } = fakeTransport();
      const res = await runTopicReaper(env.DB, { now, closeOrphans: false, transport: client });

      expect(res.closedOrphans).toBe(0);
      expect(calls.archiveConversation).toHaveLength(0);
      expect((await getBySession(env.DB, "ses_4890_gated"))?.state).toBe("open");
    });

    it("(c) a batch larger than the old per-hour cap of 5 drains in a single run", async () => {
      const now = atUtcHour(TOPIC_CLOSE_WINDOW_START_HOUR_UTC);
      const batch = 8;
      expect(DEFAULT_ORPHAN_CAP).toBeGreaterThanOrEqual(batch);

      for (let i = 0; i < batch; i++) {
        await seedOrphan(`ses_4890_batch_${i}`, now);
      }

      const { client } = fakeTransport();
      const res = await runTopicReaper(env.DB, { now, transport: client });

      // >= rather than ==: earlier cases in this describe leave their own orphans behind, and
      // the point of the assertion is that ONE run drains more than the old cap of 5.
      expect(res.closedOrphans).toBeGreaterThanOrEqual(batch);
      for (let i = 0; i < batch; i++) {
        expect((await getBySession(env.DB, `ses_4890_batch_${i}`))?.state).toBe("closed");
      }
    });

    it("(d) scheduled() outside the window leaves an orphan open (pins the cron wiring)", async () => {
      const now = atUtcHour(TOPIC_CLOSE_WINDOW_START_HOUR_UTC - 1);
      const sessionId = "ses_4890_cron_outside";
      await seedOrphan(sessionId, now);
      const srv = fakeSlack();

      const cronEnv = wEnv;
      await worker.scheduled(
        { scheduledTime: now, cron: "0 * * * *", noRetry: () => {} } as ScheduledController,
        cronEnv,
      );

      expect(srv.of("conversations.archive")).toHaveLength(0);
      expect((await getBySession(env.DB, sessionId))?.state).toBe("open");
    });

    it("(e) scheduled() inside the window closes the orphan", async () => {
      const now = atUtcHour(TOPIC_CLOSE_WINDOW_START_HOUR_UTC);
      const sessionId = "ses_4890_cron_inside";
      const channelId = await seedOrphan(sessionId, now);
      const srv = fakeSlack();

      const cronEnv = wEnv;
      await worker.scheduled(
        { scheduledTime: now, cron: "0 * * * *", noRetry: () => {} } as ScheduledController,
        cronEnv,
      );

      expect(srv.of("conversations.archive").map((c) => c.params.get("channel"))).toContain(channelId);
      expect((await getBySession(env.DB, sessionId))?.state).toBe("closed");
    });
  });

  // ─── Task T2.15: Webhook confirmations echo message_thread_id ───────────────

  // ─── Task T2.16: Bare slash commands resolve via topic ─────────────────

});

// ─── Dispatch Boundary Observability & Boundary Catch (5a-T2) ────────────────

describe("dispatch boundary outcome log and error catch (5a-T2)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it("emits structured outcome log on non-2xx response (status >= 400)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // POST /notifications/send with nonexistent session returns 404
    const res = await worker.fetch(
      new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ sessionId: "nonexistent", chatId: "8248645256", text: "hello" }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledWith(
      "[worker] request outcome",
      {
        path: "/notifications/send",
        method: "POST",
        status: 404,
      },
    );

    spy.mockRestore();
  });

  it("does NOT emit outcome log on successful 2xx/3xx response or /health", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // GET /health returns 200
    const healthRes = await worker.fetch(new Request("https://worker/health"), env);
    expect(healthRes.status).toBe(200);

    // GET /sessions returns 200
    const sessionsRes = await worker.fetch(
      new Request("https://worker/sessions", { headers: authHeaders }),
      env,
    );
    expect(sessionsRes.status).toBe(200);

    const outcomeCalls = spy.mock.calls.filter(
      (args) => args[0] === "[worker] request outcome",
    );
    expect(outcomeCalls).toHaveLength(0);

    spy.mockRestore();
  });

  it("catches unhandled throws, logs error, and returns structured 500 JSON", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Pass bad env with DB that throws
    const badDb = {
      prepare: () => {
        throw new Error("D1 database connection failed");
      },
    } as unknown as D1Database;

    const badEnv = { ...env, DB: badDb };

    const res = await worker.fetch(
      new Request("https://worker/sessions", { headers: authHeaders }),
      badEnv,
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });

    expect(spy).toHaveBeenCalledWith(
      "[worker] unhandled error",
      {
        path: "/sessions",
        method: "GET",
        error: "D1 database connection failed",
        stack: expect.any(String),
      },
    );

    spy.mockRestore();
    });
  });

  // ─── D1 Storage Error Classification (5a-T3 / pigeon-dul) ────────────────────

  describe("D1 storage error classification (5a-T3 / pigeon-dul)", () => {
    // Sends go through a machine on a Slack workspace (the shared key can post nowhere).
    let sm: SlackMachine;
    let sEnv: Env;
    const machineHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${sm.key}` });

    beforeEach(async () => {
      sm = await mkSlackMachine();
      sEnv = envWith([sm]);
    });

    function createFailingDb(
      realDb: D1Database,
      sqlMatcher: (sql: string) => boolean,
      errorMsg = "D1 failure",
    ) {
      return new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (sqlMatcher(sql)) {
                return new Proxy(stmt, {
                  get(stmtTarget, stmtProp) {
                    if (stmtProp === "bind") {
                      return (...args: any[]) => {
                        const bound = stmtTarget.bind(...args);
                        return new Proxy(bound, {
                          get(boundTarget, boundProp) {
                            if (["first", "run", "all", "raw"].includes(boundProp as string)) {
                              return () => Promise.reject(new Error(errorMsg));
                            }
                            return Reflect.get(boundTarget, boundProp, receiver);
                          },
                        });
                      };
                    }
                    if (["first", "run", "all", "raw"].includes(stmtProp as string)) {
                      return () => Promise.reject(new Error(errorMsg));
                    }
                    return Reflect.get(stmtTarget, stmtProp, receiver);
                  },
                });
              }
              return stmt;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }

    it("withD1 helper resolves promise or wraps throw in StorageError", async () => {
      const val = await withD1("test.op", Promise.resolve(42));
      expect(val).toBe(42);

      const error = new Error("d1 explosion");
      await expect(withD1("test.op", Promise.reject(error))).rejects.toThrow(StorageError);

      try {
        await withD1("test.op", Promise.reject(error));
      } catch (err: any) {
        expect(err).toBeInstanceOf(StorageError);
        expect(err.op).toBe("test.op");
        expect(err.cause).toBe(error);
        expect(err.message).toBe("D1 storage error in test.op: d1 explosion");
      }
    });

    it("POST /sessions/register fails at registerSession.existing site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("SELECT session_id, machine_id, updated_at FROM sessions"),
        "D1 unavailable on existing check",
      );
      const testEnv = { ...env, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993101", machineId: "mach-1" }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "registerSession.existing",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "registerSession.existing",
          error: expect.stringContaining("D1 unavailable on existing check"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /sessions/register fails at registerSession.count site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("SELECT COUNT(*) as count FROM sessions"),
        "D1 unavailable on count check",
      );
      const testEnv = { ...env, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993102", machineId: "mach-1" }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "registerSession.count",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "registerSession.count",
          error: expect.stringContaining("D1 unavailable on count check"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /sessions/register fails at registerSession.upsert site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("INSERT INTO sessions"),
        "D1 unavailable on upsert",
      );
      const testEnv = { ...env, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993103", machineId: "mach-1" }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "registerSession.upsert",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "registerSession.upsert",
          error: expect.stringContaining("D1 unavailable on upsert"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /notifications/send fails at send.sessionLookup site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("SELECT * FROM sessions WHERE session_id"),
        "D1 query timeout on session lookup",
      );
      const testEnv = { ...sEnv, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/notifications/send", {
          method: "POST",
          headers: machineHeaders(),
          body: JSON.stringify({
            sessionId: "sess-503-993104",
            text: "hello world",
          }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "send.sessionLookup",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "send.sessionLookup",
          error: expect.stringContaining("D1 query timeout on session lookup"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /notifications/send fails at send.idempotencyLookup site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993105", machineId: "mach-1" }),
        }),
        env,
      );

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("SELECT * FROM messages WHERE notification_id"),
        "D1 query timeout on idempotency lookup",
      );
      const testEnv = { ...sEnv, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/notifications/send", {
          method: "POST",
          headers: machineHeaders(),
          body: JSON.stringify({
            sessionId: "sess-503-993105",
            notificationId: "notif-503-993105",
            text: "hello world",
          }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "send.idempotencyLookup",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "send.idempotencyLookup",
          error: expect.stringContaining("D1 query timeout on idempotency lookup"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /notifications/send fails at send.touchSession site", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993106", machineId: "mach-1" }),
        }),
        env,
      );

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("UPDATE sessions SET updated_at"),
        "D1 error on touch session",
      );
      const testEnv = { ...sEnv, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/notifications/send", {
          method: "POST",
          headers: machineHeaders(),
          body: JSON.stringify({
            sessionId: "sess-503-993106",
            text: "hello world",
          }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "send.touchSession",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "send.touchSession",
          error: expect.stringContaining("D1 error on touch session"),
        }),
      );

      spy.mockRestore();
    });

    it("POST /notifications/send fails at send.insertMessage site", async () => {
      fetchMock.activate();
      fetchMock.disableNetConnect();

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      await worker.fetch(
        new Request("https://worker/sessions/register", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ sessionId: "sess-503-993107", machineId: "mach-1" }),
        }),
        env,
      );

      // A topic the post goes into, so the provider call is one chat.postMessage.
      const { channelId } = await seedSlackTopic("sess-503-993107", sm.machineId, sm.ws);
      slack("chat.postMessage", posted(channelId));

      const failingDb = createFailingDb(
        env.DB,
        (sql) => sql.includes("INSERT INTO messages"),
        "D1 error on insert message",
      );
      const testEnv = { ...sEnv, DB: failingDb };

      const res = await worker.fetch(
        new Request("https://worker/notifications/send", {
          method: "POST",
          headers: machineHeaders(),
          body: JSON.stringify({
            sessionId: "sess-503-993107",
            text: "hello world",
          }),
        }),
        testEnv,
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        error: "storage_error",
        store: "d1",
        op: "send.insertMessage",
      });

      expect(spy).toHaveBeenCalledWith(
        "[worker] storage error",
        expect.objectContaining({
          op: "send.insertMessage",
          error: expect.stringContaining("D1 error on insert message"),
        }),
      );

      fetchMock.get("https://slack.com").cleanMocks();
      fetchMock.deactivate();
      spy.mockRestore();
    });
  });



/**
 * W1 (pigeon-mmu): Telegram service messages and text-less messages used to be
 * queued as execute commands with an empty `command`, which the plugin then
 * rejected with INVALID_PAYLOAD.
 *
 * Creating a forum topic emitted exactly one of these per topic — 6 topics, 6
 * failures, always +5s (the daemon poll interval).
 */
// ─── /tag command ─────────────────────────────────────────────────────

// ─── Relocation alert (pigeon-t5bd) ──────────────────────────────────────

describe("relocation alert (pigeon-t5bd)", () => {
  let rm: SlackMachine;
  let rEnv: Env;
  let srv: ReturnType<typeof fakeSlack>;

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    rm = await mkSlackMachine();
    rEnv = envWith([rm]);
    srv = fakeSlack();
  });

  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
    vi.restoreAllMocks();
  });

  const notify = (sessionId: string, extra: Record<string, unknown> = {}) =>
    handleSendNotification(
      env.DB,
      rEnv,
      postJson("/notifications/send", rm.key, { sessionId, text: "body", title: "t", dir: "pigeon", threaded: true, ...extra }),
    );
  const alertPosts = () =>
    slackOf("chat.postMessage").filter((c) => String(c.params.get("text")).includes("not its channel"));

  it("alerts when a permanent 4xx relocates the notification to General", async () => {
    const sessionId = await seedSession(rm.machineId);
    const topic = await seedSlackTopic(sessionId, rm.machineId, rm.ws);
    const alerts = await seedAlerts(rm.ws);
    const refused = { ok: false, error: "invalid_blocks" };
    srv.script("chat.postMessage", refused, refused);

    const res = await notify(sessionId);
    expect(res.status).toBe(200);

    const alert = alertPosts()[0];
    expect(alert).toBeDefined();
    expect(alert!.params.get("text")).toContain(sessionId);
    expect(alert!.params.get("text")).toContain("send_failed");
    // The alert goes to the workspace's #alerts, never into the channel it is reporting on...
    expect(alert!.params.get("channel")).toBe(alerts);
    // ...and the notification itself was first sent to the session's channel.
    expect(slackOf("chat.postMessage")[0]!.params.get("channel")).toBe(topic.channelId);
  });

  it("alerts on poll_exhausted, the path the intended/actual columns CANNOT see", async () => {
    const sessionId = await seedSession(rm.machineId);
    // A live reservation held by someone else, never finalized: resolveTopic polls, gives up,
    // and returns messageThreadId null -> the notification goes to General with NO intended id.
    await reserve(env.DB, {
      sessionId,
      machineId: rm.machineId,
      chatId: slackChatId(rm.ws),
      name: "x",
      now: Date.now(),
    });

    const res = await notify(sessionId);
    expect(res.status).toBe(200);

    const alert = alertPosts()[0];
    expect(alert).toBeDefined();
    expect(alert!.params.get("text")).toContain("poll_exhausted");

    // And prove the column pair is blind to it, which is why the alert cannot be built on them.
    const row = await env.DB.prepare(
      "SELECT intended_thread_id, actual_thread_id FROM messages WHERE session_id = ?",
    ).bind(sessionId).first<{ intended_thread_id: number | null; actual_thread_id: number | null }>();
    expect(row?.intended_thread_id).toBeNull();
  });

  it("does not alert for a normal threaded send", async () => {
    const sessionId = await seedSession(rm.machineId);
    await seedSlackTopic(sessionId, rm.machineId, rm.ws);

    expect((await notify(sessionId)).status).toBe(200);
    // One post: a spurious second send is captured by the persistent fake, so this can fail.
    expect(slackOf("chat.postMessage")).toHaveLength(1);
    expect(alertPosts()).toHaveLength(0);
  });

  it("does not alert when the caller deliberately asked for an unthreaded send", async () => {
    const sessionId = await seedSession(rm.machineId);
    await seedAlerts(rm.ws);

    const res = await notify(sessionId, { text: "quiet question", threaded: false });
    expect(res.status).toBe(200);
    expect(slackOf("chat.postMessage")).toHaveLength(1);
    expect(alertPosts()).toHaveLength(0);
  });

  it("a failing alert never fails the notification it is reporting on", async () => {
    const sessionId = await seedSession(rm.machineId);
    await reserve(env.DB, {
      sessionId,
      machineId: rm.machineId,
      chatId: slackChatId(rm.ws),
      name: "x",
      now: Date.now(),
    });
    await seedAlerts(rm.ws);
    // The notification itself posts; the alert's transport dies.
    srv.script("chat.postMessage", { ok: true, ts: "1.1", channel: "C" }, { throws: "alert transport died" });

    const res = await notify(sessionId);
    expect(res.status).toBe(200);
  });
});

// ─── Unparseable 200 base rate (pigeon-jahv) ─────────────────────────────

// ─── Named topics (POST /topics/named) ─────────────────────────────────

describe("named topics", () => {
  let nm: SlackMachine;
  let nEnv: Env;
  let srv: ReturnType<typeof fakeSlack>;
  let CHAT = "";
  let seq = 0;
  const nextKey = () => `test:named-${Date.now()}-${++seq}`;

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    nm = await mkSlackMachine();
    nEnv = envWith([nm]);
    CHAT = slackChatId(nm.ws);
    srv = fakeSlack();
  });
  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
  });

  const jsonHeaders = (key: string | null) => ({
    "Content-Type": "application/json",
    ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
  });

  /** Through the handler as the workspace's machine; the target is the machine's own workspace. */
  function named(body: Record<string, unknown>, key: string | null = nm.key, e: Env = nEnv) {
    return handleNamedTopic(env.DB, e, new Request("https://worker/topics/named", {
      method: "POST",
      headers: jsonHeaders(key),
      body: JSON.stringify(body),
    }));
  }

  /** A stored named topic over a conversation Slack knows. */
  async function seedNamed(key: string, opts: { reopenCheckedAt?: number | null } = {}) {
    const channelId = `CN${stamp()}`.toUpperCase();
    const thread = await seedChannel(nm.ws.teamId, channelId);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, 'n', ?, ?, ?)`,
    ).bind(CHAT, key, thread, opts.reopenCheckedAt ?? null, now, now).run();
    return { channelId, thread };
  }
  const handleOf = async (channelId: string) =>
    (await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
      .bind(nm.ws.teamId, channelId)
      .first<{ handle: number }>())!.handle;

  test("requires auth", async () => {
    const res = await named({ key: nextKey(), name: "n" }, null);
    expect(res.status).toBe(401);
  });

  test("route is mounted", async () => {
    const res = await SELF.fetch("https://worker/topics/named", { method: "POST", headers: authHeaders, body: "{}" });
    expect(res.status).toBe(400);
  });

  test("rejects a bad key, a reserved key, and a principal with no workspace (all fail-open signals)", async () => {
    expect((await named({ key: "has space", name: "n" })).status).toBe(400);
    expect((await named({ key: "x".repeat(65), name: "n" })).status).toBe(400);
    expect((await named({ key: "", name: "n" })).status).toBe(400);
    expect((await named({ key: nextKey(), name: "n", staleThreadId: "7" })).status).toBe(400);
    expect((await named({ key: "_alerts", name: "n" })).status).toBe(400);
    // The shared key is on no workspace, so it has nowhere to put a topic.
    expect((await named({ chatId: CHAT, key: nextKey(), name: "n" }, "test-api-key")).status).toBe(403);
  });

  test("creates a topic for a new key, then reuses it without another create", async () => {
    const key = nextKey();

    const first = await named({ key, name: "  Digest one  " });
    expect(first.status).toBe(200);
    const a = (await first.json()) as any;
    expect(srv.created).toHaveLength(1);
    expect(a).toEqual({ chatId: CHAT, messageThreadId: await handleOf(srv.created[0]!.id), created: true });
    expect(srv.of("conversations.setTopic")[0]!.params.get("topic")).toBe("Digest one");

    const second = await named({ key, name: "a different name is ignored" });
    expect((await second.json()) as any).toEqual({ chatId: CHAT, messageThreadId: a.messageThreadId, created: false });
    expect(srv.created).toHaveLength(1);
  });

  test("falls back to the key as the name, and truncates to 128 chars", async () => {
    const k1 = nextKey();
    await named({ key: k1, name: "   " });
    await named({ key: nextKey(), name: "y".repeat(300) });
    const topics = srv.of("conversations.setTopic").map((c) => c.params.get("topic"));
    expect(topics[0]).toBe(k1);
    expect(topics[1]).toHaveLength(128);
  });

  test("create failure -> 502, nothing stored", async () => {
    const key = nextKey();
    srv.script("conversations.create", { ok: false, error: "restricted_action" });
    expect((await named({ key, name: "n" })).status).toBe(502);
    expect(await env.DB.prepare("SELECT * FROM named_topics WHERE topic_key = ?").bind(key).first()).toBeNull();
  });

  test("reopens an existing topic at most once per interval, and recreates one deleted out of band", async () => {
    const key = nextKey();
    const { thread } = await seedNamed(key, { reopenCheckedAt: Date.now() - 2 * 60 * 60 * 1000 });

    // Already open: the reopen is "not archived", which is as good as done.
    srv.script("conversations.unarchive", { ok: false, error: "not_archived" });
    const r1 = (await (await named({ key, name: "n" })).json()) as any;
    const r2 = (await (await named({ key, name: "n" })).json()) as any;
    expect(r1.messageThreadId).toBe(thread);
    expect(r2.messageThreadId).toBe(thread);
    expect(srv.of("conversations.unarchive")).toHaveLength(1);

    // Deleted out of band: the daemon reports the stale thread and gets a new topic.
    const r3 = (await (await named({ key, name: "n", staleThreadId: thread })).json()) as any;
    expect(srv.created).toHaveLength(1);
    expect(r3).toEqual({ chatId: CHAT, messageThreadId: await handleOf(srv.created[0]!.id), created: true });
    expect(r3.messageThreadId).not.toBe(thread);

    // A stale report naming a thread that is no longer stored does not drop the new one.
    const r4 = (await (await named({ key, name: "n", staleThreadId: thread })).json()) as any;
    expect(r4.messageThreadId).toBe(r3.messageThreadId);
    expect(srv.created).toHaveLength(1);
  });

  test("a reopen that reports thread-not-found recreates the topic", async () => {
    const key = nextKey();
    const { thread } = await seedNamed(key, { reopenCheckedAt: null });
    srv.script("conversations.unarchive", { ok: false, error: "channel_not_found" });
    const r = (await (await named({ key, name: "n" })).json()) as any;
    expect(srv.created).toHaveLength(1);
    expect(r).toEqual({ chatId: CHAT, messageThreadId: await handleOf(srv.created[0]!.id), created: true });
    expect(r.messageThreadId).not.toBe(thread);
  });

  test("named topics are invisible to the orphan-closer and the reaper", async () => {
    const now = Date.now();
    const thread = SLACK_HANDLE_MIN + 884000 + seq;
    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, created_at, updated_at)
       VALUES (?, ?, ?, 'n', ?, ?)`,
    ).bind(CHAT, nextKey(), thread, now - 60 * 86400 * 1000, now - 60 * 86400 * 1000).run();
    const { client, calls } = fakeTransport();
    await closeOrphanedTopics(env.DB, { now, orphanTtlMs: ORPHAN_TTL_MS, transport: client });
    await reapTopics(env.DB, { now });
    expect(calls.archiveConversation.filter((c) => c.messageThreadId === thread)).toHaveLength(0);
    // The reaper makes no provider call at all, so what it must leave alone is the D1 row.
    const left = await env.DB.prepare("SELECT 1 FROM named_topics WHERE message_thread_id = ?").bind(thread).first();
    expect(left).not.toBeNull();
  });

  test("a message typed in a named topic gets one rate-limited hint", async () => {
    const key = nextKey();
    const { channelId, thread } = await seedNamed(key);

    // The inbound side (what Slack's ingress calls for a message in a channel with no session).
    expect(await maybeAnswerInNamedTopic(env.DB, nEnv, CHAT, thread)).toBe(true);
    expect(await maybeAnswerInNamedTopic(env.DB, nEnv, CHAT, thread)).toBe(true);

    const sends = slackOf("chat.postMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params.get("channel")).toBe(channelId);
    expect(sends[0]!.params.get("text")).toContain(NAMED_TOPIC_HINT_TEXT);
  });
});

// ─── Named topic binding (POST /topics/named/bind, unbind) ───────────────

describe("named topic binding", () => {
  let bm: SlackMachine;
  let bEnv: Env;
  let srv: ReturnType<typeof fakeSlack>;
  let CHAT = "";
  let seq = 0;
  const nextKey = () => `test:named-bind-${Date.now()}-${++seq}`;

  beforeEach(async () => {
    resetSlackCalls();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    bm = await mkSlackMachine();
    bEnv = envWith([bm]);
    CHAT = slackChatId(bm.ws);
    srv = fakeSlack();
  });
  afterEach(() => {
    fetchMock.get("https://slack.com").cleanMocks();
    fetchMock.deactivate();
  });

  const machineAuth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${bm.key}` });
  /** The handle of the n-th conversation the fake Slack created. */
  const createdHandle = async (n: number) =>
    (await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
      .bind(bm.ws.teamId, srv.created[n]!.id)
      .first<{ handle: number }>())!.handle;

  function bind(body: Record<string, unknown>, e: Env = bEnv, headers: Record<string, string> = machineAuth()) {
    return handleNamedTopicBind(env.DB, e, new Request("https://worker/topics/named/bind", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }));
  }

  function unbind(body: Record<string, unknown>, e: Env = bEnv, headers: Record<string, string> = machineAuth()) {
    return handleNamedTopicUnbind(env.DB, e, new Request("https://worker/topics/named/unbind", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }));
  }

  async function registerSessionRow(sessionId: string) {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, 'devbox', null, ?, ?)",
    ).bind(sessionId, now, now).run();
  }

  test("1. bind with no sessions row -> 409 session not registered, no binding row", async () => {
    const key = nextKey();
    const sessionId = `ses_no_session_${Date.now()}`;
    const res = await bind({ key, name: "Topic", sessionId });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe("session not registered");
    const row = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE session_id = ?").bind(sessionId).first();
    expect(row).toBeNull();
  });

  test("2. register session, bind -> 200 bound:true; getBoundSessionByThread returns the session", async () => {
    const key = nextKey();
    const sessionId = `ses_bind_ok_${Date.now()}`;
    await registerSessionRow(sessionId);

    const res = await bind({ key, name: "Topic", sessionId });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const threadId = await createdHandle(0);
    expect(body).toEqual({
      chatId: CHAT,
      messageThreadId: threadId,
      created: true,
      bound: true,
      sessionId,
    });

    const bound = await getBoundSessionByThread(env.DB, CHAT, threadId);
    expect(bound).toBe(sessionId);

    const binding = await getBindingForSession(env.DB, sessionId);
    expect(binding).toEqual({
      chat_id: CHAT,
      topic_key: key,
      message_thread_id: threadId,
    });
  });

  test("3. bind the same session to a second key -> first binding gone (one topic per session)", async () => {
    const key1 = nextKey();
    const key2 = nextKey();
    const sessionId = `ses_rebind_${Date.now()}`;
    await registerSessionRow(sessionId);

    const res1 = await bind({ key: key1, name: "Topic 1", sessionId });
    expect(res1.status).toBe(200);
    const thread1 = await createdHandle(0);
    expect(await getBoundSessionByThread(env.DB, CHAT, thread1)).toBe(sessionId);

    const res2 = await bind({ key: key2, name: "Topic 2", sessionId });
    expect(res2.status).toBe(200);
    const thread2 = await createdHandle(1);

    expect(await getBoundSessionByThread(env.DB, CHAT, thread1)).toBeNull();
    expect(await getBoundSessionByThread(env.DB, CHAT, thread2)).toBe(sessionId);

    const binding = await getBindingForSession(env.DB, sessionId);
    expect(binding?.topic_key).toBe(key2);
  });

  test("4. bind a second session to the same key -> key now routes to the second session", async () => {
    const key = nextKey();
    const session1 = `ses_s1_${Date.now()}`;
    const session2 = `ses_s2_${Date.now()}`;
    await registerSessionRow(session1);
    await registerSessionRow(session2);

    const res1 = await bind({ key, name: "Topic", sessionId: session1 });
    expect(res1.status).toBe(200);
    const thread = await createdHandle(0);
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBe(session1);

    const res2 = await bind({ key, name: "Topic", sessionId: session2 });
    expect(res2.status).toBe(200);
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBe(session2);

    expect(await getBindingForSession(env.DB, session1)).toBeNull();
    expect((await getBindingForSession(env.DB, session2))?.topic_key).toBe(key);
  });

  test("5. unbind -> {unbound:1}; again -> {unbound:0}; lookup -> null", async () => {
    const key = nextKey();
    const sessionId = `ses_unbind_${Date.now()}`;
    await registerSessionRow(sessionId);

    await bind({ key, name: "Topic", sessionId });
    const thread = await createdHandle(0);
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBe(sessionId);

    const res1 = await unbind({ sessionId });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ unbound: 1 });
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBeNull();
    expect(await getBindingForSession(env.DB, sessionId)).toBeNull();

    const res2 = await unbind({ sessionId });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ unbound: 0 });
  });

  test("6. binding whose session row was deleted -> lookup null (inert)", async () => {
    const key = nextKey();
    const sessionId = `ses_deleted_row_${Date.now()}`;
    await registerSessionRow(sessionId);

    await bind({ key, name: "Topic", sessionId });
    const thread = await createdHandle(0);
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBe(sessionId);

    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
    expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBeNull();
  });

  test("7. auth: no bearer -> 401 on both routes", async () => {
    const noAuth = { "Content-Type": "application/json" };
    const r1 = await bind({ key: nextKey(), name: "n", sessionId: "ses_1" }, bEnv, noAuth);
    expect(r1.status).toBe(401);
    const r2 = await unbind({ sessionId: "ses_1" }, bEnv, noAuth);
    expect(r2.status).toBe(401);
  });

  test("routes are mounted in worker", async () => {
    const res1 = await SELF.fetch("https://worker/topics/named/bind", { method: "POST", headers: authHeaders, body: "{}" });
    expect(res1.status).toBe(400);
    const res2 = await SELF.fetch("https://worker/topics/named/unbind", { method: "POST", headers: authHeaders, body: "{}" });
    expect(res2.status).toBe(400);
  });

  test("bind input validation: bad key, bad sessionId, and a principal with no workspace", async () => {
    const sessionId = "ses_valid";
    await registerSessionRow(sessionId);
    expect((await bind({ key: "bad key", name: "n", sessionId })).status).toBe(400);
    expect((await bind({ key: "valid_key", name: "n", sessionId: "" })).status).toBe(400);
    expect((await bind({ key: "valid_key", name: "n", sessionId: "x".repeat(129) })).status).toBe(400);
    // The shared key is on no workspace, so it has nowhere to put a topic.
    expect((await bind({ chatId: CHAT, key: "valid_key", name: "n", sessionId }, bEnv, authHeaders)).status).toBe(403);
  });

  test("unbind input validation: missing or invalid sessionId", async () => {
    expect((await unbind({})).status).toBe(400);
    expect((await unbind({ sessionId: "" })).status).toBe(400);
    expect((await unbind({ sessionId: "x".repeat(129) })).status).toBe(400);
  });

  test("schema skew: when named_topic_bindings is missing, lookups warn and degrade to null", async () => {
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    const now = Date.now();
    const sessionId = `ses_skew_${now}`;
    const namedChannel = `CSK${stamp()}`.toUpperCase();
    const thread = await seedChannel(bm.ws.teamId, namedChannel);
    const key = nextKey();

    await registerSessionRow(sessionId);

    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, created_at, updated_at)
       VALUES (?, ?, ?, 'n', ?, ?)`,
    ).bind(CHAT, key, thread, now, now).run();

    try {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await env.DB.exec("DROP TABLE named_topic_bindings");

      expect(await getBindingForSession(env.DB, sessionId)).toBeNull();
      expect(await getBoundSessionByThread(env.DB, CHAT, thread)).toBeNull();

      const notifRes = await handleSendNotification(
        env.DB,
        bEnv,
        postJson("/notifications/send", bm.key, {
          sessionId,
          text: "notification during schema skew",
          title: "Skew Title",
          dir: "pigeon",
          threaded: true,
        }),
      );
      expect(notifRes.status).toBe(200);
      // The session got its own topic: a missing bindings table must not hide that it has none bound.
      expect(srv.created).toHaveLength(1);
      expect(slackOf("chat.postMessage")[0]!.params.get("channel")).toBe(srv.created[0]!.id);

      expect(await maybeAnswerInNamedTopic(env.DB, bEnv, CHAT, thread)).toBe(true);
      const hint = slackOf("chat.postMessage")[1];
      expect(hint!.params.get("channel")).toBe(namedChannel);
      expect(hint!.params.get("text")).toContain(NAMED_TOPIC_HINT_TEXT);

      expect(warnSpy).toHaveBeenCalled();
    } finally {
      await env.DB.prepare("DROP TABLE IF EXISTS named_topic_bindings").run().catch(() => {});
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS named_topic_bindings (
          chat_id     TEXT NOT NULL,
          topic_key   TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          bound_at    INTEGER NOT NULL,
          PRIMARY KEY (chat_id, topic_key)
        )
      `).run();
      await env.DB.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_named_topic_bindings_session
          ON named_topic_bindings(session_id)
      `).run();
      warnSpy?.mockRestore();
    }
  });

  test("a transient D1 error in the binding lookups still throws (only a missing table degrades)", async () => {
    const failing = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1_ERROR: Network connection lost.");
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(getBindingForSession(failing, "ses_x")).rejects.toThrow(/Network connection lost/);
    await expect(getBoundSessionByThread(failing, "1", 2)).rejects.toThrow(/Network connection lost/);
  });
});

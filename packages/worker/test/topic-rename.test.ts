import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { clearCredentialCache, sha256Hex } from "../src/credentials";
import { getBySession } from "../src/topics";

const SHARED_KEY = "test-api-key";
const MACHINE_KEY_A = "pgk_" + "A".repeat(43);
const MACHINE_KEY_B = "pgk_" + "B".repeat(43);
const MACHINE_A = "mach-alpha";
const MACHINE_B = "mach-beta";

const topicsEnv = {
  ...env,
  TELEGRAM_TOPICS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "test-bot-token",
} as Env;

async function addMachineKey(key: string, machineId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, note)
     VALUES (?, ?, ?, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
}

async function seedSession(sessionId: string, machineId: string, label: string = "Original Label"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, machineId, label, now, now)
    .run();
}

async function seedTopic(opts: {
  sessionId: string;
  chatId: string;
  threadId: number | null;
  name: string;
  provisional?: number;
}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO topics (session_id, machine_id, chat_id, message_thread_id, name, name_provisional, state, created_at, updated_at)
     VALUES (?, 'test-mach', ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(opts.sessionId, opts.chatId, opts.threadId, opts.name, opts.provisional ?? 1, now, now)
    .run();
}

async function callRename(
  body: unknown,
  init: { key?: string | null; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = init.key !== undefined ? init.key : SHARED_KEY;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const request = new Request("https://worker/topics/rename", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return worker.fetch(request, { ...topicsEnv, ...(init.envOverride ?? {}) } as Env);
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  clearCredentialCache();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe("POST /topics/rename", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const resNoAuth = await callRename({ sessionId: "s1", title: "T", dir: "D" }, { key: null });
    expect(resNoAuth.status).toBe(401);

    const resBadAuth = await callRename({ sessionId: "s1", title: "T", dir: "D" }, { key: "bad-key" });
    expect(resBadAuth.status).toBe(401);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await callRename("{not-json");
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data.error).toBeDefined();
  });

  it("validates body fields and rejects invalid types with 400", async () => {
    const emptySession = await callRename({ sessionId: "", title: "Title", dir: "/home/dev" });
    expect(emptySession.status).toBe(400);

    const missingSession = await callRename({ title: "Title", dir: "/home/dev" });
    expect(missingSession.status).toBe(400);

    const emptyTitle = await callRename({ sessionId: "s1", title: "", dir: "/home/dev" });
    expect(emptyTitle.status).toBe(400);

    const missingTitle = await callRename({ sessionId: "s1", dir: "/home/dev" });
    expect(missingTitle.status).toBe(400);

    const missingDir = await callRename({ sessionId: "s1", title: "Title" });
    expect(missingDir.status).toBe(400);

    const nonStringDir = await callRename({ sessionId: "s1", title: "Title", dir: 123 });
    expect(nonStringDir.status).toBe(400);

    // dir as empty string is allowed
    await seedSession("s-empty-dir", "mach-1");
    const emptyDirRes = await callRename({ sessionId: "s-empty-dir", title: "Title", dir: "" });
    // Will not fail validation with 400 (it may return 200 no_topic because topic doesn't exist)
    expect(emptyDirRes.status).not.toBe(400);
  });

  it("rejects a whitespace-only title, which would strip the topic down to its directory", async () => {
    await seedSession("s-ws", "mach-1");
    const res = await callRename({ sessionId: "s-ws", title: "   ", dir: "~/project" });
    expect(res.status).toBe(400);
  });

  it("rejects placeholder titles with 400", async () => {
    await seedSession("s-ph", "mach-1");

    const res1 = await callRename({
      sessionId: "s-ph",
      title: "New session - 2026-11-02T10:00:00.000Z",
      dir: "~/project",
    });
    expect(res1.status).toBe(400);
    expect(await res1.json()).toMatchObject({ error: "placeholder_title" });

    const res2 = await callRename({
      sessionId: "s-ph",
      title: "New Chat",
      dir: "~/project",
    });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: "placeholder_title" });
  });

  it("returns 404 unknown_session when session does not exist", async () => {
    const res = await callRename({
      sessionId: "ses_does_not_exist",
      title: "Good Title",
      dir: "~/project",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_session" });
  });

  it("returns 403 machine_mismatch when machine credential does not own the session", async () => {
    await addMachineKey(MACHINE_KEY_A, MACHINE_A);
    await addMachineKey(MACHINE_KEY_B, MACHINE_B);

    const sessionId = "ses_mach_mismatch";
    await seedSession(sessionId, MACHINE_B);

    const res = await callRename(
      { sessionId, title: "Title", dir: "~/project" },
      { key: MACHINE_KEY_A },
    );
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("machine_mismatch");
  });

  it("returns 409 bound_session when session has a row in named_topic_bindings", async () => {
    const sessionId = "ses_coord_bound";
    await seedSession(sessionId, MACHINE_A);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at)
       VALUES ('-1001234567890', 'sw:main', ?, ?)`,
    )
      .bind(sessionId, Date.now())
      .run();

    const res = await callRename({
      sessionId,
      title: "New Title",
      dir: "~/project",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bound_session" });
  });

  it("returns 200 renamed: false, reason: 'topics_disabled' when topics are disabled in env", async () => {
    const sessionId = "ses_topics_off";
    await seedSession(sessionId, MACHINE_A);

    const res = await callRename(
      { sessionId, title: "Title", dir: "~/project" },
      { envOverride: { TELEGRAM_TOPICS_ENABLED: "false" } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: false, reason: "topics_disabled" });
  });

  it("returns 200 renamed: false, reason: 'no_topic' when session has no topic row", async () => {
    const sessionId = "ses_no_topic_row";
    await seedSession(sessionId, MACHINE_A);

    const res = await callRename({
      sessionId,
      title: "Title",
      dir: "~/project",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: false, reason: "no_topic" });
  });

  it("returns 200 renamed: false, reason: 'no_topic' when topic row has message_thread_id null", async () => {
    const sessionId = "ses_topic_reserved";
    await seedSession(sessionId, MACHINE_A);
    await seedTopic({
      sessionId,
      chatId: "-1001234567890",
      threadId: null,
      name: "Old Provisional",
    });

    const res = await callRename({
      sessionId,
      title: "Title",
      dir: "~/project",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: false, reason: "no_topic" });
  });

  it("happy path: edits Telegram with '<title> · ~/dir', writes D1 name with name_provisional=0, leaves sessions.label untouched", async () => {
    const sessionId = "ses_rename_happy";
    const chatId = "-1001234567890";
    const threadId = 884411;
    await seedSession(sessionId, MACHINE_A, "Old Session Label");
    await seedTopic({
      sessionId,
      chatId,
      threadId,
      name: "Old Provisional · ~/dir",
      provisional: 1,
    });

    let capturedEditPayload: any;
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
      .reply((opts: any) => {
        capturedEditPayload = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
        return {
          statusCode: 200,
          data: JSON.stringify({ ok: true, result: true }),
          responseOptions: { headers: { "Content-Type": "application/json" } },
        };
      });

    const res = await callRename({
      sessionId,
      title: "Fix Authentication Bug",
      dir: "/home/dev/projects/pigeon",
    });

    expect(res.status).toBe(200);
    const expectedName = "Fix Authentication Bug · ~/projects/pigeon";
    expect(await res.json()).toEqual({ renamed: true, name: expectedName });

    expect(capturedEditPayload).toEqual({
      chat_id: chatId,
      message_thread_id: threadId,
      name: expectedName,
    });

    // Verify D1 topic row updated
    const topic = await getBySession(env.DB, sessionId);
    expect(topic?.name).toBe(expectedName);
    expect(topic?.name_provisional).toBe(0);

    // Verify sessions.label was NOT touched
    const session = await env.DB
      .prepare("SELECT label FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .first<{ label: string }>();
    expect(session?.label).toBe("Old Session Label");
  });

  it.each([
    ["a titled topic", "Old work · ~/projects/pigeon", 0],
    ["a provisional, directory-only topic", "~/projects/pigeon", 1],
  ])("keeps the current directory suffix of %s when the caller sends no dir", async (_kind, oldName, provisional) => {
    const sessionId = `ses_keep_dir_${provisional}`;
    await seedSession(sessionId, MACHINE_A);
    await seedTopic({ sessionId, chatId: "-1001234567890", threadId: 884500 + provisional, name: oldName, provisional });

    let captured: any;
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
      .reply((opts: any) => {
        captured = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
        return {
          statusCode: 200,
          data: JSON.stringify({ ok: true, result: true }),
          responseOptions: { headers: { "Content-Type": "application/json" } },
        };
      });

    const res = await callRename({ sessionId, title: "New work", dir: "" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: true, name: "New work · ~/projects/pigeon" });
    expect(captured.name).toBe("New work · ~/projects/pigeon");
  });

  it("treats TOPIC_NOT_MODIFIED as success, updating D1 and returning 200", async () => {
    const sessionId = "ses_topic_not_modified";
    const chatId = "-1001234567890";
    const threadId = 884422;
    await seedSession(sessionId, MACHINE_A);
    await seedTopic({
      sessionId,
      chatId,
      threadId,
      name: "Stale Name",
      provisional: 1,
    });

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
      .reply(() => ({
        statusCode: 400,
        data: JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: TOPIC_NOT_MODIFIED",
        }),
        responseOptions: { headers: { "Content-Type": "application/json" } },
      }));

    const res = await callRename({
      sessionId,
      title: "Already Renamed",
      dir: "/home/dev/projects/pigeon",
    });

    expect(res.status).toBe(200);
    const expectedName = "Already Renamed · ~/projects/pigeon";
    expect(await res.json()).toEqual({ renamed: true, name: expectedName });

    const topic = await getBySession(env.DB, sessionId);
    expect(topic?.name).toBe(expectedName);
    expect(topic?.name_provisional).toBe(0);
  });

  it("returns 502 telegram_failed and leaves D1 untouched when Telegram fails", async () => {
    const sessionId = "ses_tg_fail";
    const chatId = "-1001234567890";
    const threadId = 884433;
    await seedSession(sessionId, MACHINE_A);
    await seedTopic({
      sessionId,
      chatId,
      threadId,
      name: "Untouched Name",
      provisional: 1,
    });

    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/editForumTopic/ })
      .reply(() => ({
        statusCode: 400,
        data: JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat is not a forum",
        }),
        responseOptions: { headers: { "Content-Type": "application/json" } },
      }));

    const res = await callRename({
      sessionId,
      title: "Will Fail",
      dir: "/home/dev/projects/pigeon",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("telegram_failed");
    expect(body.detail).toBeDefined();

    // D1 topic untouched
    const topic = await getBySession(env.DB, sessionId);
    expect(topic?.name).toBe("Untouched Name");
    expect(topic?.name_provisional).toBe(1);
  });
});

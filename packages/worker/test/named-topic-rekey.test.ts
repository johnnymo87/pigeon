import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { handleNamedTopicRekey } from "../src/named-topic-rekey";
import { getNamedTopic, getBindingForSession } from "../src/named-topics";
import { slackChatId } from "../src/chat/slack-config";
import {
  envWith,
  fakeTransport,
  mkSlackMachine,
  postJson,
  resetSlackCalls,
  results,
  seedChannel,
  stamp,
  type SlackMachine,
} from "./slack-harness";
import { sha256Hex } from "../src/credentials";

let machine: SlackMachine;
let CHAT = "";
let topicsEnv: Env;

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  resetSlackCalls();
  machine = await mkSlackMachine();
  CHAT = slackChatId(machine.ws);
  topicsEnv = envWith([machine]);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
});

async function seedNamedTopic(opts: {
  chatId?: string;
  key: string;
  name: string;
  messageThreadId?: number;
}): Promise<number> {
  const chatId = opts.chatId ?? CHAT;
  const threadId = opts.messageThreadId ?? (await seedChannel(machine.ws.teamId, `C${stamp().toUpperCase()}`));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO named_topics
       (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
  )
    .bind(chatId, opts.key, threadId, opts.name, now, now)
    .run();
  return threadId;
}

async function seedBinding(opts: {
  chatId?: string;
  key: string;
  sessionId: string;
}): Promise<void> {
  const chatId = opts.chatId ?? CHAT;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(chatId, opts.key, opts.sessionId, Date.now())
    .run();
}

function rekeyRequest(key: string, body: unknown): Request {
  return postJson("/topics/named/rekey", key, body);
}

const rekey = (
  e: Env,
  key: string,
  body: unknown,
  transport?: Parameters<typeof handleNamedTopicRekey>[3],
) => handleNamedTopicRekey(env.DB, e, rekeyRequest(key, body), transport);

describe("POST /topics/named/rekey", () => {
  it("rejects unauthorized requests with 401", async () => {
    const resNoAuth = await handleNamedTopicRekey(
      env.DB,
      topicsEnv,
      new Request("https://worker/topics/named/rekey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name" }),
      }),
    );
    expect(resNoAuth.status).toBe(401);

    const resBadAuth = await handleNamedTopicRekey(
      env.DB,
      topicsEnv,
      postJson("/topics/named/rekey", "pgk_bogus_key", {
        fromKey: "stallwatch:old",
        toKey: "stallwatch:new",
        name: "New Name",
      }),
    );
    expect(resBadAuth.status).toBe(401);
  });

  describe("validation (400)", () => {
    it("rejects invalid JSON", async () => {
      const res = await handleNamedTopicRekey(
        env.DB,
        topicsEnv,
        new Request("https://worker/topics/named/rekey", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${machine.key}` },
          body: "not json",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid JSON" });
    });

    it("rejects invalid or missing fromKey", async () => {
      const resMissing = await rekey(topicsEnv, machine.key, { toKey: "stallwatch:new", name: "New" });
      expect(resMissing.status).toBe(400);

      const resInvalid = await rekey(topicsEnv, machine.key, { fromKey: "old bad key!", toKey: "stallwatch:new", name: "New" });
      expect(resInvalid.status).toBe(400);
    });

    it("rejects invalid or missing toKey", async () => {
      const resMissing = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:old", name: "New" });
      expect(resMissing.status).toBe(400);

      const resInvalid = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:old", toKey: "new bad key!", name: "New" });
      expect(resInvalid.status).toBe(400);
    });

    it("rejects keys starting with _ (reserved)", async () => {
      const resFrom = await rekey(topicsEnv, machine.key, { fromKey: "_alerts", toKey: "stallwatch:new", name: "New" });
      expect(resFrom.status).toBe(400);
      expect((await resFrom.json() as { error: string }).error).toMatch(/reserved/);

      const resTo = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:old", toKey: "_reserved", name: "New" });
      expect(resTo.status).toBe(400);
      expect((await resTo.json() as { error: string }).error).toMatch(/reserved/);
    });

    it("rejects identical fromKey and toKey", async () => {
      const res = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:same", toKey: "stallwatch:same", name: "New" });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/different/);
    });

    it("rejects empty or whitespace-only name", async () => {
      const resMissing = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:old", toKey: "stallwatch:new" });
      expect(resMissing.status).toBe(400);

      const resEmpty = await rekey(topicsEnv, machine.key, { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "   " });
      expect(resEmpty.status).toBe(400);
    });
  });

  describe("target authorization (403)", () => {
    it("returns 403 Chat ID not allowed when machine has no workspace", async () => {
      // Machine credential with no workspace configured in env
      const machId = `nomach${stamp()}`.slice(0, 30);
      const key = ("pgk_" + machId + "x".repeat(43)).slice(0, 47);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, note) VALUES (?, ?, ?, 'test')",
      )
        .bind(await sha256Hex(key), machId, Date.now())
        .run();

      const res = await rekey(topicsEnv, key, { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "Chat ID not allowed" });
    });
  });

  describe("dryRun", () => {
    it("returns 200 with from: null and to: null when neither topic exists", async () => {
      const res = await rekey(topicsEnv, machine.key, {
        fromKey: "stallwatch:old",
        toKey: "stallwatch:new",
        name: "New Name",
        dryRun: true,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        dryRun: true,
        from: null,
        to: null,
      });
    });

    it("returns 200 with details when from exists (with boundSession) and to does not", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Name" });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_coord1" });

      const res = await rekey(topicsEnv, machine.key, {
        fromKey: "stallwatch:old",
        toKey: "stallwatch:new",
        name: "New Name",
        dryRun: true,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        dryRun: true,
        from: {
          messageThreadId: threadId,
          name: "Old Name",
          boundSession: "gse_coord1",
        },
        to: null,
      });
    });

    it("returns 200 with details when both from and to exist", async () => {
      const thread1 = await seedNamedTopic({ key: "stallwatch:old", name: "Old Name" });
      const thread2 = await seedNamedTopic({ key: "stallwatch:new", name: "Target Name" });
      await seedBinding({ key: "stallwatch:new", sessionId: "gse_coord2" });

      const res = await rekey(topicsEnv, machine.key, {
        fromKey: "stallwatch:old",
        toKey: "stallwatch:new",
        name: "New Name",
        dryRun: true,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        dryRun: true,
        from: {
          messageThreadId: thread1,
          name: "Old Name",
          boundSession: null,
        },
        to: {
          messageThreadId: thread2,
          name: "Target Name",
          boundSession: "gse_coord2",
        },
      });
    });

    it("dryRun performs no provider calls and makes no D1 writes", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Name" });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_coord1" });

      const fake = fakeTransport();
      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name", dryRun: true },
        fake.client,
      );
      expect(res.status).toBe(200);
      expect(fake.calls.renameConversation).toHaveLength(0);

      // Verify D1 unchanged
      const fromRow = await getNamedTopic(env.DB, CHAT, "stallwatch:old");
      expect(fromRow).not.toBeNull();
      const toRow = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(toRow).toBeNull();
    });
  });

  describe("404 no_such_topic", () => {
    it("returns 404 when neither from nor to exists", async () => {
      const res = await rekey(topicsEnv, machine.key, {
        fromKey: "stallwatch:missing",
        toKey: "stallwatch:target",
        name: "New Name",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no_such_topic" });
    });
  });

  describe("409 target_exists", () => {
    it("returns 409 target_exists when both from and to exist", async () => {
      const fromThread = await seedNamedTopic({ key: "stallwatch:old", name: "Old" });
      const toThread = await seedNamedTopic({ key: "stallwatch:new", name: "New" });

      const fake = fakeTransport();
      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "Updated Name" },
        fake.client,
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "target_exists",
        messageThreadId: toThread,
      });
      expect(fake.calls.renameConversation).toHaveLength(0);

      // Verify no changes in D1
      const fromRow = await getNamedTopic(env.DB, CHAT, "stallwatch:old");
      expect(fromRow?.message_thread_id).toBe(fromThread);
      const toRow = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(toRow?.message_thread_id).toBe(toThread);
    });
  });

  describe("already (idempotent retry)", () => {
    it("returns 200 with already: true and renamed: false when from is null and to exists", async () => {
      const toThread = await seedNamedTopic({ key: "stallwatch:new", name: "Already Rekeyed" });

      const fake = fakeTransport();
      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name" },
        fake.client,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        messageThreadId: toThread,
        renamed: false,
        already: true,
      });
      expect(fake.calls.renameConversation).toHaveLength(0);
    });
  });

  describe("transport failures", () => {
    it("maps rate_limited to 429 with retryAfter and makes no D1 changes", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Name" });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_coord1" });

      const fake = fakeTransport({
        renameConversation: () => results.rateLimited(45),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name" },
        fake.client,
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate_limited", retryAfter: 45 });

      // Verify D1 was NOT changed
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:old")).not.toBeNull();
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:new")).toBeNull();
      const binding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
        .bind(CHAT, "stallwatch:old")
        .first();
      expect(binding).not.toBeNull();
    });

    it("maps other transport failure to 502 rename_failed and makes no D1 changes", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Name" });

      const fake = fakeTransport({
        renameConversation: () => results.error(500, "Slack API error"),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name" },
        fake.client,
      );
      expect(res.status).toBe(502);
      const json = await res.json() as { error: string; details: unknown };
      expect(json.error).toBe("rename_failed");
      expect(json.details).toBeDefined();

      // Verify D1 was NOT changed
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:old")).not.toBeNull();
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:new")).toBeNull();
    });
  });

  describe("success path", () => {
    it("calls chat transport renameConversation with channelKey=toKey and moves D1 rows", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Program" });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_coord1" });
      // Another binding that should NOT be touched
      await seedBinding({ key: "stallwatch:other", sessionId: "gse_coord_other" });

      const fake = fakeTransport({
        renameConversation: () => results.ok(true),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "📋 New Program Name" },
        fake.client,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        messageThreadId: threadId,
        renamed: true,
        boundSession: "gse_coord1",
      });

      // Transport call verification
      expect(fake.calls.renameConversation).toHaveLength(1);
      expect(fake.calls.renameConversation[0]).toEqual({
        chatId: CHAT,
        messageThreadId: threadId,
        name: "📋 New Program Name",
        channelKey: "stallwatch:new",
      });

      // D1 verification: named_topics
      const oldTopic = await getNamedTopic(env.DB, CHAT, "stallwatch:old");
      expect(oldTopic).toBeNull();
      const newTopic = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(newTopic).not.toBeNull();
      expect(newTopic?.message_thread_id).toBe(threadId);
      expect(newTopic?.name).toBe("📋 New Program Name");

      // D1 verification: named_topic_bindings
      const oldBinding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
        .bind(CHAT, "stallwatch:old")
        .first();
      expect(oldBinding).toBeNull();
      const newBinding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
        .bind(CHAT, "stallwatch:new")
        .first<{ session_id: string }>();
      expect(newBinding?.session_id).toBe("gse_coord1");

      // Other binding is untouched
      const otherBinding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
        .bind(CHAT, "stallwatch:other")
        .first<{ session_id: string }>();
      expect(otherBinding?.session_id).toBe("gse_coord_other");
    });

    it("succeeds when topic is unbound, returning boundSession: null", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Unbound Topic" });

      const fake = fakeTransport({
        renameConversation: () => results.ok(true),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "New Name" },
        fake.client,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        messageThreadId: threadId,
        renamed: true,
        boundSession: null,
      });
    });

    it("treats topic_not_modified from chat transport as success", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old Topic" });

      const fake = fakeTransport({
        renameConversation: () => results.notModified(),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "Old Topic" },
        fake.client,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        chatId: CHAT,
        messageThreadId: threadId,
        renamed: true,
      });

      const newTopic = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(newTopic).not.toBeNull();
    });

    it("truncates names exceeding MAX_TOPIC_NAME_CHARS (128)", async () => {
      const threadId = await seedNamedTopic({ key: "stallwatch:old", name: "Old" });
      const longName = "A".repeat(200);

      const fake = fakeTransport({
        renameConversation: () => results.ok(true),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: longName },
        fake.client,
      );
      expect(res.status).toBe(200);

      expect(fake.calls.renameConversation[0]?.name).toBe("A".repeat(128));
      const newTopic = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(newTopic?.name).toBe("A".repeat(128));
    });

    it("leaves named topics in other workspaces/chats untouched", async () => {
      const otherChat = "slack:TOTHERTEAM";
      const otherThread = await seedNamedTopic({ chatId: otherChat, key: "stallwatch:old", name: "Other Chat Topic" });
      await seedBinding({ chatId: otherChat, key: "stallwatch:old", sessionId: "gse_other_coord" });

      const thisThread = await seedNamedTopic({ key: "stallwatch:old", name: "This Chat Topic" });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_this_coord" });

      const fake = fakeTransport({
        renameConversation: () => results.ok(true),
      });

      const res = await rekey(
        topicsEnv,
        machine.key,
        { fromKey: "stallwatch:old", toKey: "stallwatch:new", name: "Renamed Topic" },
        fake.client,
      );
      expect(res.status).toBe(200);

      // Other chat is completely untouched
      const otherTopic = await getNamedTopic(env.DB, otherChat, "stallwatch:old");
      expect(otherTopic).not.toBeNull();
      expect(otherTopic?.name).toBe("Other Chat Topic");

      const otherBinding = await env.DB.prepare("SELECT * FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
        .bind(otherChat, "stallwatch:old")
        .first<{ session_id: string }>();
      expect(otherBinding?.session_id).toBe("gse_other_coord");

      // This chat is renamed
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:old")).toBeNull();
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:new")).not.toBeNull();
    });
  });

  describe("router integration (worker.fetch)", () => {
    it("routes POST /topics/named/rekey through worker.fetch", async () => {
      const req = postJson("/topics/named/rekey", machine.key, {
        fromKey: "stallwatch:missing",
        toKey: "stallwatch:target",
        name: "New Name",
      });
      const res = await worker.fetch(req, topicsEnv);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no_such_topic" });
    });

    it("works end-to-end with real Slack transport via fetchMock and worker.fetch", async () => {
      const channelId = `CREKEY${stamp()}`.toUpperCase();
      const handle = await seedChannel(machine.ws.teamId, channelId);
      await seedNamedTopic({ key: "stallwatch:old", name: "Old Program", messageThreadId: handle });
      await seedBinding({ key: "stallwatch:old", sessionId: "gse_coord1" });

      const { slack, slackCalls } = await import("./slack-harness");
      slack("conversations.info", {
        ok: true,
        channel: { name: "stallwatch-old", topic: { value: "Old Program · 🆔 gse_coord1" } },
      });
      slack("conversations.rename", { ok: true });
      slack("conversations.setTopic", { ok: true });

      const req = postJson("/topics/named/rekey", machine.key, {
        fromKey: "stallwatch:old",
        toKey: "stallwatch:new",
        name: "📋 New Program",
      });
      const res = await worker.fetch(req, topicsEnv);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        chatId: CHAT,
        messageThreadId: handle,
        renamed: true,
        boundSession: "gse_coord1",
      });

      // Verify Slack calls
      const renames = slackCalls.filter((c) => c.method === "conversations.rename");
      expect(renames).toHaveLength(1);
      expect(renames[0]?.params.get("name")).toBe("stallwatch-new");

      const topics = slackCalls.filter((c) => c.method === "conversations.setTopic");
      expect(topics).toHaveLength(1);
      // Notice trailing session ID suffix preserved:
      expect(topics[0]?.params.get("topic")).toBe("📋 New Program · 🆔 gse_coord1");

      // Verify D1 updated
      expect(await getNamedTopic(env.DB, CHAT, "stallwatch:old")).toBeNull();
      const newRow = await getNamedTopic(env.DB, CHAT, "stallwatch:new");
      expect(newRow?.name).toBe("📋 New Program");
    });
  });
});

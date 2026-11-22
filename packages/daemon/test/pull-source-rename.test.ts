import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { initPullInboxSchema } from "../src/storage/pull-inbox-schema";
import { GoosePullAdapter, PULL_BACKEND_KIND } from "../src/adapters/goose-pull";
import {
  ALLOWED_PULL_SOURCES,
  DEFAULT_PULL_SOURCES,
  HUMAN_REPLY_SOURCE,
  LEGACY_HUMAN_REPLY_SOURCE,
} from "../src/storage/types";
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  ACCEPTED_SOURCES,
  OpencodeDirectSource,
  isExecuteCommandEnvelope,
} from "../src/opencode-direct/contracts";

/**
 * pigeon-4ogz.14: the human-reply pull source was renamed "telegram-reply" ->
 * "chat-reply". Readers outside pigeon (stall-watch, lanes) accept both names
 * before this daemon writes the new one; this daemon in turn keeps ACCEPTING the
 * old name wherever a client may still send it (pull_sources on /session-start,
 * stored rows, the opencode-direct execute envelope) so no deploy order drops a
 * reply or a registration.
 */
describe("human-reply source rename (pigeon-4ogz.14)", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp() {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId: "ses_pull", notify: true, backendKind: PULL_BACKEND_KIND, label: "worker" },
      1_000,
    );
    return { app: createApp(storage, { nowFn: () => 10_000 }), storage };
  }

  function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
    return app(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("names the canonical and legacy sources", () => {
    expect(HUMAN_REPLY_SOURCE).toBe("chat-reply");
    expect(LEGACY_HUMAN_REPLY_SOURCE).toBe("telegram-reply");
    expect(DEFAULT_PULL_SOURCES).toEqual(["chat-reply"]);
    expect([...ALLOWED_PULL_SOURCES]).toEqual(["chat-reply", "swarm", "swarm-remote"]);
  });

  it("accepts the new name in pull_sources", async () => {
    const { app, storage: s } = newApp();
    const res = await post(app, "/session-start", {
      session_id: "ses_pull",
      backend_kind: PULL_BACKEND_KIND,
      pull_sources: ["chat-reply", "swarm"],
    });
    expect(res.status).toBe(200);
    expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["chat-reply", "swarm"]);
  });

  it("still accepts the legacy name in pull_sources, stored as the new one", async () => {
    // lanes registers with ["telegram-reply", ...] until every daemon has this
    // change; refusing it would be a 400 and an unregistered lane.
    const { app, storage: s } = newApp();
    const res = await post(app, "/session-start", {
      session_id: "ses_pull",
      backend_kind: PULL_BACKEND_KIND,
      pull_sources: ["telegram-reply", "swarm", "chat-reply"],
    });
    expect(res.status).toBe(200);
    expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["chat-reply", "swarm"]);
    const raw = s.db
      .prepare("SELECT pull_sources FROM sessions WHERE session_id = 'ses_pull'")
      .get() as { pull_sources: string };
    expect(JSON.parse(raw.pull_sources)).toEqual(["chat-reply", "swarm"]);
  });

  it("names only the new value in the refusal", async () => {
    const { app } = newApp();
    const res = await post(app, "/session-start", {
      session_id: "ses_pull",
      backend_kind: PULL_BACKEND_KIND,
      pull_sources: ["webhook"],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "pull_sources must be an array of: chat-reply, swarm, swarm-remote",
    );
  });

  it("reads a stored legacy pull_sources value as the new name", () => {
    const { storage: s } = newApp();
    s.sessions.setPullSources("ses_pull", ["telegram-reply", "swarm"]);
    expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["chat-reply", "swarm"]);
    s.sessions.setPullSources("ses_pull", ["telegram-reply", "chat-reply"]);
    expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["chat-reply"]);
  });

  it("defaults a fresh session to the new name", () => {
    const { storage: s } = newApp();
    expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["chat-reply"]);
  });

  it("banks a human reply under the new name", async () => {
    const { storage: s } = newApp();
    const adapter = new GoosePullAdapter({
      storage: s,
      allowedSenderIds: new Set(["1001"]),
      nowFn: () => 2_000,
    });
    const result = await adapter.deliverCommand(s.sessions.get("ses_pull")!, "hold it", {
      commandId: "cmd-1",
      chatId: "slack:T1",
      senderId: "1001",
    });
    expect(result.ok).toBe(true);
    const row = s.db.prepare("SELECT source FROM pull_inbox WHERE msg_id = 'pull:cmd-1'").get() as {
      source: string;
    };
    expect(row.source).toBe("chat-reply");
  });

  it("rewrites banked legacy rows to the new name at schema init, and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      initPullInboxSchema(db);
      const ins = db.prepare(
        `INSERT INTO pull_inbox (msg_id, session_id, source, payload, created_at, expires_at)
         VALUES (?, 's', ?, 'p', 1, 999999999)`,
      );
      ins.run("old", "telegram-reply");
      ins.run("peer", "swarm");
      initPullInboxSchema(db);
      initPullInboxSchema(db);
      const rows = db.prepare("SELECT msg_id, source FROM pull_inbox ORDER BY msg_id").all();
      expect(rows).toEqual([
        { msg_id: "old", source: "chat-reply" },
        { msg_id: "peer", source: "swarm" },
      ]);
    } finally {
      db.close();
    }
  });

  it("drains human replies first and reports them under the new by_source key", async () => {
    const { app, storage: s } = newApp();
    s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
    s.pullInbox.bank({ msgId: "w1", sessionId: "ses_pull", source: "swarm", payload: "peer" }, 2_000);
    s.pullInbox.bank({ msgId: "h1", sessionId: "ses_pull", source: "chat-reply", payload: "human" }, 3_000);

    const pending = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
    const pbody = (await pending.json()) as { by_source: Record<string, number> };
    expect(pbody.by_source).toEqual({ "chat-reply": 1, swarm: 1 });

    const res = await post(app, "/pull/drain", { session_id: "ses_pull", limit: 1 });
    const body = (await res.json()) as { messages: Array<{ msg_id: string; source: string }> };
    expect(body.messages).toEqual([expect.objectContaining({ msg_id: "h1", source: "chat-reply" })]);
  });

  it("reports by_source with the new key for an unknown session too", async () => {
    const { app } = newApp();
    const res = await app(new Request("http://localhost/pull/pending?session=ses_nope"));
    const body = (await res.json()) as { by_source: Record<string, number> };
    expect(body.by_source).toEqual({ "chat-reply": 0, swarm: 0 });
  });

  describe("opencode-direct execute envelope", () => {
    const base = {
      type: OpencodeDirectMessageType.Execute,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-1",
      commandId: "cmd-1",
      sessionId: "sess-1",
      command: "echo hi",
      issuedAt: 1,
    };

    it("accepts the new and the legacy source names", () => {
      // The plugin validates with this function and loads only at a serve
      // restart, so it must accept the new names before any daemon sends them.
      for (const source of ["chat-reply", "chat-callback", "telegram-reply", "telegram-callback", "manual"]) {
        expect(isExecuteCommandEnvelope({ ...base, source })).toBe(true);
      }
      expect(isExecuteCommandEnvelope({ ...base, source: "slack-reply" })).toBe(false);
    });

    it("SENDS the neutral names (pigeon-4ogz.33) and still accepts the legacy ones", () => {
      expect(OpencodeDirectSource.ChatReply).toBe("chat-reply");
      expect(OpencodeDirectSource.ChatCallback).toBe("chat-callback");
      // A daemon older than pigeon-4ogz.33 still sends these to this plugin.
      expect(ACCEPTED_SOURCES.has("telegram-reply")).toBe(true);
      expect(ACCEPTED_SOURCES.has("telegram-callback")).toBe(true);
    });
  });
});

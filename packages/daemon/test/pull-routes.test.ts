import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { PULL_BACKEND_KIND } from "../src/adapters/goose-pull";

/**
 * The pull routes: `/pull/drain`, `/pull/ack`, `/pull/pending`.
 *
 * These are the client-facing half of the pull backend. The recurring theme in the
 * assertions is REFUSAL: a drain or an ack that quietly returns success for a
 * session that is not set up correctly would leave the client reporting healthy
 * zeroes forever while the human's messages went nowhere.
 */
describe("pull routes", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 10_000) {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId: "ses_pull", notify: true, backendKind: PULL_BACKEND_KIND, label: "worker" },
      1_000,
    );
    return { app: createApp(storage, { nowFn: () => now }), storage };
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

  function bank(s: StorageDb, msgId: string, now = 2_000, sessionId = "ses_pull") {
    s.pullInbox.bank(
      { msgId, sessionId, source: "telegram-reply", payload: `text ${msgId}` },
      now,
    );
  }

  describe("POST /question-asked for a pull session", () => {
    it("is refused before anything is stored, so no pending question captures replies", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/question-asked", {
        session_id: "ses_pull",
        request_id: "req-1",
        questions: [{ question: "Rebase?", header: "h", options: [{ label: "yes", description: "" }] }],
      });
      expect(res.status).toBe(409);
      expect(s.pendingQuestions.getBySessionId("ses_pull", Date.now())).toBeNull();
    });
  });

  describe("POST /pull/drain", () => {
    it("claims banked messages and returns them oldest first", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      bank(s, "m2", 2_100);

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        pending_total: number;
        messages: Array<{ msg_id: string; payload: string; redelivered: boolean }>;
      };
      expect(body.ok).toBe(true);
      expect(body.messages.map((m) => m.msg_id)).toEqual(["m1", "m2"]);
      expect(body.messages[0]!.payload).toBe("text m1");
      expect(body.messages[0]!.redelivered).toBe(false);
      expect(body.pending_total).toBe(2);
    });

    // THE POSITIVE CONTROL. "Nothing banked" and "the bank is unreachable" must
    // not look the same from the client, or a broken inbound path reads as a
    // quiet week.
    it("returns 200 with an empty list when there is nothing, not an error", async () => {
      const { app } = newApp();
      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; messages: unknown[]; pending_total: number };
      expect(body.ok).toBe(true);
      expect(body.messages).toEqual([]);
      expect(body.pending_total).toBe(0);
    });

    it("404s for a session that was never registered", async () => {
      const { app } = newApp();
      const res = await post(app, "/pull/drain", { session_id: "ses_ghost" });
      expect(res.status).toBe(404);
    });

    // THE REGISTRATION-DRIFT GUARD. /session-start rewrites the session row
    // wholesale, so a wrapper that stops sending backend_kind silently turns off
    // banking -- the adapter is no longer selected, replies go back to being
    // dropped, and a drain would report a truthful, healthy zero forever. This
    // makes that state loud at the only moment the client is listening.
    it("409s when the session is registered with a different backend kind", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert({ sessionId: "ses_pull", notify: true, backendKind: null }, 3_000);
      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(PULL_BACKEND_KIND);
    });

    it("400s without a session_id", async () => {
      const { app } = newApp();
      expect((await post(app, "/pull/drain", {})).status).toBe(400);
    });

    it("honours a limit and says how much is still waiting", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      bank(s, "m2", 2_100);
      bank(s, "m3", 2_200);
      const res = await post(app, "/pull/drain", { session_id: "ses_pull", limit: 2 });
      const body = (await res.json()) as { messages: unknown[]; pending_total: number };
      expect(body.messages).toHaveLength(2);
      expect(body.pending_total).toBe(3);
    });

    it("rejects a non-positive limit rather than silently choosing one", async () => {
      const { app } = newApp();
      expect((await post(app, "/pull/drain", { session_id: "ses_pull", limit: 0 })).status).toBe(400);
    });

    it("marks a re-served claim as a redelivery", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_pull" });
      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      const body = (await res.json()) as { messages: Array<{ redelivered: boolean }> };
      expect(body.messages[0]!.redelivered).toBe(true);
    });

    it("returns the sender id, replied-to bot text, and quote, never a question id", async () => {
      const { app, storage: s } = newApp();
      s.pullInbox.bank(
        {
          msgId: "a1",
          sessionId: "ses_pull",
          source: "telegram-reply",
          payload: "wait",
          senderId: "1001",
          inReplyTo: "Rebase or wait?",
          inReplyToQuote: "wait?",
        },
        2_000,
      );
      bank(s, "a2", 2_100);
      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      const body = (await res.json()) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages[0]!.sender_id).toBe("1001");
      expect(body.messages[0]!.in_reply_to).toBe("Rebase or wait?");
      expect(body.messages[0]!.in_reply_to_quote).toBe("wait?");
      expect(body.messages[0]).not.toHaveProperty("question_request_id");

      expect(body.messages[1]!.in_reply_to_quote).toBeNull();
    });

    it("returns kind and reply_to (null for telegram rows, values for swarm rows)", async () => {
      const { app, storage: s } = newApp();
      bank(s, "tg1", 2_000);
      s.pullInbox.bank(
        {
          msgId: "sw1",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "swarm text",
          senderId: "ses_peer",
          kind: "chat",
          replyTo: "orig_1",
        },
        2_100,
      );

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          msg_id: string;
          source: string;
          kind: string | null;
          reply_to: string | null;
        }>;
      };

      const tgMsg = body.messages.find((m) => m.msg_id === "tg1")!;
      expect(tgMsg.source).toBe("telegram-reply");
      expect(tgMsg.kind).toBeNull();
      expect(tgMsg.reply_to).toBeNull();

      const swMsg = body.messages.find((m) => m.msg_id === "sw1")!;
      expect(swMsg.source).toBe("swarm");
      expect(swMsg.kind).toBe("chat");
      expect(swMsg.reply_to).toBe("orig_1");
    });

    it("claims telegram-reply rows before swarm rows under limit", async () => {
      const { app, storage: s } = newApp();
      // swarm arrived earlier
      s.pullInbox.bank(
        { msgId: "sw1", sessionId: "ses_pull", source: "swarm", payload: "swarm early" },
        1_000,
      );
      // telegram reply arrived later
      bank(s, "tg1", 2_000);

      const res = await post(app, "/pull/drain", { session_id: "ses_pull", limit: 1 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ msg_id: string }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.msg_id).toBe("tg1");
    });
  });

  describe("POST /pull/ack", () => {
    it("acks claimed rows and stops serving them", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_pull" });
      const res = await post(app, "/pull/ack", { session_id: "ses_pull", msg_ids: ["m1"] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, acked: ["m1"], rejected: [] });
      expect(s.pullInbox.pendingCount("ses_pull", 10_000)).toBe(0);
    });

    // A partial ack must be VISIBLE. "I acked 5 of 5" and "I acked 3 and two
    // vanished" are different facts about whether the human was heard, and a
    // bare 200 collapses them.
    it("names rejected ids rather than reporting a blanket success", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_pull" });
      const res = await post(app, "/pull/ack", {
        session_id: "ses_pull",
        msg_ids: ["m1", "never-existed"],
      });
      expect(await res.json()).toEqual({ ok: true, acked: ["m1"], rejected: ["never-existed"] });
    });

    // The guard swarm's markVerified does NOT have (swarm-repo.ts:296, keyed on
    // msg_id alone). Exposed over HTTP on a box where every process shares one
    // bearer token, an unscoped ack is a forgery primitive against other
    // sessions' mail.
    it("cannot ack another session's message", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert(
        { sessionId: "ses_other", notify: true, backendKind: PULL_BACKEND_KIND },
        1_000,
      );
      bank(s, "theirs", 2_000, "ses_other");
      await post(app, "/pull/drain", { session_id: "ses_other" });
      const res = await post(app, "/pull/ack", { session_id: "ses_pull", msg_ids: ["theirs"] });
      expect(await res.json()).toEqual({ ok: true, acked: [], rejected: ["theirs"] });
      expect(s.pullInbox.pendingCount("ses_other", 10_000)).toBe(1);
    });

    it("400s on a missing or malformed msg_ids", async () => {
      const { app } = newApp();
      expect((await post(app, "/pull/ack", { session_id: "ses_pull" })).status).toBe(400);
      expect(
        (await post(app, "/pull/ack", { session_id: "ses_pull", msg_ids: "m1" })).status,
      ).toBe(400);
    });
  });

  describe("GET /pull/pending", () => {
    it("reports the unread count and by_source breakdown for a registered pull session", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      const res = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_pull",
        session_known: true,
        backend_kind: PULL_BACKEND_KIND,
        pending: 1,
        by_source: {
          "telegram-reply": 1,
          swarm: 0,
        },
      });
    });

    it("reports by_source breakdown with both telegram-reply and swarm keys", async () => {
      const { app, storage: s } = newApp();
      bank(s, "tg1", 2_000);
      s.pullInbox.bank(
        { msgId: "sw1", sessionId: "ses_pull", source: "swarm", payload: "sw" },
        2_100,
      );

      const res = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pending: number; by_source: Record<string, number> };
      expect(body.pending).toBe(2);
      expect(body.by_source).toEqual({
        "telegram-reply": 1,
        swarm: 1,
      });
    });

    // Deliberately 200-with-a-flag rather than 404: this is the cheap poll a
    // wake gate would run, and a caller that treats "unknown session" as an
    // error would wake on the daemon's opinion of registration rather than on
    // there being mail.
    it("reports an unknown session as known=false with a zero count and zero by_source", async () => {
      const { app } = newApp();
      const res = await app(new Request("http://localhost/pull/pending?session=ses_ghost"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        session_known: false,
        pending: 0,
        by_source: {
          "telegram-reply": 0,
          swarm: 0,
        },
      });
    });

    it("400s without a session", async () => {
      const { app } = newApp();
      expect((await app(new Request("http://localhost/pull/pending"))).status).toBe(400);
    });
  });

  describe("POST /session-start pull_sources", () => {
    it("stores pull_sources when supplied", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["telegram-reply", "swarm"],
      });
      expect(res.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual(["telegram-reply", "swarm"]);
    });

    it("deduplicates pull_sources", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["swarm", "swarm", "telegram-reply"],
      });
      expect(res.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual(["swarm", "telegram-reply"]);
    });

    it("accepts empty array []", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: [],
      });
      expect(res.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual([]);
    });

    it("resets pull_sources to default (column NULL) when re-registration omits the field", async () => {
      const { app, storage: s } = newApp();
      // First register with pull_sources: ["swarm"]
      const res1 = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["swarm"],
      });
      expect(res1.status).toBe(200);
      expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["swarm"]);

      // Re-register without pull_sources
      const res2 = await post(app, "/session-start", {
        session_id: "ses_pull",
      });
      expect(res2.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual(["telegram-reply"]);

      // Verify column in DB is reset to NULL
      const rawRow = s.db.prepare("SELECT pull_sources FROM sessions WHERE session_id = ?").get("ses_pull") as { pull_sources: string | null };
      expect(rawRow.pull_sources).toBeNull();
    });

    it("validates BEFORE any write and returns 400 for invalid pull_sources", async () => {
      const { app, storage: s } = newApp();

      // Non-array values
      for (const invalid of ["swarm", 123, null, {}]) {
        const res = await post(app, "/session-start", {
          session_id: "ses_new_invalid",
          pull_sources: invalid,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("pull_sources must be an array of: telegram-reply, swarm");
        expect(s.sessions.get("ses_new_invalid")).toBeNull();
      }

      // Non-string elements
      for (const invalid of [[123], [null], ["swarm", 42]]) {
        const res = await post(app, "/session-start", {
          session_id: "ses_new_invalid2",
          pull_sources: invalid,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("pull_sources must be an array of: telegram-reply, swarm");
        expect(s.sessions.get("ses_new_invalid2")).toBeNull();
      }

      // Unknown values
      for (const invalid of [["unknown"], ["telegram-reply", "webhook"]]) {
        const res = await post(app, "/session-start", {
          session_id: "ses_new_invalid3",
          pull_sources: invalid,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("pull_sources must be an array of: telegram-reply, swarm");
        expect(s.sessions.get("ses_new_invalid3")).toBeNull();
      }

      // Verify that for an existing session, invalid input does not modify the session row
      await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["swarm"],
      });
      expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["swarm"]);

      const badRes = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["invalid"],
      });
      expect(badRes.status).toBe(400);
      expect(s.sessions.get("ses_pull")!.pullSources).toEqual(["swarm"]);
    });
  });

  describe("auth", () => {
    it("requires the bearer token like every other non-anonymous route", async () => {
      storage = openStorageDb(":memory:");
      const app = createApp(storage, { nowFn: () => 10_000, authToken: "secret" });
      const res = await app(
        new Request("http://localhost/pull/drain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "ses_pull" }),
        }),
      );
      expect(res.status).toBe(401);
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { PULL_BACKEND_KIND } from "../src/adapters/goose-pull";

/**
 * The pull routes: `/pull/drain`, `/pull/ack`, `/pull/pending`.
 *
 * These are the client-facing half of SDD §13. The recurring theme in the
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
      { sessionId: "ses_lane", notify: true, backendKind: PULL_BACKEND_KIND, label: "maven-renovate" },
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

  function bank(s: StorageDb, msgId: string, now = 2_000, sessionId = "ses_lane") {
    s.pullInbox.bank(
      { msgId, sessionId, source: "telegram-reply", payload: `text ${msgId}` },
      now,
    );
  }

  describe("POST /pull/drain", () => {
    it("claims banked messages and returns them oldest first", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      bank(s, "m2", 2_100);

      const res = await post(app, "/pull/drain", { session_id: "ses_lane" });
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
      const res = await post(app, "/pull/drain", { session_id: "ses_lane" });
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
      s.sessions.upsert({ sessionId: "ses_lane", notify: true, backendKind: null }, 3_000);
      const res = await post(app, "/pull/drain", { session_id: "ses_lane" });
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
      const res = await post(app, "/pull/drain", { session_id: "ses_lane", limit: 2 });
      const body = (await res.json()) as { messages: unknown[]; pending_total: number };
      expect(body.messages).toHaveLength(2);
      expect(body.pending_total).toBe(3);
    });

    it("rejects a non-positive limit rather than silently choosing one", async () => {
      const { app } = newApp();
      expect((await post(app, "/pull/drain", { session_id: "ses_lane", limit: 0 })).status).toBe(400);
    });

    it("marks a re-served claim as a redelivery", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_lane" });
      const res = await post(app, "/pull/drain", { session_id: "ses_lane" });
      const body = (await res.json()) as { messages: Array<{ redelivered: boolean }> };
      expect(body.messages[0]!.redelivered).toBe(true);
    });

    it("carries the question request id so an answer can be validated", async () => {
      const { app, storage: s } = newApp();
      s.pullInbox.bank(
        {
          msgId: "a1",
          sessionId: "ses_lane",
          source: "question-answer",
          payload: "wait",
          questionRequestId: "req-7",
          answerKind: "option",
        },
        2_000,
      );
      const res = await post(app, "/pull/drain", { session_id: "ses_lane" });
      const body = (await res.json()) as {
        messages: Array<{ source: string; question_request_id: string | null; answer_kind: string | null }>;
      };
      expect(body.messages[0]!.source).toBe("question-answer");
      expect(body.messages[0]!.question_request_id).toBe("req-7");
      // Carried through so the client can tell a button press from text that a
      // pending question merely captured. Measured hazard, not a hypothetical.
      expect(body.messages[0]!.answer_kind).toBe("option");
    });
  });

  describe("POST /pull/ack", () => {
    it("acks claimed rows and stops serving them", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_lane" });
      const res = await post(app, "/pull/ack", { session_id: "ses_lane", msg_ids: ["m1"] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, acked: ["m1"], rejected: [] });
      expect(s.pullInbox.pendingCount("ses_lane", 10_000)).toBe(0);
    });

    // A partial ack must be VISIBLE. "I acked 5 of 5" and "I acked 3 and two
    // vanished" are different facts about whether the human was heard, and a
    // bare 200 collapses them.
    it("names rejected ids rather than reporting a blanket success", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      await post(app, "/pull/drain", { session_id: "ses_lane" });
      const res = await post(app, "/pull/ack", {
        session_id: "ses_lane",
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
      const res = await post(app, "/pull/ack", { session_id: "ses_lane", msg_ids: ["theirs"] });
      expect(await res.json()).toEqual({ ok: true, acked: [], rejected: ["theirs"] });
      expect(s.pullInbox.pendingCount("ses_other", 10_000)).toBe(1);
    });

    it("400s on a missing or malformed msg_ids", async () => {
      const { app } = newApp();
      expect((await post(app, "/pull/ack", { session_id: "ses_lane" })).status).toBe(400);
      expect(
        (await post(app, "/pull/ack", { session_id: "ses_lane", msg_ids: "m1" })).status,
      ).toBe(400);
    });
  });

  describe("GET /pull/pending", () => {
    it("reports the unread count for a registered pull session", async () => {
      const { app, storage: s } = newApp();
      bank(s, "m1", 2_000);
      const res = await app(new Request("http://localhost/pull/pending?session=ses_lane"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_lane",
        session_known: true,
        backend_kind: PULL_BACKEND_KIND,
        pending: 1,
      });
    });

    // Deliberately 200-with-a-flag rather than 404: this is the cheap poll a
    // wake gate would run, and a caller that treats "unknown session" as an
    // error would wake on the daemon's opinion of registration rather than on
    // there being mail.
    it("reports an unknown session as known=false with a zero count", async () => {
      const { app } = newApp();
      const res = await app(new Request("http://localhost/pull/pending?session=ses_ghost"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ session_known: false, pending: 0 });
    });

    it("400s without a session", async () => {
      const { app } = newApp();
      expect((await app(new Request("http://localhost/pull/pending"))).status).toBe(400);
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
          body: JSON.stringify({ session_id: "ses_lane" }),
        }),
      );
      expect(res.status).toBe(401);
    });
  });
});

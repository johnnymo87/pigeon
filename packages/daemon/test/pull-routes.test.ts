import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { PULL_BACKEND_KIND } from "../src/adapters/goose-pull";
import { processRelayItems } from "../src/swarm/relay-receiver";

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
      { msgId, sessionId, source: "chat-reply", payload: `text ${msgId}` },
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
          source: "chat-reply",
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

    it("returns kind and reply_to (null for chat rows, values for swarm rows)", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
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

      const chatMsg = body.messages.find((m) => m.msg_id === "tg1")!;
      expect(chatMsg.source).toBe("chat-reply");
      expect(chatMsg.kind).toBeNull();
      expect(chatMsg.reply_to).toBeNull();

      const swMsg = body.messages.find((m) => m.msg_id === "sw1")!;
      expect(swMsg.source).toBe("swarm");
      expect(swMsg.kind).toBe("chat");
      expect(swMsg.reply_to).toBe("orig_1");
    });

    it("returns from_machine for relayed messages, null for local messages", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);

      // Local chat row (no relay_inbound record)
      bank(s, "m_local", 2_000);

      // Local swarm row (no relay_inbound record)
      s.pullInbox.bank(
        {
          msgId: "m_sw_local",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "local swarm",
          senderId: "ses_local_peer",
        },
        2_050,
      );

      // Relayed swarm row matching sender and to_session
      s.pullInbox.bank(
        {
          msgId: "m_relayed",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "relayed swarm",
          senderId: "ses_remote_sender",
        },
        2_100,
      );
      s.relayInbound.record(
        {
          msgId: "m_relayed",
          fromMachine: "devbox",
          fromSession: "ses_remote_sender",
          toSession: "ses_pull",
          fromLabel: null,
        },
        2_100,
      );

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          msg_id: string;
          from_machine: string | null;
        }>;
      };

      const localChat = body.messages.find((m) => m.msg_id === "m_local")!;
      expect(localChat).toHaveProperty("from_machine", null);

      const localSwarm = body.messages.find((m) => m.msg_id === "m_sw_local")!;
      expect(localSwarm).toHaveProperty("from_machine", null);

      const relayed = body.messages.find((m) => m.msg_id === "m_relayed")!;
      expect(relayed).toHaveProperty("from_machine", "devbox");
    });

    it("returns from_machine as null when relay_inbound sender or recipient mismatches", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);

      // Mismatched senderId vs relay_inbound fromSession
      s.pullInbox.bank(
        {
          msgId: "m_mismatched_sender",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "spoofed sender",
          senderId: "ses_spoofed",
        },
        2_100,
      );
      s.relayInbound.record(
        {
          msgId: "m_mismatched_sender",
          fromMachine: "devbox",
          fromSession: "ses_actual_sender",
          toSession: "ses_pull",
          fromLabel: null,
        },
        2_100,
      );

      // Mismatched sessionId vs relay_inbound toSession
      s.pullInbox.bank(
        {
          msgId: "m_mismatched_recipient",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "mismatched recipient",
          senderId: "ses_sender",
        },
        2_200,
      );
      s.relayInbound.record(
        {
          msgId: "m_mismatched_recipient",
          fromMachine: "devbox",
          fromSession: "ses_sender",
          toSession: "ses_other",
          fromLabel: null,
        },
        2_200,
      );

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          msg_id: string;
          from_machine: string | null;
        }>;
      };

      const mismatchedSender = body.messages.find((m) => m.msg_id === "m_mismatched_sender")!;
      expect(mismatchedSender).toHaveProperty("from_machine", null);

      const mismatchedRecipient = body.messages.find((m) => m.msg_id === "m_mismatched_recipient")!;
      expect(mismatchedRecipient).toHaveProperty("from_machine", null);
    });

    it("returns from_machine as null when a later local row reuses an old relayed msg_id", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);

      // A relay_inbound record from an earlier relayed message at t=2_000
      s.relayInbound.record(
        {
          msgId: "m_reused",
          fromMachine: "devbox",
          fromSession: "ses_sender",
          toSession: "ses_pull",
          fromLabel: null,
        },
        2_000,
      );

      // A later local send reuses the msg_id with the same from/to at t=5_000
      s.pullInbox.bank(
        {
          msgId: "m_reused",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "later local send reusing msg_id",
          senderId: "ses_sender",
        },
        5_000,
      );

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          msg_id: string;
          from_machine: string | null;
        }>;
      };

      const reused = body.messages.find((m) => m.msg_id === "m_reused")!;
      expect(reused).toHaveProperty("from_machine", null);
    });

    it("reports from_machine for a message banked via the real relay receiver path", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm", "swarm-remote"]);

      const acks = await processRelayItems(
        {
          storage: s,
          selfMachineId: "cloudbox",
          acceptFrom: ["devbox"],
          nowFn: () => 2_100,
          log: () => {},
        },
        [
          {
            item: "message",
            from_machine: "devbox",
            msg_id: "m_real_relay",
            from: "ses_remote_sender",
            to: "ses_pull",
            kind: "chat",
            priority: "normal",
            reply_to: null,
            payload: "message from devbox via relay receiver",
          },
        ],
      );

      expect(acks).toEqual([
        { from_machine: "devbox", msg_id: "m_real_relay", outcome: "delivered" },
      ]);

      const res = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          msg_id: string;
          from_machine: string | null;
        }>;
      };

      const msg = body.messages.find((m) => m.msg_id === "m_real_relay")!;
      expect(msg).toHaveProperty("from_machine", "devbox");
    });

    it("claims chat-reply rows before swarm rows under limit", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
      // swarm arrived earlier
      s.pullInbox.bank(
        { msgId: "sw1", sessionId: "ses_pull", source: "swarm", payload: "swarm early" },
        1_000,
      );
      // chat reply arrived later
      bank(s, "tg1", 2_000);

      const res = await post(app, "/pull/drain", { session_id: "ses_pull", limit: 1 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ msg_id: string }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.msg_id).toBe("tg1");
    });

    it("holds swarm rows when session is not opted into swarm, and serves them on re-opt-in", async () => {
      const { app, storage: s } = newApp();
      // ses_pull has default pullSources: ["chat-reply"] (opted out of swarm)
      bank(s, "tg1", 2_000);
      s.pullInbox.bank(
        { msgId: "sw1", sessionId: "ses_pull", source: "swarm", payload: "held swarm message" },
        2_100,
      );

      // Drain returns only tg1; pending_total excludes held swarm row
      const drain1 = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(drain1.status).toBe(200);
      const drain1Body = (await drain1.json()) as { pending_total: number; messages: Array<{ msg_id: string }> };
      expect(drain1Body.pending_total).toBe(1);
      expect(drain1Body.messages.map((m) => m.msg_id)).toEqual(["tg1"]);

      // Pending route also excludes held swarm row from total and by_source
      const pending1 = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      const pending1Body = (await pending1.json()) as { pending: number; by_source: Record<string, number> };
      expect(pending1Body.pending).toBe(1); // tg1 is claimed but unacked
      expect(pending1Body.by_source).toEqual({
        "chat-reply": 1,
        swarm: 0,
      });

      // Ack tg1
      const ack1 = await post(app, "/pull/ack", { session_id: "ses_pull", msg_ids: ["tg1"] });
      expect(ack1.status).toBe(200);

      // Drain again while still opted out: returns nothing
      const drain2 = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(drain2.status).toBe(200);
      const drain2Body = (await drain2.json()) as { pending_total: number; messages: Array<{ msg_id: string }> };
      expect(drain2Body.pending_total).toBe(0);
      expect(drain2Body.messages).toEqual([]);

      // Pending route reports 0 while opted out (wake gate doesn't spin)
      const pending2 = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      const pending2Body = (await pending2.json()) as { pending: number; by_source: Record<string, number> };
      expect(pending2Body.pending).toBe(0);
      expect(pending2Body.by_source).toEqual({
        "chat-reply": 0,
        swarm: 0,
      });

      // Now session re-opts into swarm via session-start
      const reopt = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["chat-reply", "swarm"],
      });
      expect(reopt.status).toBe(200);

      // Pending route now sees the held swarm row
      const pending3 = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      const pending3Body = (await pending3.json()) as { pending: number; by_source: Record<string, number> };
      expect(pending3Body.pending).toBe(1);
      expect(pending3Body.by_source).toEqual({
        "chat-reply": 0,
        swarm: 1,
      });

      // Drain now serves the held swarm row
      const drain3 = await post(app, "/pull/drain", { session_id: "ses_pull" });
      expect(drain3.status).toBe(200);
      const drain3Body = (await drain3.json()) as { pending_total: number; messages: Array<{ msg_id: string }> };
      expect(drain3Body.pending_total).toBe(1);
      expect(drain3Body.messages.map((m) => m.msg_id)).toEqual(["sw1"]);

      // Session opts out again BEFORE acking sw1
      const optout = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["chat-reply"],
      });
      expect(optout.status).toBe(200);

      // Ack for sw1 is UNAFFECTED by the opt-out
      const ack2 = await post(app, "/pull/ack", { session_id: "ses_pull", msg_ids: ["sw1"] });
      expect(ack2.status).toBe(200);
      expect(await ack2.json()).toEqual({ ok: true, acked: ["sw1"], rejected: [] });
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
          "chat-reply": 1,
          swarm: 0,
        },
        swarm_pending: [],
        swarm_pending_truncated: false,
      });
    });

    it("reports by_source breakdown with both chat-reply and swarm keys", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
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
        "chat-reply": 1,
        swarm: 1,
      });
    });

    it("reports swarm_pending with sender ids, metadata, and length equal to by_source.swarm under the limit", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
      s.pullInbox.bank(
        {
          msgId: "sw1",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "payload1",
          senderId: "ses_coord",
          kind: "task.assign",
          replyTo: "prev_1",
        },
        2_100,
      );
      s.pullInbox.bank(
        {
          msgId: "sw2",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "payload2",
          senderId: "ses_worker",
          kind: "result",
          replyTo: null,
        },
        2_200,
      );

      // Claim sw1 at 2500 so claimed_at and claim_count are populated
      s.pullInbox.claim("ses_pull", 2_500, 1);

      const res = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pending: number;
        by_source: Record<string, number>;
        swarm_pending: Array<{
          msg_id: string;
          sender_id: string | null;
          kind: string | null;
          reply_to: string | null;
          created_at: number;
          claimed_at: number | null;
          claim_count: number;
        }>;
        swarm_pending_truncated: boolean;
      };

      expect(body.by_source.swarm).toBe(2);
      expect(body.swarm_pending).toHaveLength(body.by_source.swarm ?? 0);
      expect(body.swarm_pending_truncated).toBe(false);
      expect(body.swarm_pending).toEqual([
        {
          msg_id: "sw2",
          sender_id: "ses_worker",
          kind: "result",
          reply_to: null,
          created_at: 2_200,
          claimed_at: null,
          claim_count: 0,
        },
        {
          msg_id: "sw1",
          sender_id: "ses_coord",
          kind: "task.assign",
          reply_to: "prev_1",
          created_at: 2_100,
          claimed_at: 2_500,
          claim_count: 1,
        },
      ]);
    });

    it("returns empty swarm_pending when swarm is held (session not opted in)", async () => {
      const { app, storage: s } = newApp();
      // ses_pull has default pull_sources ["chat-reply"] (not opted in to swarm)
      s.pullInbox.bank(
        {
          msgId: "sw_held",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "sw",
          senderId: "ses_coord",
        },
        2_100,
      );

      const res = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        by_source: Record<string, number>;
        swarm_pending: unknown[];
        swarm_pending_truncated: boolean;
      };
      expect(body.by_source.swarm).toBe(0);
      expect(body.swarm_pending).toEqual([]);
      expect(body.swarm_pending_truncated).toBe(false);
    });

    it("returns empty swarm_pending and truncated=false for unknown session", async () => {
      const { app } = newApp();
      const res = await app(new Request("http://localhost/pull/pending?session=ses_ghost"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session_known: boolean;
        pending: number;
        by_source: Record<string, number>;
        swarm_pending: unknown[];
        swarm_pending_truncated: boolean;
      };
      expect(body.session_known).toBe(false);
      expect(body.pending).toBe(0);
      expect(body.by_source).toEqual({
        "chat-reply": 0,
        swarm: 0,
      });
      expect(body.swarm_pending).toEqual([]);
      expect(body.swarm_pending_truncated).toBe(false);
    });

    it("sets swarm_pending_truncated to true and caps swarm_pending at 50 when more than 50 swarm messages are pending", async () => {
      const { app, storage: s } = newApp();
      s.sessions.setPullSources("ses_pull", ["chat-reply", "swarm"]);
      for (let i = 1; i <= 55; i++) {
        s.pullInbox.bank(
          {
            msgId: `sw_${String(i).padStart(3, "0")}`,
            sessionId: "ses_pull",
            source: "swarm",
            payload: `p_${i}`,
            senderId: `ses_sender_${i}`,
          },
          1_000 + i,
        );
      }

      const res = await app(new Request("http://localhost/pull/pending?session=ses_pull"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pending: number;
        by_source: Record<string, number>;
        swarm_pending: unknown[];
        swarm_pending_truncated: boolean;
      };
      expect(body.by_source.swarm).toBe(55);
      expect(body.swarm_pending).toHaveLength(50);
      expect(body.swarm_pending_truncated).toBe(true);
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
          "chat-reply": 0,
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
        pull_sources: ["chat-reply", "swarm"],
      });
      expect(res.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual(["chat-reply", "swarm"]);
    });

    it("deduplicates pull_sources", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        pull_sources: ["swarm", "swarm", "chat-reply"],
      });
      expect(res.status).toBe(200);
      const session = s.sessions.get("ses_pull");
      expect(session).not.toBeNull();
      expect(session!.pullSources).toEqual(["swarm", "chat-reply"]);
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
      expect(session!.pullSources).toEqual(["chat-reply"]);

      // Verify column in DB is reset to NULL
      const rawRow = s.db.prepare("SELECT pull_sources FROM sessions WHERE session_id = ?").get("ses_pull") as { pull_sources: string | null };
      expect(rawRow.pull_sources).toBeNull();
    });

    it("treats pull_sources: null as absent (resets to default), not 400", async () => {
      const { app, storage: s } = newApp();
      // Fresh session with pull_sources: null
      const res1 = await post(app, "/session-start", {
        session_id: "ses_null_fresh",
        pull_sources: null,
      });
      expect(res1.status).toBe(200);
      expect(s.sessions.get("ses_null_fresh")!.pullSources).toEqual(["chat-reply"]);
      const raw1 = s.db.prepare("SELECT pull_sources FROM sessions WHERE session_id = ?").get("ses_null_fresh") as { pull_sources: string | null };
      expect(raw1.pull_sources).toBeNull();

      // Existing session with pull_sources: ["swarm"] reset via pull_sources: null
      await post(app, "/session-start", {
        session_id: "ses_null_reset",
        pull_sources: ["swarm"],
      });
      expect(s.sessions.get("ses_null_reset")!.pullSources).toEqual(["swarm"]);

      const res2 = await post(app, "/session-start", {
        session_id: "ses_null_reset",
        pull_sources: null,
      });
      expect(res2.status).toBe(200);
      expect(s.sessions.get("ses_null_reset")!.pullSources).toEqual(["chat-reply"]);
      const raw2 = s.db.prepare("SELECT pull_sources FROM sessions WHERE session_id = ?").get("ses_null_reset") as { pull_sources: string | null };
      expect(raw2.pull_sources).toBeNull();
    });

    it("validates BEFORE any write and returns 400 for invalid pull_sources", async () => {
      const { app, storage: s } = newApp();

      // Non-array values
      for (const invalid of ["swarm", 123, {}]) {
        const res = await post(app, "/session-start", {
          session_id: "ses_new_invalid",
          pull_sources: invalid,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("pull_sources must be an array of: chat-reply, swarm, swarm-remote");
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
        expect(body.error).toBe("pull_sources must be an array of: chat-reply, swarm, swarm-remote");
        expect(s.sessions.get("ses_new_invalid2")).toBeNull();
      }

      // Unknown values
      for (const invalid of [["unknown"], ["chat-reply", "webhook"]]) {
        const res = await post(app, "/session-start", {
          session_id: "ses_new_invalid3",
          pull_sources: invalid,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("pull_sources must be an array of: chat-reply, swarm, swarm-remote");
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

  describe("POST /session-start notify handling for pull sessions", () => {
    it("persists notify: false and suppresses chat notice on banked swarm message", async () => {
      const { app, storage: s } = newApp();
      const startRes = await post(app, "/session-start", {
        session_id: "ses_pull_quiet",
        backend_kind: PULL_BACKEND_KIND,
        notify: false,
        pull_sources: ["chat-reply", "swarm"],
      });
      expect(startRes.status).toBe(200);
      const session = s.sessions.get("ses_pull_quiet");
      expect(session).not.toBeNull();
      expect(session!.backendKind).toBe(PULL_BACKEND_KIND);
      expect(session!.notify).toBe(false);

      const sendRes = await post(app, "/swarm/send", {
        from: "ses_sender",
        to: "ses_pull_quiet",
        kind: "chat",
        payload: "hello quiet pull session",
      });
      expect(sendRes.status).toBe(202);
      const sendBody = (await sendRes.json()) as { accepted: boolean; banked?: boolean; msg_id: string };
      expect(sendBody.accepted).toBe(true);
      expect(sendBody.banked).toBe(true);

      // Banked in pull_inbox
      expect(s.pullInbox.claim("ses_pull_quiet", 10_000)).toHaveLength(1);

      // No chat notice in outbox
      expect(s.outbox.getByNotificationId(`w:${sendBody.msg_id}`)).toBeNull();
    });

    it("persists notify: true and emits chat notice on banked swarm message", async () => {
      const { app, storage: s } = newApp();
      const startRes = await post(app, "/session-start", {
        session_id: "ses_pull_loud",
        backend_kind: PULL_BACKEND_KIND,
        notify: true,
        pull_sources: ["chat-reply", "swarm"],
      });
      expect(startRes.status).toBe(200);
      const session = s.sessions.get("ses_pull_loud");
      expect(session).not.toBeNull();
      expect(session!.backendKind).toBe(PULL_BACKEND_KIND);
      expect(session!.notify).toBe(true);

      const sendRes = await post(app, "/swarm/send", {
        from: "ses_sender",
        to: "ses_pull_loud",
        kind: "chat",
        payload: "hello loud pull session",
      });
      expect(sendRes.status).toBe(202);
      const sendBody = (await sendRes.json()) as { accepted: boolean; banked?: boolean; msg_id: string };
      expect(sendBody.accepted).toBe(true);
      expect(sendBody.banked).toBe(true);

      // Banked in pull_inbox
      expect(s.pullInbox.claim("ses_pull_loud", 10_000)).toHaveLength(1);

      // Chat notice IS in outbox
      expect(s.outbox.getByNotificationId(`w:${sendBody.msg_id}`)).not.toBeNull();
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

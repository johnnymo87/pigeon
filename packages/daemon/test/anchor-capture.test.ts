import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { createApp } from "../src/app";
import { hashPrompt } from "../src/hash-prompt";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { initSessionEventsSchema } from "../src/storage/session-events-schema";
import { initSchema } from "../src/storage/schema";
import { commitDelivery } from "../src/worker/outbox-sender";
import { excerptOf } from "../src/text";
import { enqueueSwarmTelegramNotice, enqueueSwarmCancelNotice } from "../src/swarm/telegram-notice";
import type { SwarmMessageRecord } from "../src/storage/swarm-repo";

/**
 * Phase 1b of the unread-navigation design: capture the message id a later phase
 * scrolls to, plus a readable excerpt.
 *
 * Plan: workstation docs/plans/2026-08-28-anchor-capture-plan.md
 * Design: workstation docs/plans/2026-08-25-unread-navigation-design.md (rev 2)
 */

function columns(db: BetterSqlite3.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe("phase 1b schema", () => {
  it("adds all five columns", () => {
    const db = new BetterSqlite3(":memory:");
    initSchema(db);
    initSessionEventsSchema(db);
    expect(columns(db, "sessions")).toContain("last_human_msg_id");
    expect(columns(db, "outbox")).toContain("anchor_msg_id");
    expect(columns(db, "outbox")).toContain("excerpt");
    expect(columns(db, "session_events")).toContain("anchor_msg_id");
    expect(columns(db, "session_events")).toContain("excerpt");
    db.close();
  });

  // The duplicate-column path is what breaks daemon startup for every user at
  // once if isDuplicateColumnError stops matching.
  it("is idempotent across a second init on the same handle", () => {
    const db = new BetterSqlite3(":memory:");
    initSchema(db);
    initSessionEventsSchema(db);
    expect(() => {
      initSchema(db);
      initSessionEventsSchema(db);
    }).not.toThrow();
    db.close();
  });

  // The session_events ALTERs must NOT live in the shared additiveColumns array:
  // initSchema runs BEFORE initSessionEventsSchema, so on a fresh DB the table
  // does not exist yet, and "no such table" is NOT matched by
  // isDuplicateColumnError -- it rethrows and crashes startup. A reviewer's
  // "consolidate the arrays" simplification must fail here.
  it("initialises a completely fresh database without throwing", () => {
    expect(() => {
      const db = new BetterSqlite3(":memory:");
      initSchema(db);
      initSessionEventsSchema(db);
      db.close();
    }).not.toThrow();
  });

  it("openStorageDb produces every column on a fresh db", () => {
    const s = openStorageDb(":memory:");
    expect(columns(s.db, "sessions")).toContain("last_human_msg_id");
    expect(columns(s.db, "outbox")).toContain("anchor_msg_id");
    expect(columns(s.db, "session_events")).toContain("anchor_msg_id");
    s.db.close();
  });
});

describe("phase 1b: /mirror records the anchor", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now });
  }

  function mirror(app: ReturnType<typeof createApp>, sessionId: string, messageId: string, text: string) {
    return app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId, text }),
      }),
    );
  }

  function anchorOf(sessionId: string): string | null {
    const row = storage!.db
      .prepare("SELECT last_human_msg_id AS a FROM sessions WHERE session_id = ?")
      .get(sessionId) as { a: string | null } | undefined;
    return row?.a ?? null;
  }

  function addSession(sessionId: string) {
    storage!.sessions.upsert({ sessionId, notify: true }, 1_000);
  }

  it("records the message id of a human-authored turn", async () => {
    const app = newApp();
    addSession("s1");
    await mirror(app, "s1", "msg_01human", "what is the status?");
    expect(anchorOf("s1")).toBe("msg_01human");
  });

  // Must return before the anchor write. An injected prompt is not presence.
  it("records nothing for a daemon-injected turn", async () => {
    const app = newApp();
    addSession("s1");
    const text = "injected by the daemon";
    storage!.injectedPrompts.record("s1", hashPrompt(text));
    await mirror(app, "s1", "msg_01injected", text);
    expect(anchorOf("s1")).toBeNull();
  });

  it("records nothing for an enveloped swarm turn", async () => {
    const app = newApp();
    addSession("s1");
    await mirror(app, "s1", "msg_01swarm", '<swarm_message from="peer">hi</swarm_message>');
    expect(anchorOf("s1")).toBeNull();
  });

  it("records nothing for a whitespace-only turn", async () => {
    const app = newApp();
    addSession("s1");
    await mirror(app, "s1", "msg_01blank", "   \n  ");
    expect(anchorOf("s1")).toBeNull();
  });

  it("advances to a later human turn", async () => {
    const app = newApp();
    addSession("s1");
    await mirror(app, "s1", "msg_01first", "first");
    await mirror(app, "s1", "msg_02second", "second");
    expect(anchorOf("s1")).toBe("msg_02second");
  });

  // Two postMirror calls are independent async HTTP requests, so H1's can land
  // AFTER H2's. A plain UPDATE would regress the anchor by a turn; ids are
  // sortable with an embedded ms timestamp, so MAX() gives newest-wins for free.
  it("keeps the newer anchor when an older turn arrives out of order", async () => {
    const app = newApp();
    addSession("s1");
    await mirror(app, "s1", "msg_02newer", "newer");
    await mirror(app, "s1", "msg_01older", "older");
    expect(anchorOf("s1")).toBe("msg_02newer");
  });

  // /mirror tolerates an unknown session (unlike /stop, which 404s). A 500 here
  // would break mirroring AND phase 1a's clearing, both live features.
  it("does not throw for a session with no row", async () => {
    const app = newApp();
    const res = await mirror(app, "s_unknown", "msg_01x", "hello");
    expect(res.status).toBe(200);
    // Assert the NO-OP, not merely the status: an INSERT-based reimplementation
    // would also return 200 while conjuring a session row from a mirror call.
    const n = storage!.db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?")
      .get("s_unknown") as { c: number };
    expect(n.c).toBe(0);
  });

  // Pins the write's position ABOVE shouldEmitAncillaryFor: badge state and
  // Telegram delivery policy are unrelated concerns.
  it("records for a quiet session that will not mirror to Telegram", async () => {
    const app = newApp();
    addSession("s1");
    storage!.sessionOrigins.record(
      { sessionId: "s1", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    await mirror(app, "s1", "msg_01quiet", "typed into a quiet session");
    expect(anchorOf("s1")).toBe("msg_01quiet");
  });
});

describe("phase 1b: enqueue captures anchor and excerpt", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function outboxRow(notificationId: string) {
    return storage!.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM outbox WHERE notification_id = ?")
      .get(notificationId) as { a: string | null; e: string | null } | undefined;
  }

  it("stores anchor and excerpt on the outbox row", () => {
    storage = openStorageDb(":memory:");
    storage.outbox.upsert(
      {
        notificationId: "n1",
        sessionId: "s1",
        requestId: "r1",
        kind: "stop",
        payload: "{}",
        token: "",
        anchorMsgId: "msg_01anchor",
        excerpt: "plain text",
      },
      1_000,
    );
    expect(outboxRow("n1")).toEqual({ a: "msg_01anchor", e: "plain text" });
  });

  // BLOCKER found in review. The conflict arm deliberately omits `payload`, so a
  // requeued failed row keeps its ORIGINAL content. If the anchor were updated
  // there, a requeue after a human turn would pair a NEWER anchor with the OLDER
  // payload -- the enqueue/delivery hazard re-entering through a side door.
  // Swarm requeue reaches this for real (no getByNotificationId pre-check).
  it("never moves a stored anchor when a failed row is requeued", () => {
    storage = openStorageDb(":memory:");
    const base = { notificationId: "n1", sessionId: "s1", requestId: "r1", kind: "swarm", payload: "P1", token: "" };
    storage.outbox.upsert({ ...base, anchorMsgId: "msg_01old", excerpt: "old" }, 1_000);
    storage.outbox.markFailed("n1", 2_000, "boom");
    storage.outbox.upsert({ ...base, anchorMsgId: "msg_09new", excerpt: "new" }, 3_000);
    // The requeue resets delivery state but must not rewrite content.
    expect(outboxRow("n1")).toEqual({ a: "msg_01old", e: "old" });
  });
});

describe("phase 1b: delivery carries anchor and excerpt into the ledger", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function ledgerRow(notificationId: string) {
    return storage!.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM session_events WHERE notification_id = ?")
      .get(notificationId) as { a: string | null; e: string | null } | undefined;
  }

  // Non-NULL values deliberately: NULL == NULL passes vacuously against a
  // thread-through that drops both fields.
  it("copies non-null anchor and excerpt onto the ledger row", () => {
    storage = openStorageDb(":memory:");
    storage.outbox.upsert(
      { notificationId: "n1", sessionId: "s1", requestId: "r1", kind: "stop", payload: "{}", token: "",
        anchorMsgId: "msg_01anchor", excerpt: "the summary" },
      1_000,
    );
    const entry = storage.outbox.getByNotificationId("n1")!;
    commitDelivery(storage, entry, 2_000, 1, () => {});
    expect(ledgerRow("n1")).toEqual({ a: "msg_01anchor", e: "the summary" });
  });

  /**
   * THE test for this phase.
   *
   * session_events rows are appended at DELIVERY, which is retry-skewed. If the
   * anchor were read from sessions.last_human_msg_id here, a human turn landing
   * between enqueue and delivery would move it PAST the notified content -- and
   * that row still counts unread, because markAllRead is MAX(id) over rows that
   * already exist and cannot cover one not yet appended.
   *
   * Fails against a delivery-time implementation. Passes against enqueue-time.
   */
  it("keeps the enqueue-time anchor when a human turn lands before delivery", () => {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    storage.outbox.upsert(
      { notificationId: "n1", sessionId: "s1", requestId: "r1", kind: "stop", payload: "{}", token: "",
        anchorMsgId: "msg_01H1", excerpt: "started by H1" },
      1_000,
    );
    // The human types H2 while the notification is still queued.
    storage.sessions.setLastHumanMsgId("s1", "msg_09H2", 1_500);
    const entry = storage.outbox.getByNotificationId("n1")!;
    commitDelivery(storage, entry, 2_000, 1, () => {});
    expect(ledgerRow("n1")?.a).toBe("msg_01H1");
  });

  it("delivers a row with no anchor and stores null", () => {
    storage = openStorageDb(":memory:");
    storage.outbox.upsert(
      { notificationId: "n1", sessionId: "s1", requestId: "r1", kind: "stop", payload: "{}", token: "" },
      1_000,
    );
    const entry = storage.outbox.getByNotificationId("n1")!;
    expect(() => commitDelivery(storage!, entry, 2_000, 1, () => {})).not.toThrow();
    expect(ledgerRow("n1")).toEqual({ a: null, e: null });
  });
});

describe("phase 1b: excerptOf", () => {
  it("returns null for empty and whitespace so 'nothing to show' has one representation", () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf(undefined)).toBeNull();
    expect(excerptOf("")).toBeNull();
    expect(excerptOf("   \n ")).toBeNull();
  });

  it("clamps to 150 chars", () => {
    expect(excerptOf("x".repeat(400))!.length).toBe(150);
  });

  // slice(0, 150) alone would split a surrogate pair and store a lone surrogate,
  // which survives JSON.stringify but cannot be encoded as UTF-8.
  // The clamp protects the CUT; this protects the INTERIOR. Every caller's text
  // arrives via JSON.parse, and a \\udXXX escape decodes to a lone surrogate.
  it("strips an interior lone surrogate that no boundary clamp would touch", () => {
    const e = excerptOf("before\ud800after")!;
    expect(e.isWellFormed()).toBe(true);
    expect(e).toContain("before");
    expect(e).toContain("after");
  });

  it("never stores a lone surrogate when an astral char straddles the boundary", () => {
    const e = excerptOf("a".repeat(149) + "\u{1F600}" + "tail")!;
    expect(e.isWellFormed()).toBe(true);
    expect(e.length).toBe(149);
  });
});

describe("phase 1b: routes capture anchor and excerpt", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function outboxRow(notificationId: string) {
    return storage!.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM outbox WHERE notification_id = ?")
      .get(notificationId) as { a: string | null; e: string | null } | undefined;
  }

  async function postStop(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
    return app(
      new Request("http://localhost/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  // THE precedence test. app.ts renders `message || summary || "Task completed"`,
  // so an excerpt built from `summary ?? message` would disagree with the very
  // Telegram message the drill-down refers to.
  it("stop excerpt prefers message over summary when BOTH are set", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    storage.sessions.setLastHumanMsgId("s1", "msg_01H1", 1_000);
    await postStop(app, { session_id: "s1", event: "Stop", message: "THE MESSAGE", summary: "the summary" });
    const row = storage.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM outbox WHERE kind = 'stop'")
      .get() as { a: string | null; e: string | null } | undefined;
    expect(row?.e).toBe("THE MESSAGE");
    expect(row?.a).toBe("msg_01H1");
  });

  it("stop falls back to summary, then to the default", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    await postStop(app, { session_id: "s1", event: "Stop", summary: "only summary" });
    const row = storage.db.prepare("SELECT excerpt AS e FROM outbox WHERE kind='stop'").get() as { e: string } | undefined;
    expect(row?.e).toBe("only summary");
  });

  // Guards against "just slice outbox.payload", whose first 150 chars are markup.
  it("mirror excerpt is plain text, not the formatted payload", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", messageId: "msg_01m", text: "a & b < c" }),
      }),
    );
    const row = outboxRow("m:s1:msg_01m");
    expect(row?.e).toBe("a & b < c");
    expect(row?.e).not.toContain("&amp;");
    expect(row?.e).not.toContain("&lt;");
    // The mirrored turn is its own anchor.
    expect(row?.a).toBe("msg_01m");
  });

  it("a stop on a session with no human turn stores a null anchor and still delivers", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    const res = await postStop(app, { session_id: "s1", event: "Stop", message: "done" });
    expect(res.ok).toBe(true);
    const row = storage.db.prepare("SELECT anchor_msg_id AS a FROM outbox WHERE kind='stop'").get() as { a: string | null } | undefined;
    expect(row?.a).toBeNull();
  });
});

function swarmRecord(overrides: Partial<SwarmMessageRecord> = {}): SwarmMessageRecord {
  return {
    msgId: "msg_1001", fromSession: "ses_sender", toSession: "s1", channel: null,
    kind: "chat", priority: "normal", replyTo: null, payload: "Hello receiver!",
    state: "queued", attempts: 0, nextRetryAt: null, createdAt: 1_000, updatedAt: 1_000,
    handedOffAt: null, verifiedAt: null, requeueCount: 0, nudgeCount: 0, abortedAt: null,
    deliverAt: null, expiresAt: null, cancelledAt: null, ref: null, ...overrides,
  };
}

describe("phase 1b: swarm and question sites", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function row(notificationId: string) {
    return storage!.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM outbox WHERE notification_id = ?")
      .get(notificationId) as { a: string | null; e: string | null } | undefined;
  }

  // A peer message is NOT presence, so the anchor must be the RECIPIENT's own
  // last human turn -- never the peer turn that triggered the notice.
  it("swarm notice anchors on the recipient's last human turn", () => {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    storage.sessions.setLastHumanMsgId("s1", "msg_01mine", 1_000);
    enqueueSwarmTelegramNotice(storage, swarmRecord(), 1_000);
    const r = row("w:msg_1001");
    expect(r?.a).toBe("msg_01mine");
    expect(r?.e).toBe("Hello receiver!");
  });

  // The cancel notice says a message was RETRACTED. Storing its payload as the
  // excerpt would surface in the drill-down exactly what the reader is being
  // told to disregard.
  it("swarm CANCEL notice stores no excerpt but still anchors", () => {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    storage.sessions.setLastHumanMsgId("s1", "msg_01mine", 1_000);
    // A cancel notice is only emitted if the ORIGINAL was posted -- absence of
    // the original is the one correct reason to stay silent.
    enqueueSwarmTelegramNotice(storage, swarmRecord({ payload: "SECRET RETRACTED TEXT" }), 1_000);
    enqueueSwarmCancelNotice(storage, swarmRecord({ payload: "SECRET RETRACTED TEXT" }), 1_000);
    const r = row("wc:msg_1001");
    expect(r?.a).toBe("msg_01mine");
    expect(r?.e).toBeNull();
  });

  it("question notification anchors on the last human turn and excerpts the first question", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    storage.sessions.upsert({ sessionId: "s1", notify: true }, 1_000);
    storage.sessions.setLastHumanMsgId("s1", "msg_01H1", 1_000);
    const qres = await app(
      new Request("http://localhost/question-asked", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: "s1",
          request_id: "req1",
          questions: [
            { question: "FIRST question?", header: "h", options: [{ label: "a", description: "d" }] },
            { question: "second question?", header: "h", options: [{ label: "b", description: "d" }] },
          ],
        }),
      }),
    );
    const r = storage.db
      .prepare("SELECT anchor_msg_id AS a, excerpt AS e FROM outbox WHERE kind = 'question'")
      .get() as { a: string | null; e: string | null } | undefined;
    expect(qres.ok).toBe(true);
    expect(r?.a).toBe("msg_01H1");
    expect(r?.e).toBe("FIRST question?");
  });
});

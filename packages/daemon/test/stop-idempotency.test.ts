import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

/**
 * POST /stop accepts a CLIENT-supplied notification_id.
 *
 * Without it the id is `s:<session>:<serverNow>`, so the "already queued" check is
 * idempotent with nothing: a plugin retry of a POST that timed out but was actually
 * processed produces a second outbox row and a second Telegram message. The plugin's
 * new retry queue makes that retry routine, so the key is a prerequisite for it.
 *
 * The key is an outbox PRIMARY KEY, so it is validated against the session that sent
 * it. A key naming a DIFFERENT session would collide with that session's row, get
 * "already queued" back, and the caller would mark its own stop delivered -- silently
 * losing it. Validation failure falls back to the server key rather than 4xx, because
 * the plugin treats 4xx as terminal and would drop the notification.
 */
describe("POST /stop idempotency key", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now, chatId: "chat-1", machineId: "devbox" });
  }

  async function startSession(app: ReturnType<typeof createApp>, sessionId: string) {
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, notify: true }),
    }));
  }

  function stop(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
    return app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("uses a client-supplied notification_id", async () => {
    const app = newApp();
    await startSession(app, "sess-a");

    const res = await stop(app, {
      session_id: "sess-a",
      event: "Stop",
      message: "Done",
      notification_id: "s:sess-a:msg_1.0",
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.notificationId).toBe("s:sess-a:msg_1.0");
    expect(storage!.outbox.getByNotificationId("s:sess-a:msg_1.0")).not.toBeNull();
  });

  it("makes a retry of the same key a no-op instead of a second Telegram message", async () => {
    const app = newApp();
    await startSession(app, "sess-b");

    const first = await stop(app, {
      session_id: "sess-b",
      message: "Done",
      notification_id: "s:sess-b:msg_1.0",
    });
    expect(first.status).toBe(202);

    const retry = await stop(app, {
      session_id: "sess-b",
      message: "Done",
      notification_id: "s:sess-b:msg_1.0",
    });

    expect(retry.status).toBe(202);
    expect((await retry.json()).notificationId).toBe("s:sess-b:msg_1.0");

    const rows = storage!.db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE session_id = ?")
      .get("sess-b") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("mints only one reply token across a retry", async () => {
    const app = newApp();
    await startSession(app, "sess-tok");

    await stop(app, { session_id: "sess-tok", message: "Done", notification_id: "s:sess-tok:m.0" });
    await stop(app, { session_id: "sess-tok", message: "Done", notification_id: "s:sess-tok:m.0" });

    const rows = storage!.db
      .prepare("SELECT COUNT(*) AS n FROM session_tokens WHERE session_id = ?")
      .get("sess-tok") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("does not re-run title/policy side effects on a retry", async () => {
    const app = newApp();
    await startSession(app, "sess-t");

    await stop(app, {
      session_id: "sess-t",
      message: "Done",
      title: "First title",
      notification_id: "s:sess-t:m.0",
    });

    // A retry carries the SAME payload it was enqueued with. If the pre-check sat
    // below setTitle, a retry would still be able to move session state.
    await stop(app, {
      session_id: "sess-t",
      message: "Done",
      title: "Second title",
      notification_id: "s:sess-t:m.0",
    });

    expect(storage!.sessions.get("sess-t")!.title).toBe("First title");
  });

  it("falls back to the server key when the key names a different session", async () => {
    const app = newApp();
    await startSession(app, "sess-x");
    await startSession(app, "sess-y");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // sess-x queues its own stop first.
    await stop(app, { session_id: "sess-x", message: "X output", notification_id: "s:sess-x:m.0" });

    // sess-y sends a key belonging to sess-x. It must NOT be told "already queued".
    const res = await stop(app, {
      session_id: "sess-y",
      message: "Y output",
      notification_id: "s:sess-x:m.0",
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.notificationId).not.toBe("s:sess-x:m.0");
    expect(json.notificationId).toMatch(/^s:sess-y:/);

    const row = storage!.outbox.getByNotificationId(json.notificationId);
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("sess-y");

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to the server key for a malformed key, and never 4xx", async () => {
    const app = newApp();
    await startSession(app, "sess-m");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const bad of [
      "q:sess-m:1",              // wrong kind prefix
      "s:sess-m",                // no third segment
      "s:sess-m:has space",      // charset
      `s:sess-m:${"x".repeat(200)}`, // too long
      "",
    ]) {
      const res = await stop(app, {
        session_id: "sess-m",
        message: "Done",
        notification_id: bad,
      });
      expect(res.status).toBe(202);
      expect((await res.json()).notificationId).not.toBe(bad);
    }

    warn.mockRestore();
  });

  it("still works with no notification_id at all (old plugin)", async () => {
    const app = newApp();
    await startSession(app, "sess-old");

    const res = await stop(app, { session_id: "sess-old", message: "Done" });

    expect(res.status).toBe(202);
    expect((await res.json()).notificationId).toMatch(/^s:sess-old:/);
  });
});

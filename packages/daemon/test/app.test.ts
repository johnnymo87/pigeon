import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { DEFAULT_DECLARED_QUIET_TTL_MS } from "../src/notify-policy";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { StopNotifier } from "../src/notification-service";

/**
 * True when `s` contains no unpaired UTF-16 surrogate. An unpaired surrogate survives
 * JSON.stringify (which escapes it as a well-formed \\udXXX) but cannot be encoded as
 * UTF-8, so Telegram either rejects the request or mojibakes it to U+FFFD.
 */
function isWellFormedTitle(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}


describe("createApp", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, notifier?: StopNotifier) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now, notifier });
  }

  it("returns health payload", async () => {
    const app = newApp();
    const response = await app(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "pigeon-daemon" });
  });

  it("GET /outbox/stats returns outbox aggregate stats", async () => {
    const app = newApp(10_000);

    storage!.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 2_000);

    storage!.outbox.upsert({
      notificationId: "notif-2",
      sessionId: "sess-1",
      requestId: "req-2",
      kind: "stop",
      payload: "{}",
      token: "tok-2",
    }, 5_000);
    storage!.outbox.markFailed("notif-2", 6_000, "expired");

    const response = await app(new Request("http://localhost/outbox/stats"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      states: { queued: 1, sending: 0, sent: 0, failed: 1 },
      failedReasons: { expired: 1 },
      oldestQueuedAgeMs: 8_000,
    });
  });

  it("returns not found for unknown routes", async () => {
    const app = newApp();
    const response = await app(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("supports /session-start and /sessions lookup parity", async () => {
    const started: Array<{ sessionId: string; notify: boolean; label: string | null | undefined }> = [];
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 10_000,
      onSessionStart: (sessionId, notify, label) => {
        started.push({ sessionId, notify, label });
      },
    });

    const start = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-1",
        ppid: 42,
        pid: 99,
        start_time: 123,
        cwd: "/tmp",
        label: "Session One",
        notify: false,
        tty: "pts/8",
      }),
    }));

    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ ok: true, session_id: "sess-1" });

    const list = await app(new Request("http://localhost/sessions"));
    const listBody = (await list.json()) as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(list.status).toBe(200);
    expect(listBody.ok).toBe(true);
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]?.session_id).toBe("sess-1");

    const single = await app(new Request("http://localhost/sessions/sess-1"));
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { ok: boolean; session: { session_id: string } };
    expect(singleBody.session.session_id).toBe("sess-1");
    expect(started).toEqual([]);
  });

  it("supports /session-start with plugin-direct backend_kind parity", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 10_000 });

    const start = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "direct-sess-1",
        notify: true,
        label: "Direct Plugin Session",
        backend_kind: "opencode-plugin-direct",
        backend_protocol_version: 1,
        backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
        backend_auth_token: "secret-token-abc",
      }),
    }));

    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ ok: true, session_id: "direct-sess-1" });

    const list = await app(new Request("http://localhost/sessions"));
    const listBody = (await list.json()) as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(list.status).toBe(200);
    expect(listBody.sessions).toHaveLength(1);
    const sess = listBody.sessions[0]!;
    expect(sess.session_id).toBe("direct-sess-1");
    expect(sess.backend_kind).toBe("opencode-plugin-direct");
    expect(sess.backend_protocol_version).toBe(1);
    expect(sess.backend_endpoint).toBe("http://127.0.0.1:9999/pigeon/direct/execute");
    // backend_auth_token should not be exposed in session list responses
    expect(sess).not.toHaveProperty("backend_auth_token");

    // Verify single-session lookup too
    const single = await app(new Request("http://localhost/sessions/direct-sess-1"));
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(singleBody.session.backend_kind).toBe("opencode-plugin-direct");
    expect(singleBody.session.backend_protocol_version).toBe(1);
    expect(singleBody.session.backend_endpoint).toBe("http://127.0.0.1:9999/pigeon/direct/execute");
  });

  it("stores title from /session-start", async () => {
    const app = newApp();
    const res = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_t2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "Fix flaky auth test",
      }),
    }));
    expect(res.status).toBe(200);
    expect(storage?.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
  });

  it("treats opencode's placeholder title as absent (pigeon-353p)", async () => {
    const app = newApp();
    const res = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_placeholder",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "New session - 2026-08-11T10:11:16.127Z",
      }),
    }));
    expect(res.status).toBe(200);
    expect(storage?.sessions.get("ses_placeholder")?.title ?? null).toBeNull();
  });

  it("a placeholder title does not clobber a real stored title (pigeon-353p)", async () => {
    const app = newApp();
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_placeholder_2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "Real title",
      }),
    }));
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_placeholder_2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "New session - 2026-08-11T10:11:16.127Z",
      }),
    }));
    expect(storage?.sessions.get("ses_placeholder_2")?.title).toBe("Real title");
  });

  it("a title that merely mentions a placeholder-like string is kept (pigeon-353p)", async () => {
    const app = newApp();
    const res = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_placeholder_3",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "New session handling in the reaper",
      }),
    }));
    expect(res.status).toBe(200);
    expect(storage?.sessions.get("ses_placeholder_3")?.title).toBe("New session handling in the reaper");
  });

  it("does not clobber a stored title when /session-start omits it", async () => {
    const app = newApp();
    const res1 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_t2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "Fix flaky auth test",
      }),
    }));
    expect(res1.status).toBe(200);
    expect(storage?.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");

    const res2 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_t2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
      }),
    }));
    expect(res2.status).toBe(200);
    expect(storage?.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
  });

  it("does not clobber a stored title when /session-start passes empty string title", async () => {
    const app = newApp();
    const res1 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_t2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "Fix flaky auth test",
      }),
    }));
    expect(res1.status).toBe(200);
    expect(storage?.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");

    const res2 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_t2",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "",
      }),
    }));
    expect(res2.status).toBe(200);
    expect(storage?.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
  });

  it("does not clobber a stored title when /session-start passes whitespace-only title", async () => {
    const app = newApp();
    const res1 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_ws",
        notify: true,
        title: "Original Title",
      }),
    }));
    expect(res1.status).toBe(200);
    expect(storage?.sessions.get("ses_ws")?.title).toBe("Original Title");

    const res2 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_ws",
        notify: true,
        title: "   ",
      }),
    }));
    expect(res2.status).toBe(200);
    expect(storage?.sessions.get("ses_ws")?.title).toBe("Original Title");
  });

  it("projects title in legacy /sessions JSON responses and redacts backend_auth_token", async () => {
    const app = newApp();

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_with_title",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
        title: "Feature Forum Topics",
        backend_auth_token: "secret-token-123",
      }),
    }));

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_no_title",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        label: "pigeon",
      }),
    }));

    const listRes = await app(new Request("http://localhost/sessions"));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(listBody.ok).toBe(true);

    const sesWithTitle = listBody.sessions.find(s => s.session_id === "ses_with_title")!;
    const sesNoTitle = listBody.sessions.find(s => s.session_id === "ses_no_title")!;

    expect(sesWithTitle).toBeDefined();
    expect(sesWithTitle.title).toBe("Feature Forum Topics");
    // Redaction guard, both spellings: the snake_case key catches an explicit
    // mapping being added, the camelCase key catches a `...session` spread
    // leaking the raw storage record.
    expect(sesWithTitle).not.toHaveProperty("backend_auth_token");
    expect(sesWithTitle).not.toHaveProperty("backendAuthToken");

    expect(sesNoTitle).toBeDefined();
    expect("title" in sesNoTitle).toBe(true);
    expect(sesNoTitle.title).toBeNull();

    const singleWithTitleRes = await app(new Request("http://localhost/sessions/ses_with_title"));
    expect(singleWithTitleRes.status).toBe(200);
    const singleWithTitleBody = (await singleWithTitleRes.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(singleWithTitleBody.session.title).toBe("Feature Forum Topics");
    expect(singleWithTitleBody.session).not.toHaveProperty("backend_auth_token");
    expect(singleWithTitleBody.session).not.toHaveProperty("backendAuthToken");

    const singleNoTitleRes = await app(new Request("http://localhost/sessions/ses_no_title"));
    expect(singleNoTitleRes.status).toBe(200);
    const singleNoTitleBody = (await singleNoTitleRes.json()) as { ok: boolean; session: Record<string, unknown> };
    expect("title" in singleNoTitleBody.session).toBe(true);
    expect(singleNoTitleBody.session.title).toBeNull();
  });

  it("stores trimmed title when /session-start or /stop passes title with surrounding whitespace", async () => {
    const app = newApp();
    const res1 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_trim",
        notify: true,
        title: "  Padded Title  ",
      }),
    }));
    expect(res1.status).toBe(200);
    expect(storage?.sessions.get("ses_trim")?.title).toBe("Padded Title");

    const res2 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_trim",
        event: "Stop",
        message: "Done",
        title: "  New Padded Title  ",
      }),
    }));
    expect(res2.status).toBe(202);
    expect(storage?.sessions.get("ses_trim")?.title).toBe("New Padded Title");
  });

  it("clamps titles longer than 200 characters to 200 characters after trimming", async () => {
    const app = newApp();
    const longTitle = "a".repeat(250);
    const expectedTitle = "a".repeat(200);

    const res1 = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_long",
        notify: true,
        title: "  " + longTitle + "  ",
      }),
    }));
    expect(res1.status).toBe(200);
    expect(storage?.sessions.get("ses_long")?.title).toBe(expectedTitle);
    expect(storage?.sessions.get("ses_long")?.title?.length).toBe(200);

    const exact200Title = "b".repeat(200);
    const res2 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "ses_long",
        event: "Stop",
        message: "Done",
        title: exact200Title,
      }),
    }));
    expect(res2.status).toBe(202);
    expect(storage?.sessions.get("ses_long")?.title).toBe(exact200Title);
    expect(storage?.sessions.get("ses_long")?.title?.length).toBe(200);
  });

  it("does not leave a lone surrogate when clamping splits an astral character", async () => {
    const app = newApp();
    // 199 ASCII + one astral char (2 UTF-16 units) straddling the 199/200 boundary.
    // A bare .slice(0, 200) keeps the high surrogate and drops the low one.
    const straddling = "a".repeat(199) + "\u{1F600}";
    expect(straddling.length).toBe(201);

    const res = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "ses_surrogate", notify: true, title: straddling }),
    }));
    expect(res.status).toBe(200);

    const stored = storage?.sessions.get("ses_surrogate")?.title;
    // The whole astral char is dropped rather than half of it kept.
    expect(stored).toBe("a".repeat(199));
    expect(stored?.length).toBe(199);
    expect(isWellFormedTitle(stored!)).toBe(true);
  });

  it("keeps a whole astral character that ends exactly on the clamp boundary", async () => {
    const app = newApp();
    // 198 ASCII + astral char => length exactly 200, the pair is intact and must survive.
    const exact = "a".repeat(198) + "\u{1F600}";
    expect(exact.length).toBe(200);

    const res = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "ses_surrogate_fit", notify: true, title: exact }),
    }));
    expect(res.status).toBe(200);

    const stored = storage?.sessions.get("ses_surrogate_fit")?.title;
    expect(stored).toBe(exact);
    expect(stored?.length).toBe(200);
    expect(isWellFormedTitle(stored!)).toBe(true);
  });

  it("supports /sessions/enable-notify preserving backend_kind fields", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 20_000 });

    // Create a direct session without notify
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "direct-sess-2",
        notify: false,
        backend_kind: "opencode-plugin-direct",
        backend_protocol_version: 1,
        backend_endpoint: "http://127.0.0.1:8888/pigeon/direct/execute",
        backend_auth_token: "token-xyz",
      }),
    }));

    // Enable notify — backend fields should be preserved
    const response = await app(new Request("http://localhost/sessions/enable-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "direct-sess-2", label: "Notified Direct" }),
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.session.notify).toBe(true);
    expect(body.session.label).toBe("Notified Direct");
    expect(body.session.backend_kind).toBe("opencode-plugin-direct");
    expect(body.session.backend_protocol_version).toBe(1);
    expect(body.session.backend_endpoint).toBe("http://127.0.0.1:8888/pigeon/direct/execute");
  });

  it("supports /sessions/enable-notify preserving title", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 20_000 });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "title-sess-1",
        notify: false,
        title: "Fix flaky auth test",
      }),
    }));

    const response = await app(new Request("http://localhost/sessions/enable-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "title-sess-1", label: "Notified Title Session" }),
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.session.notify).toBe(true);
    expect(body.session.label).toBe("Notified Title Session");
    expect(storage?.sessions.get("title-sess-1")?.title).toBe("Fix flaky auth test");
  });

  it("supports /sessions/enable-notify parity behavior", async () => {
    const started: Array<{ sessionId: string; notify: boolean; label: string | null | undefined }> = [];
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 20_000,
      onSessionStart: (sessionId, notify, label) => {
        started.push({ sessionId, notify, label });
      },
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-2", notify: false }),
    }));

    const response = await app(new Request("http://localhost/sessions/enable-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-2",
        label: "Renamed",
      }),
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.session.notify).toBe(true);
    expect(body.session.label).toBe("Renamed");
    expect(started).toEqual([{ sessionId: "sess-2", notify: true, label: "Renamed" }]);
  });

  it("supports /cleanup and DELETE /sessions/:id", async () => {
    const deleted: string[] = [];
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 30_000,
      onSessionDelete: async (sessionId) => {
        deleted.push(sessionId);
      },
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-3", notify: true }),
    }));

    const cleanup = await app(new Request("http://localhost/cleanup", {
      method: "POST",
    }));
    expect(cleanup.status).toBe(200);
    const cleanupBody = (await cleanup.json()) as {
      ok: boolean;
      cleaned: { sessions: number; tokens: number };
    };
    expect(cleanupBody.ok).toBe(true);
    expect(cleanupBody.cleaned.tokens).toBe(0);

    const del = await app(new Request("http://localhost/sessions/sess-3", {
      method: "DELETE",
    }));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(deleted).toEqual(["sess-3"]);

    const missing = await app(new Request("http://localhost/sessions/sess-3"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Session not found" });
  });

  it("returns no-op stop response when notify=false", async () => {
    const app = newApp(40_000);

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-1", notify: false }),
    }));

    const stop = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-1", event: "Stop", message: "Done" }),
    }));

    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, notified: false, reason: "notify=false" });
  });

  it("queues stop notification in outbox even when no notifier configured", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-123",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-2", notify: true }),
    }));

    const stop = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-2", event: "Stop", message: "Done" }),
    }));

    expect(stop.status).toBe(202);
    const json = await stop.json();
    expect(json.ok).toBe(true);
    expect(json.deliveryState).toBe("queued");
    expect(json.notificationId).toMatch(/^s:sess-stop-2:/);

    // Verify outbox entry was created
    const outboxEntry = storage.outbox.getByNotificationId(json.notificationId);
    expect(outboxEntry).not.toBeNull();
    expect(outboxEntry!.kind).toBe("stop");
    expect(outboxEntry!.sessionId).toBe("sess-stop-2");
    expect(outboxEntry!.state).toBe("queued");
  });

  it("queues stop notification in outbox for delivery by OutboxSender", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 60_000,
      chatId: "chat-123",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-3", notify: true, label: "My Session" }),
    }));

    const stop = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-3",
        event: "Stop",
        summary: "Summary text",
      }),
    }));

    expect(stop.status).toBe(202);
    const json = await stop.json();
    expect(json.ok).toBe(true);
    expect(json.deliveryState).toBe("queued");

    // Verify outbox payload contains formatted notification
    const outboxEntry = storage.outbox.getByNotificationId(json.notificationId);
    expect(outboxEntry).not.toBeNull();
    const payload = JSON.parse(outboxEntry!.payload);
    expect(payload.messages).toBeDefined();
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.messages[0].text).toContain("✅ My Session");
    expect(Array.isArray(payload.messages[0].entities)).toBe(true);
  });

  it("POST /stop with title updates session title and displays in header, and omits preserve title", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 65_000,
      chatId: "chat-123",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-title", notify: true, label: "Initial Label" }),
    }));

    // Call /stop with title
    const stop1 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-title",
        event: "Stop",
        message: "First stop",
        title: "Live Title From Stop",
      }),
    }));

    expect(stop1.status).toBe(202);
    expect(storage.sessions.get("sess-stop-title")?.title).toBe("Live Title From Stop");

    const json1 = await stop1.json();
    const outboxEntry1 = storage.outbox.getByNotificationId(json1.notificationId);
    const payload1 = JSON.parse(outboxEntry1!.payload);
    expect(payload1.messages[0].text).toContain("Live Title From Stop");

    // Call /stop omitting title - title must be preserved in DB and used in header
    const stop2 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-title",
        event: "Stop",
        message: "Second stop without title",
      }),
    }));

    expect(stop2.status).toBe(202);
    expect(storage.sessions.get("sess-stop-title")?.title).toBe("Live Title From Stop");

    // Call /stop with whitespace-only title - title must remain untouched in DB
    const stop3 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-title",
        event: "Stop",
        message: "Third stop with whitespace title",
        title: "   ",
      }),
    }));

    expect(stop3.status).toBe(202);
    expect(storage.sessions.get("sess-stop-title")?.title).toBe("Live Title From Stop");
  });

  it("includes title, dir, and threaded in outbox payload on /stop", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 68_000,
      chatId: "chat-123",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-topic-payload",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        title: "Fix flaky test",
      }),
    }));

    const stop = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-stop-topic-payload",
        message: "Done",
      }),
    }));

    expect(stop.status).toBe(202);
    const json = await stop.json();
    const outboxEntry = storage.outbox.getByNotificationId(json.notificationId);
    expect(outboxEntry).not.toBeNull();
    const payload = JSON.parse(outboxEntry!.payload);
    expect(payload.title).toBe("Fix flaky test");
    expect(payload.dir).toBe("/home/dev/projects/pigeon");
    expect(payload.threaded).toBe(true);
  });

  it("returns existing outbox entry on duplicate stop request", async () => {
    storage = openStorageDb(":memory:");
    const fixedNow = 70_000;
    const app = createApp(storage, {
      nowFn: () => fixedNow,
      chatId: "chat-123",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-4", notify: true }),
    }));

    // First call queues
    const stop1 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-4", message: "Done" }),
    }));
    expect(stop1.status).toBe(202);

    // Second call with same timestamp returns existing
    const stop2 = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-4", message: "Done" }),
    }));
    expect(stop2.status).toBe(202);
    const json = await stop2.json();
    expect(json.deliveryState).toBe("queued");
  });

  it("POST /question-asked stores pending question and returns 202 accepted (durable)", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-123",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-q", notify: true }),
    }));

    const response = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q",
        request_id: "question_abc",
        questions: [{
          question: "Which DB?",
          header: "DB Choice",
          options: [
            { label: "PostgreSQL", description: "Relational" },
            { label: "SQLite", description: "File-based" },
          ],
        }],
      }),
    }));

    expect(response.status).toBe(202);
    const json = await response.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.deliveryState).toBe("accepted");
    expect(typeof json.notificationId).toBe("string");
    expect(json.notificationId).toBe("q:sess-q:question_abc");

    // Outbox row should be created
    const outboxRow = storage!.outbox.getByNotificationId("q:sess-q:question_abc");
    expect(outboxRow).toBeTruthy();
    expect(outboxRow?.kind).toBe("question");
    expect(outboxRow?.state).toBe("queued");
    expect(outboxRow?.sessionId).toBe("sess-q");
    expect(outboxRow?.requestId).toBe("question_abc");

    // Pending question should be stored
    const pq = storage!.pendingQuestions.getBySessionId("sess-q", 50_001);
    expect(pq).toBeTruthy();
    expect(pq?.requestId).toBe("question_abc");

    // Session token should be minted
    const token = outboxRow?.token;
    expect(token).toBeTruthy();
  });

  it("POST /question-asked returns 202 queued on idempotent retry", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-123",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-q2", notify: true }),
    }));

    const body = JSON.stringify({
      session_id: "sess-q2",
      request_id: "question_dup",
      questions: [{ question: "Retry?", header: "H", options: [] }],
    });

    // First call
    const first = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));
    expect(first.status).toBe(202);
    const firstJson = await first.json() as Record<string, unknown>;
    expect(firstJson.deliveryState).toBe("accepted");

    // Second call with same session_id + request_id
    const second = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));
    expect(second.status).toBe(202);
    const secondJson = await second.json() as Record<string, unknown>;
    expect(secondJson.ok).toBe(true);
    expect(secondJson.deliveryState).toBe("queued");
    expect(secondJson.notificationId).toBe("q:sess-q2:question_dup");

    // Only one outbox row should exist
    const outboxRow = storage!.outbox.getByNotificationId("q:sess-q2:question_dup");
    expect(outboxRow).toBeTruthy();
  });

  it("POST /question-asked returns 200 failed when existing outbox row is failed and logs warning", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-123",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-qfailed", notify: true }),
    }));

    const body = JSON.stringify({
      session_id: "sess-qfailed",
      request_id: "question_failed",
      questions: [{ question: "Failed?", header: "H", options: [] }],
    });

    // First call to populate outbox
    const first = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));
    expect(first.status).toBe(202);

    // Mark outbox row as failed
    const notificationId = "q:sess-qfailed:question_failed";
    storage.outbox.markFailed(notificationId, 51_000, "Delivery failed permanently");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Second call with same request_id
    const second = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));

    expect(second.status).toBe(200);
    const secondJson = await second.json() as Record<string, unknown>;
    expect(secondJson).toEqual({
      ok: false,
      deliveryState: "failed",
      notificationId,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      `[question] outbox row failed sessionId=sess-qfailed notificationId=${notificationId} failedReason=Delivery failed permanently`,
    );

    warnSpy.mockRestore();
  });

  it("POST /question-asked returns notified=false when notify=false", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 50_000 });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-nonotify", notify: false }),
    }));

    const response = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-nonotify",
        request_id: "question_nn",
        questions: [{ question: "Skip?", header: "H", options: [] }],
      }),
    }));

    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.notified).toBe(false);
    expect(json.reason).toBe("notify=false");
  });

  it("includes title, dir, and threaded in outbox payload on /question-asked", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 85_000,
      chatId: "chat-123",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q-topic-payload",
        notify: true,
        cwd: "/home/dev/projects/pigeon",
        title: "Question session",
      }),
    }));

    const qRes = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q-topic-payload",
        request_id: "req-q1",
        questions: [{ type: "text", question: "Confirm?", options: [] }],
      }),
    }));

    expect(qRes.status).toBe(202);
    const json = await qRes.json();
    const outboxEntry = storage.outbox.getByNotificationId(json.notificationId);
    expect(outboxEntry).not.toBeNull();
    const payload = JSON.parse(outboxEntry!.payload);
    expect(payload.title).toBe("Question session");
    expect(payload.dir).toBe("/home/dev/projects/pigeon");
    expect(payload.threaded).toBe(true);
  });

  it("POST /question-asked returns 400 for missing fields", async () => {
    const app = newApp();

    const noSession = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: "q1", questions: [{ question: "?" }] }),
    }));
    expect(noSession.status).toBe(400);

    const noRequest = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", questions: [{ question: "?" }] }),
    }));
    expect(noRequest.status).toBe(400);

    const noQuestions = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", request_id: "q1", questions: [] }),
    }));
    expect(noQuestions.status).toBe(400);
  });

  it("touches session last_seen on /question-asked", async () => {
    let now = 100_000;
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => now,
      chatId: "42",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-q-touch", notify: true }),
    }));

    const sessionBefore = storage.sessions.get("sess-q-touch");
    expect(sessionBefore!.lastSeen).toBe(100_000);

    now = 200_000;

    await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q-touch",
        request_id: "req-1",
        questions: [{ type: "text", question: "Continue?", options: [] }],
      }),
    }));

    const sessionAfter = storage.sessions.get("sess-q-touch");
    expect(sessionAfter!.lastSeen).toBe(200_000);
  });

  it("POST /question-asked with title updates session title and displays in header, and omits preserve title", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 100_000,
      chatId: "42",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-q-title", notify: true }),
    }));

    const res1 = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q-title",
        request_id: "req-t1",
        questions: [{ type: "text", question: "Continue?", options: [] }],
        title: "Question Title Test",
      }),
    }));

    expect(res1.status).toBe(202);
    expect(storage.sessions.get("sess-q-title")?.title).toBe("Question Title Test");

    const json1 = await res1.json();
    const outbox1 = storage.outbox.getByNotificationId(json1.notificationId);
    const payload1 = JSON.parse(outbox1!.payload);
    expect(payload1.message.text).toContain("Question Title Test");

    // Omitting title preserves stored title
    const res2 = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-q-title",
        request_id: "req-t2",
        questions: [{ type: "text", question: "Continue2?", options: [] }],
      }),
    }));

    expect(res2.status).toBe(202);
    expect(storage.sessions.get("sess-q-title")?.title).toBe("Question Title Test");

    const json2 = await res2.json();
    const outbox2 = storage.outbox.getByNotificationId(json2.notificationId);
    const payload2 = JSON.parse(outbox2!.payload);
    expect(payload2.message.text).toContain("Question Title Test");
  });

  it("POST /question-asked with multiple questions formats wizard step 1", async () => {
    const sessionId = "sess-wiz";
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-wiz",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, notify: true }),
    }));

    const res = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: "req-wiz",
        questions: [
          { question: "Q1", header: "H1", options: [{ label: "A", description: "" }] },
          { question: "Q2", header: "H2", options: [{ label: "B", description: "" }] },
        ],
        label: "pigeon",
      }),
    }));

    expect(res.status).toBe(202);

    // Verify pending question stored with wizard state (pass now to avoid TTL expiry)
    const pq = storage.pendingQuestions.getBySessionId(sessionId, 50_001);
    expect(pq).not.toBeNull();
    expect(pq!.currentStep).toBe(0);
    expect(pq!.answers).toEqual([]);
    expect(pq!.version).toBe(0);

    // Verify outbox entry contains wizard step 1 format
    const notificationId = `q:${sessionId}:req-wiz`;
    const outbox = storage.outbox.getByNotificationId(notificationId);
    expect(outbox).not.toBeNull();
    const payload = JSON.parse(outbox!.payload);
    expect(payload.message.text).toContain("Question 1 of 2");
    expect(payload.message.text).toContain("H1");
    expect(Array.isArray(payload.message.entities)).toBe(true);
    // Buttons should be present (wizard mode)
    expect(payload.replyMarkup.inline_keyboard.length).toBeGreaterThan(0);
    // Buttons should have versioned callback_data
    expect(payload.replyMarkup.inline_keyboard[0][0].callback_data).toContain(":v0:");
  });

  it("POST /question-asked with single question uses standard format (no wizard)", async () => {
    const sessionId = "sess-single-fmt";
    storage = openStorageDb(":memory:");
    const app = createApp(storage, {
      nowFn: () => 50_000,
      chatId: "chat-single",
      machineId: "devbox",
    });

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, notify: true }),
    }));

    const res = await app(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: "req-single",
        questions: [
          { question: "Which DB?", header: "DB Choice", options: [{ label: "PostgreSQL", description: "Relational" }] },
        ],
        label: "pigeon",
      }),
    }));

    expect(res.status).toBe(202);

    const notificationId = `q:${sessionId}:req-single`;
    const outbox = storage.outbox.getByNotificationId(notificationId);
    expect(outbox).not.toBeNull();
    const payload = JSON.parse(outbox!.payload);
    // Single question should NOT use wizard format
    expect(payload.message.text).not.toContain("Question 1 of");
    expect(payload.message.text).toContain("DB Choice");
    expect(Array.isArray(payload.message.entities)).toBe(true);
    // Buttons should still be present for single-question
    expect(payload.replyMarkup.inline_keyboard.length).toBeGreaterThan(0);
    // Single-question buttons do NOT have versioned ":v0:" callback_data
    expect(payload.replyMarkup.inline_keyboard[0][0].callback_data).not.toContain(":v0:");
  });

  it("POST /question-answered clears pending question", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 50_000 });

    storage.pendingQuestions.store({
      sessionId: "sess-qa",
      requestId: "question_xyz",
      questions: [{ question: "?", header: "H", options: [] }],
    }, 50_000);

    expect(storage.pendingQuestions.getBySessionId("sess-qa", 50_001)).toBeTruthy();

    const response = await app(new Request("http://localhost/question-answered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-qa" }),
    }));

    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.cleared).toBe(true);
    expect(storage.pendingQuestions.getBySessionId("sess-qa", 50_001)).toBeNull();
  });

  describe("PIGEON_QUIET_TITLE_PATTERN stop notification suppression", () => {
    const originalQuietPattern = process.env.PIGEON_QUIET_TITLE_PATTERN;

    afterEach(() => {
      if (originalQuietPattern !== undefined) {
        process.env.PIGEON_QUIET_TITLE_PATTERN = originalQuietPattern;
      } else {
        delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      }
    });

    it("does NOT enqueue stop notification for lgtm-titled session and logs suppression", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-1",
          notify: true,
          title: "Run .lgtm-review-prompt.md task",
        }),
      }));

      const res = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-1",
          event: "Stop",
          message: "PR review done",
        }),
      }));

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.notified).toBe(false);
      expect(json.reason).toBe("quiet_title");

      // Verify no outbox entry was created
      const outboxEntries = storage.outbox.getReady(200_000, 10);
      expect(outboxEntries).toHaveLength(0);

      // Verify log line was emitted with event=
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[stop\] quieted sessionId=sess-lgtm-1 event=Stop title="Run \.lgtm-review-prompt\.md task"/),
      );

      logSpy.mockRestore();
    });

    it("IS enqueued for an ordinary session title (guard against over-matching)", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-normal-1",
          notify: true,
          title: "Fix failing auth test in packages/daemon",
        }),
      }));

      const res = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-normal-1",
          event: "Stop",
          message: "All tests pass",
        }),
      }));

      expect(res.status).toBe(202);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");

      const outboxEntries = storage.outbox.getReady(200_000, 10);
      expect(outboxEntries).toHaveLength(1);
      expect(outboxEntries[0]?.sessionId).toBe("sess-normal-1");
    });

    it("matches case-insensitively (e.g. .LGTM- in uppercase prose)", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-upper",
          notify: true,
          title: "PR review from .LGTM-prompt.md",
        }),
      }));

      const res = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-upper",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.notified).toBe(false);
      expect(json.reason).toBe("quiet_title");
    });

    it("IS enqueued when event is Error, even on lgtm-titled session", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-err",
          notify: true,
          title: "Run .lgtm-review-prompt.md task",
        }),
      }));

      const res = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-err",
          event: "Error",
          message: "Unhandled exception in worker",
        }),
      }));

      expect(res.status).toBe(202);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");

      const outboxEntries = storage.outbox.getReady(200_000, 10);
      expect(outboxEntries).toHaveLength(1);
      expect(outboxEntries[0]?.sessionId).toBe("sess-lgtm-err");
    });

    it("IS enqueued when event is Retry, even on lgtm-titled session", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-retry",
          notify: true,
          title: "Run .lgtm-review-prompt.md task",
        }),
      }));

      const res = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-retry",
          event: "Retry",
          message: "Rate limit hit, retrying in 30s",
        }),
      }));

      expect(res.status).toBe(202);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");

      const outboxEntries = storage.outbox.getReady(200_000, 10);
      expect(outboxEntries).toHaveLength(1);
      expect(outboxEntries[0]?.sessionId).toBe("sess-lgtm-retry");
    });

    it("delivers real work ON lgtm, but suppresses the prose automation title", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      // Real work on the lgtm tool itself -> MUST be delivered (false positives hide real work)
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-prose",
          notify: true,
          title: "Fix lgtm dispatcher timeout",
        }),
      }));

      const resProse = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-prose",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(resProse.status).toBe(202);
      expect((await resProse.json() as Record<string, unknown>).deliveryState).toBe("queued");

      // Prose automation title (no filename, no dot) -> IS suppressed under the tuned default
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-dot-lgtm",
          notify: true,
          title: "Review PR using LGTM prompt",
        }),
      }));

      const resDot = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-dot-lgtm",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(resDot.status).toBe(200);
      expect((await resDot.json() as Record<string, unknown>).reason).toBe("quiet_title");
    });

    it("IS still enqueued and delivered for a question notification even on lgtm-titled session", async () => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-q",
          notify: true,
          title: "Review PR using LGTM prompt",
        }),
      }));

      const res = await app(new Request("http://localhost/question-asked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-q",
          request_id: "req-q-lgtm",
          questions: [{ type: "text", question: "Merge this PR?", options: [] }],
        }),
      }));

      expect(res.status).toBe(202);
      const json = await res.json() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("accepted");

      const outboxRow = storage.outbox.getByNotificationId("q:sess-lgtm-q:req-q-lgtm");
      expect(outboxRow).not.toBeNull();
      expect(outboxRow?.kind).toBe("question");
    });

    it("allows PIGEON_QUIET_TITLE_PATTERN to override the default pattern", async () => {
      process.env.PIGEON_QUIET_TITLE_PATTERN = "custom-quiet";
      storage = openStorageDb(":memory:");

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      // Custom quiet title -> quieted
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-custom-q",
          notify: true,
          title: "Run custom-quiet agent",
        }),
      }));

      const res1 = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-custom-q",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(res1.status).toBe(200);
      expect((await res1.json() as Record<string, unknown>).reason).toBe("quiet_title");

      // LGTM session when pattern is custom-quiet -> NOT quieted
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-notquiet",
          notify: true,
          title: "Review PR using LGTM prompt",
        }),
      }));

      const res2 = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-lgtm-notquiet",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(res2.status).toBe(202);
      expect((await res2.json() as Record<string, unknown>).deliveryState).toBe("queued");
    });

    it("falls back to default /lgtm/i pattern on invalid regex in PIGEON_QUIET_TITLE_PATTERN without throwing", async () => {
      process.env.PIGEON_QUIET_TITLE_PATTERN = "[unclosed-bracket";
      storage = openStorageDb(":memory:");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const app = createApp(storage, {
        nowFn: () => 100_000,
        chatId: "chat-123",
      });

      // LGTM session should still be quieted using default fallback
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-invalid-regex-lgtm",
          notify: true,
          title: "Run .lgtm-review-prompt.md task",
        }),
      }));

      const res1 = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-invalid-regex-lgtm",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(res1.status).toBe(200);
      expect((await res1.json() as Record<string, unknown>).reason).toBe("quiet_title");

      // Verify error logged about invalid regex
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/invalid PIGEON_QUIET_TITLE_PATTERN regex/),
        expect.anything(),
      );

      // Normal session should NOT be quieted
      await app(new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-invalid-regex-normal",
          notify: true,
          title: "Normal working session",
        }),
      }));

      const res2 = await app(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "sess-invalid-regex-normal",
          event: "Stop",
          message: "Done",
        }),
      }));

      expect(res2.status).toBe(202);
      expect((await res2.json() as Record<string, unknown>).deliveryState).toBe("queued");

      errorSpy.mockRestore();
    });
  });

  describe("POST /session-origin", () => {
    async function post(app: ReturnType<typeof createApp>, body: unknown) {
      return app(new Request("http://localhost/session-origin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    it("records a declared origin and is idempotent", async () => {
      const app = newApp(5_000);
      const res = await post(app, {
        session_id: "ses_a",
        origin: "lgtm",
        notify_policy: "errors-only",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_a",
        origin: "lgtm",
        notify_policy: "errors-only",
        source: "declared",
      });

      const again = await post(app, {
        session_id: "ses_a",
        origin: "lgtm",
        notify_policy: "errors-only",
      });
      expect(again.status).toBe(200);
      expect(storage!.sessionOrigins.get("ses_a")?.createdAt).toBe(5_000);
    });

    it("does NOT require the session to exist yet", async () => {
      // The launcher writes between session creation and the first prompt; the plugin
      // has not registered the session with the daemon at that point.
      const app = newApp();
      const res = await post(app, { session_id: "ses_ghost", origin: "lgtm", notify_policy: "none" });
      expect(res.status).toBe(200);
      expect(storage!.sessionOrigins.get("ses_ghost")?.origin).toBe("lgtm");
    });

    it("rejects a missing session_id", async () => {
      const app = newApp();
      const res = await post(app, { origin: "lgtm", notify_policy: "none" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/session_id/);
    });

    it("rejects a malformed session_id", async () => {
      const app = newApp();
      const res = await post(app, { session_id: "nope", origin: "lgtm", notify_policy: "none" });
      expect(res.status).toBe(400);
    });

    it("rejects an unknown notify_policy rather than defaulting it", async () => {
      // Fail LOUD on the write path: a typo'd policy that silently became "all" would
      // look like the feature simply not working, with nothing to grep for.
      const app = newApp();
      const res = await post(app, { session_id: "ses_a", origin: "lgtm", notify_policy: "quiet" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/notify_policy/);
      expect(storage!.sessionOrigins.get("ses_a")).toBeNull();
    });

    it("rejects an empty origin", async () => {
      const app = newApp();
      const res = await post(app, { session_id: "ses_a", origin: "", notify_policy: "none" });
      expect(res.status).toBe(400);
    });

    it("rejects a whitespace-only origin", async () => {
      const app = newApp();
      const res = await post(app, { session_id: "ses_a", origin: "   ", notify_policy: "none" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/origin/);
    });

    it("rejects session_id longer than 128 characters", async () => {
      const app = newApp();
      const longSid = "ses_" + "a".repeat(130);
      const res = await post(app, { session_id: longSid, origin: "lgtm", notify_policy: "none" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/session_id/);
    });

    it("rejects origin longer than 200 characters", async () => {
      const app = newApp();
      const longOrigin = "a".repeat(201);
      const res = await post(app, { session_id: "ses_a", origin: longOrigin, notify_policy: "none" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/origin/);
    });

    it("rejects origin containing control characters or interior newlines", async () => {
      const app = newApp();
      const res1 = await post(app, { session_id: "ses_a", origin: "lgtm\nscript", notify_policy: "none" });
      expect(res1.status).toBe(400);
      expect((await res1.json()).error).toMatch(/origin/);

      const res2 = await post(app, { session_id: "ses_a", origin: "lgtm\x07foo", notify_policy: "none" });
      expect(res2.status).toBe(400);
      expect((await res2.json()).error).toMatch(/origin/);
    });
  });

  describe("GET /session-origin", () => {
    async function get(app: ReturnType<typeof createApp>, query: string) {
      return app(new Request(`http://localhost/session-origin${query}`, { method: "GET" }));
    }

    it("400 on missing session_id", async () => {
      const app = newApp();
      const res = await get(app, "");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("400 on empty session_id", async () => {
      const app = newApp();
      const res = await get(app, "?session_id=");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("400 on malformed session_id", async () => {
      const app = newApp();
      const res = await get(app, "?session_id=invalid_sid");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("404 on unknown session", async () => {
      const app = newApp();
      const res = await get(app, "?session_id=ses_unknown");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "No origin recorded for session",
        hint: "No origin recorded means no override or declared origin exists. The legacy title regex and default delivery policy apply.",
      });
    });

    it("200 with full row after seeding via storage.sessionOrigins.record", async () => {
      const app = newApp(10_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_seeded", origin: "unit-test", notifyPolicy: "errors-only", source: "declared" },
        10_000,
      );

      const res = await get(app, "?session_id=ses_seeded");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessionId: "ses_seeded",
        origin: "unit-test",
        notifyPolicy: "errors-only",
        source: "declared",
        createdAt: 10_000,
        updatedAt: 10_000,
      });
    });

    it("round-trip: POST /session-origin row is readable via GET /session-origin", async () => {
      const app = newApp(12_345);
      const postRes = await app(
        new Request("http://localhost/session-origin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "ses_rt",
            origin: "launcher-script",
            notify_policy: "none",
          }),
        }),
      );
      expect(postRes.status).toBe(200);

      const getRes = await get(app, "?session_id=ses_rt");
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({
        sessionId: "ses_rt",
        origin: "launcher-script",
        notifyPolicy: "none",
        source: "declared",
        createdAt: 12_345,
        updatedAt: 12_345,
      });
    });
  });

  describe("DELETE /session-origin", () => {
    async function del(app: ReturnType<typeof createApp>, query: string) {
      return app(new Request(`http://localhost/session-origin${query}`, { method: "DELETE" }));
    }

    it("deletes an existing row and returns cleared: true", async () => {
      const app = newApp(5_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_del", origin: "unit-test", notifyPolicy: "errors-only", source: "declared" },
        5_000,
      );
      expect(storage!.sessionOrigins.get("ses_del")).not.toBeNull();

      const res = await del(app, "?session_id=ses_del");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_del",
        cleared: true,
      });
      expect(storage!.sessionOrigins.get("ses_del")).toBeNull();
    });

    it("is idempotent on unknown session id and returns cleared: false", async () => {
      const app = newApp();
      const res = await del(app, "?session_id=ses_unknown");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_unknown",
        cleared: false,
      });
    });

    it("400 on missing session_id", async () => {
      const app = newApp();
      const res = await del(app, "");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("400 on empty session_id", async () => {
      const app = newApp();
      const res = await del(app, "?session_id=");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("400 on malformed session_id", async () => {
      const app = newApp();
      const res = await del(app, "?session_id=invalid_sid");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "session_id must match ^ses_[A-Za-z0-9_-]+$ and be 128 characters or fewer",
      });
    });

    it("round-trip downgrade path: override -> declared record ignored -> DELETE -> declared record succeeds", async () => {
      const app = newApp(10_000);
      // 1. Seed override row (e.g. user ran enable-notify)
      storage!.sessionOrigins.record(
        { sessionId: "ses_override", origin: "user:enable-notify", notifyPolicy: "all", source: "override" },
        10_000,
      );

      // 2. Automated declared record attempt is a no-op against override
      storage!.sessionOrigins.record(
        { sessionId: "ses_override", origin: "launcher", notifyPolicy: "errors-only", source: "declared" },
        11_000,
      );
      let record = storage!.sessionOrigins.get("ses_override");
      expect(record?.source).toBe("override");
      expect(record?.notifyPolicy).toBe("all");

      // 3. DELETE /session-origin clears the override
      const delRes = await del(app, "?session_id=ses_override");
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true, session_id: "ses_override", cleared: true });
      expect(storage!.sessionOrigins.get("ses_override")).toBeNull();

      // 4. Automated declared record attempt now succeeds
      storage!.sessionOrigins.record(
        { sessionId: "ses_override", origin: "launcher", notifyPolicy: "errors-only", source: "declared" },
        12_000,
      );
      record = storage!.sessionOrigins.get("ses_override");
      expect(record?.source).toBe("declared");
      expect(record?.notifyPolicy).toBe("errors-only");
    });
  });

  describe("POST /stop honours session_origin policy", () => {
    const originalQuietPattern = process.env.PIGEON_QUIET_TITLE_PATTERN;
    const originalQuietLayer = process.env.PIGEON_QUIET_TITLE_LAYER;

    beforeEach(() => {
      delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      delete process.env.PIGEON_QUIET_TITLE_LAYER;
    });

    afterEach(() => {
      if (originalQuietPattern !== undefined) {
        process.env.PIGEON_QUIET_TITLE_PATTERN = originalQuietPattern;
      } else {
        delete process.env.PIGEON_QUIET_TITLE_PATTERN;
      }
      if (originalQuietLayer !== undefined) {
        process.env.PIGEON_QUIET_TITLE_LAYER = originalQuietLayer;
      } else {
        delete process.env.PIGEON_QUIET_TITLE_LAYER;
      }
    });

    async function stop(app: ReturnType<typeof createApp>, event = "Stop", title = "PR review") {
      return app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event, summary: "done", title }),
        }),
      );
    }

    function seed(app: ReturnType<typeof createApp>, policy: string, notify = true) {
      storage!.sessions.upsert({ sessionId: "ses_a", notify }, 1_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: policy as never, source: "declared" },
        1_000,
      );
    }

    it("errors-only + Stop -> quiet_origin", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Stop");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "quiet_origin" });
    });

    it("errors-only + Error -> delivered (202 queued)", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Error");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("errors-only + Retry -> delivered (202 queued)", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Retry");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("notify=false on session short-circuits ahead of policy layer even with notifyPolicy=all", async () => {
      const app = newApp();
      seed(app, "all", false);
      const res = await stop(app, "Stop");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "notify=false" });
    });

    it("none + Stop -> quiet_origin", async () => {
      const app = newApp();
      seed(app, "none");
      const res = await stop(app, "Stop");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "quiet_origin" });
    });

    it("session with NO origin row falls through to title layer (quiet-matching title -> quiet_title)", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
      const res = await stop(app, "Stop", "Review PR with lgtm-review-prompt");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "quiet_title" });
    });

    it("notifyPolicy=all + quiet-matching title -> delivered (provenance overrides title regex)", async () => {
      const app = newApp();
      seed(app, "all");
      const res = await stop(app, "Stop", "Review PR with lgtm-review-prompt");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("delivers Stop and logs observable line when declared quiet policy is expired", async () => {
      const createdAt = 1_000;
      const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
      const now = createdAt + ttl + 500;
      const app = newApp(now);

      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, createdAt);
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        createdAt,
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await stop(app, "Stop", "PR review .lgtm-review-prompt.md");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");

      expect(logSpy).toHaveBeenCalledWith(
        `[stop] automated quiet expired sessionId=ses_a origin=lgtm source=declared ` +
        `policy=errors-only ageMs=${ttl + 500} — delivering`,
      );

      logSpy.mockRestore();
    });

    // pigeon-2z5w. The quieted line has always carried event/layer/origin; the queued
    // line carried none of them, so a DELIVERY from an errors-only session was
    // indistinguishable in the logs between "Error/Retry, delivered by design" and
    // "a Stop leaked past the origin layer". Verifying pigeon-qdcb.8 needed an
    // elimination argument over the source instead of one grep. These two tests pin
    // the fields that make it directly observable.
    it("logs event, origin and effective policy when DELIVERING from an errors-only session", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // errors-only suppresses Stop but delivers Retry -- the by-design case that
      // used to be unreadable in the logs.
      const res = await stop(app, "Retry", "PR review .lgtm-review-prompt.md");
      expect(res.status).toBe(202);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[stop\] queued sessionId=ses_a event=Retry .*origin=lgtm policy=errors-only/,
        ),
      );

      logSpy.mockRestore();
    });

    it("logs placeholders for event/origin/policy when delivering with no origin row", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await stop(app, "Stop", "ordinary human work");
      expect(res.status).toBe(202);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[stop\] queued sessionId=ses_a event=Stop .*origin=- policy=-/),
      );

      logSpy.mockRestore();
    });

    it("fails open and delivers if storage.sessionOrigins.get throws", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
      vi.spyOn(storage!.sessionOrigins, "get").mockImplementationOnce(() => {
        throw new Error("DB lock failure");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await stop(app, "Stop");
      expect(res.status).toBe(202);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[stop] session_origin read failed sessionId=ses_a, delivering:"),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it("fails open and delivers if decideNotify throws", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
      const notifyPolicyModule = await import("../src/notify-policy");
      vi.spyOn(notifyPolicyModule, "decideNotify").mockImplementationOnce(() => {
        throw new Error("Unexpected policy failure");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await stop(app, "Stop");
      expect(res.status).toBe(202);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[stop] notify decision failed sessionId=ses_a, delivering:"),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe("POST /sessions/enable-notify un-quiet override", () => {
    it("overrides pre-existing quiet origin row while preserving origin provenance", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: false }, 1_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        1_000,
      );

      const res = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );
      expect(res.status).toBe(200);

      const originRow = storage!.sessionOrigins.get("ses_a");
      expect(originRow).toEqual({
        sessionId: "ses_a",
        origin: "lgtm",
        notifyPolicy: "all",
        source: "override",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    it("reports 500 rather than a false success when the override write fails", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: false }, 1_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        1_000,
      );

      storage!.sessionOrigins.record = () => {
        throw new Error("disk on fire");
      };

      const res = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );

      // The user's only escape hatch failed. Answering ok:true would tell them a session
      // that is still suppressed had been un-quieted (app.ts:113).
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/still be suppressed/);

      // The request is deliberately partially applied: sessions.notify is already committed
      // and a retry heals the rest. Pin that so the partial state is a decision, not a drift.
      expect(storage!.sessions.get("ses_a")?.notify).toBe(true);
    });

    it("creates an override row with origin 'unknown' when no origin row exists", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: false }, 1_000);

      const res = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );
      expect(res.status).toBe(200);

      const originRow = storage!.sessionOrigins.get("ses_a");
      expect(originRow).toEqual({
        sessionId: "ses_a",
        origin: "unknown",
        notifyPolicy: "all",
        source: "override",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    it("end-to-end: un-quiets a declared-quieted session over HTTP", async () => {
      // The most representative production sequence: lgtm declares the session quiet first,
      // the user escapes second, and the next Stop must reach them.
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true, title: "some work" }, 1_000);
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        1_000,
      );

      const stopRes1 = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(await stopRes1.json()).toEqual({ ok: true, notified: false, reason: "quiet_origin" });

      const enableRes = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );
      expect(enableRes.status).toBe(200);

      const stopRes2 = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(stopRes2.status).toBe(202);
      expect((await stopRes2.json()).deliveryState).toBe("queued");
    });

    it("end-to-end: DELETE returns a session to title-regex suppression", async () => {
      const app = newApp();
      storage!.sessions.upsert(
        { sessionId: "ses_a", notify: true, title: "Review PR with lgtm-review-prompt" },
        1_000,
      );

      await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );

      const delRes = await app(
        new Request("http://localhost/session-origin?session_id=ses_a", { method: "DELETE" }),
      );
      expect(delRes.status).toBe(200);
      expect((await delRes.json()).cleared).toBe(true);

      // Back to the weakest state: the legacy title layer applies again.
      const stopRes = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(await stopRes.json()).toEqual({ ok: true, notified: false, reason: "quiet_title" });
    });

    it("end-to-end: un-quiets a title-quieted session", async () => {
      const app = newApp();
      storage!.sessions.upsert(
        { sessionId: "ses_a", notify: true, title: "Review PR with lgtm-review-prompt" },
        1_000,
      );

      // Initially suppressed by title regex
      const stopRes1 = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(await stopRes1.json()).toEqual({ ok: true, notified: false, reason: "quiet_title" });

      // Enable notify
      const enableRes = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );
      expect(enableRes.status).toBe(200);

      // Now delivered despite quiet title
      const stopRes2 = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(stopRes2.status).toBe(202);
      const json2 = await stopRes2.json();
      expect(json2.ok).toBe(true);
      expect(json2.deliveryState).toBe("queued");
    });

    it("override sticks against later automated writer", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true, title: "Review PR with lgtm-review-prompt" }, 1_000);

      await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );

      // Automated writer attempts to set quiet policy
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        2_000,
      );

      const originRow = storage!.sessionOrigins.get("ses_a");
      expect(originRow?.notifyPolicy).toBe("all");
      expect(originRow?.source).toBe("override");

      // Stop is still delivered
      const stopRes = await app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a", event: "Stop" }),
        }),
      );
      expect(stopRes.status).toBe(202);
      expect((await stopRes.json()).deliveryState).toBe("queued");
    });

    it("retains existing behaviour of setting sessions.notify to true", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: false }, 1_000);

      const res = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_a" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(storage!.sessions.get("ses_a")?.notify).toBe(true);
    });

    it("returns 404 for unknown session and writes no origin row", async () => {
      const app = newApp();

      const res = await app(
        new Request("http://localhost/sessions/enable-notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "ses_unknown" }),
        }),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });
      expect(storage!.sessionOrigins.get("ses_unknown")).toBeNull();
    });
  });
});

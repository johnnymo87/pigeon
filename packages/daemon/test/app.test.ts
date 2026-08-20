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

  it("supports /session-start upsert preserving backend_kind fields", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 20_000 });

    // Create a direct session
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

    // Update label — backend fields should be preserved
    const response = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "direct-sess-2", label: "Updated Direct" }),
    }));

    expect(response.status).toBe(200);
    const session = storage.sessions.get("direct-sess-2");
    expect(session?.label).toBe("Updated Direct");
    expect(session?.backendKind).toBe("opencode-plugin-direct");
    expect(session?.backendProtocolVersion).toBe(1);
    expect(session?.backendEndpoint).toBe("http://127.0.0.1:8888/pigeon/direct/execute");
    expect(session?.backendAuthToken).toBe("token-xyz");
  });

  it("supports /session-start upsert preserving title", async () => {
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

    const response = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "title-sess-1", label: "Updated Title Session" }),
    }));

    expect(response.status).toBe(200);
    const session = storage.sessions.get("title-sess-1");
    expect(session?.label).toBe("Updated Title Session");
    expect(session?.title).toBe("Fix flaky auth test");
  });

  it("supports /session-start parity behavior on re-registration", async () => {
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
      body: JSON.stringify({ session_id: "sess-2", notify: true, label: "Initial" }),
    }));

    const response = await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-2",
        notify: true,
        label: "Renamed",
      }),
    }));

    expect(response.status).toBe(200);
    const session = storage.sessions.get("sess-2");
    expect(session?.notify).toBe(true);
    expect(session?.label).toBe("Renamed");
    expect(started).toEqual([
      { sessionId: "sess-2", notify: true, label: "Initial" },
      { sessionId: "sess-2", notify: true, label: "Renamed" },
    ]);
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
        hint: "No origin recorded means no declared origin exists. The default delivery policy applies.",
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
        declaredAt: 10_000,
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
        declaredAt: 12_345,
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
  });

  describe("POST /stop honours session_origin policy", () => {
    async function stop(app: ReturnType<typeof createApp>, event = "Stop", title = "PR review", errorKind?: string | null) {
      return app(
        new Request("http://localhost/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "ses_a",
            event,
            summary: "done",
            title,
            ...(errorKind !== undefined ? { error_kind: errorKind } : {}),
          }),
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

    it("errors-only + Error without error_kind -> delivered (202 queued, fail-open)", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Error");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("errors-only + Error with non-aborted error_kind -> delivered (202 queued)", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Error", "PR review", "rate_limited");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("errors-only + Error with error_kind=aborted -> quiet_origin", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Error", "PR review", "aborted");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "quiet_origin" });
    });

    it("errors-only + Retry -> quiet_origin", async () => {
      const app = newApp();
      seed(app, "errors-only");
      const res = await stop(app, "Retry");
      expect(await res.json()).toEqual({ ok: true, notified: false, reason: "quiet_origin" });
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

    it("session with NO origin row and a quiet-matching title DELIVERS by default", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
      const res = await stop(app, "Stop", "Review PR with lgtm-review-prompt");
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deliveryState).toBe("queued");
    });

    it("notifyPolicy=all + quiet-matching title -> delivered", async () => {
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

    it("pigeon-n097: re-declaring quiet after TTL expiry re-silences both Stop and swarm notices while preserving createdAt", async () => {
      const createdAt = 1_000;
      const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
      const expiredTime = createdAt + ttl + 5_000; // past TTL
      const redeclareTime = expiredTime + 1_000; // re-declaration time

      let now = redeclareTime + 1_000;
      const app = newApp(now);

      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, createdAt);
      storage!.sessions.upsert({ sessionId: "ses_b", notify: true }, createdAt);

      // Initial declaration at t=1000
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        createdAt,
      );

      // Re-declare quiet policy at t=redeclareTime
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        redeclareTime,
      );

      // Verify createdAt is preserved but declaredAt and updatedAt are refreshed
      const originRecord = storage!.sessionOrigins.get("ses_a");
      expect(originRecord?.createdAt).toBe(createdAt);
      expect(originRecord?.declaredAt).toBe(redeclareTime);
      expect(originRecord?.updatedAt).toBe(redeclareTime);

      // 1. Assert Stop is suppressed (notified: false, reason: "quiet_origin")
      const stopRes = await stop(app, "Stop", "PR review .lgtm-review-prompt.md");
      expect(stopRes.status).toBe(200);
      const stopJson = await stopRes.json();
      expect(stopJson).toEqual({ ok: true, notified: false, reason: "quiet_origin" });

      // 2. Assert swarm send is 202 and swarm_messages row exists, but w: outbox row is absent
      const swarmRes = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_b",
            to: "ses_a",
            kind: "chat",
            payload: "re-review prompt",
          }),
        }),
      );
      expect(swarmRes.status).toBe(202);
      const swarmJson = (await swarmRes.json()) as { accepted: boolean; msg_id: string };
      expect(swarmJson.accepted).toBe(true);

      // Non-vacuous check: swarm_messages row MUST exist
      const storedSwarmMsg = storage!.swarm.getByMsgId(swarmJson.msg_id);
      expect(storedSwarmMsg).toBeDefined();
      expect(storedSwarmMsg?.msgId).toBe(swarmJson.msg_id);

      // Outbox notice w:<msg_id> MUST BE ABSENT because the receiver is declared quiet
      const outboxNotice = storage!.outbox.getByNotificationId(`w:${swarmJson.msg_id}`);
      expect(outboxNotice).toBeNull();
    });

    it("pigeon-n097: positive control: expired quiet session without re-declaration delivers Stop and emits swarm notice", async () => {
      const createdAt = 1_000;
      const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
      const expiredTime = createdAt + ttl + 5_000;

      const app = newApp(expiredTime);

      storage!.sessions.upsert({ sessionId: "ses_a", notify: true }, createdAt);
      storage!.sessions.upsert({ sessionId: "ses_b", notify: true }, createdAt);

      // Initial declaration at t=1000
      storage!.sessionOrigins.record(
        { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
        createdAt,
      );

      // Do NOT re-declare. Now time is expiredTime.

      // 1. Stop is delivered
      const stopRes = await stop(app, "Stop", "PR review .lgtm-review-prompt.md");
      expect(stopRes.status).toBe(202);
      const stopJson = await stopRes.json();
      expect(stopJson.ok).toBe(true);
      expect(stopJson.deliveryState).toBe("queued");

      // 2. Swarm send emits w: outbox notice
      const swarmRes = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_b",
            to: "ses_a",
            kind: "chat",
            payload: "re-review prompt",
          }),
        }),
      );
      expect(swarmRes.status).toBe(202);
      const swarmJson = (await swarmRes.json()) as { accepted: boolean; msg_id: string };
      expect(swarmJson.accepted).toBe(true);

      const outboxNotice = storage!.outbox.getByNotificationId(`w:${swarmJson.msg_id}`);
      expect(outboxNotice).not.toBeNull();
      expect(outboxNotice?.sessionId).toBe("ses_a");
      expect(outboxNotice?.kind).toBe("swarm");
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

      // errors-only suppresses Stop and Retry but delivers Error -- the by-design case that
      // used to be unreadable in the logs.
      const res = await stop(app, "Error", "PR review .lgtm-review-prompt.md");
      expect(res.status).toBe(202);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[stop\] queued sessionId=ses_a event=Error .*origin=lgtm policy=errors-only/,
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

  describe("POST /session-start diagnostic logging (pigeon-m426.5)", () => {
    let logSpy: ReturnType<typeof vi.spyOn> | null = null;

    afterEach(() => {
      if (logSpy) {
        logSpy.mockRestore();
        logSpy = null;
      }
    });

    it("emits log line with endpoint, tokenFp, and changed=new on fresh registration without leaking raw token", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const rawSecretToken = "super-secret-auth-token-12345-uuid-67890";
      const res = await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-fresh-1",
            backend_kind: "opencode-plugin-direct",
            backend_protocol_version: 1,
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: rawSecretToken,
          }),
        }),
      );

      expect(res.status).toBe(200);
      const regLog = logs.find((l) => l.includes("[session-start] registered"));
      expect(regLog).toBeDefined();
      expect(regLog).toBe(
        "[session-start] registered sessionId=sess-fresh-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );

      // Security check: raw token NEVER in any log output
      for (const log of logs) {
        expect(log).not.toContain(rawSecretToken);
      }
    });

    it("reports changed=true with previous endpoint and tokenFp when re-registered with different values", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const oldToken = "super-secret-auth-token-12345-uuid-67890"; // tokenFp: b7fee892
      const newToken = "brand-new-auth-token-99999-uuid-11111"; // tokenFp: 3cebc701

      // First registration
      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-rereg-1",
            backend_kind: "opencode-plugin-direct",
            backend_protocol_version: 1,
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: oldToken,
          }),
        }),
      );

      // Second registration (e.g. revive/restart on new port with new token)
      const res = await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-rereg-1",
            backend_kind: "opencode-plugin-direct",
            backend_protocol_version: 1,
            backend_endpoint: "http://127.0.0.1:8888/pigeon/direct/execute",
            backend_auth_token: newToken,
          }),
        }),
      );

      expect(res.status).toBe(200);
      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-rereg-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-rereg-1 endpoint=http://127.0.0.1:8888/pigeon/direct/execute tokenFp=3cebc701 changed=true prevEndpoint=http://127.0.0.1:9999/pigeon/direct/execute prevTokenFp=b7fee892",
      );

      // Security check: raw tokens NEVER in any log output
      for (const log of logs) {
        expect(log).not.toContain(oldToken);
        expect(log).not.toContain(newToken);
      }
    });

    it("reports changed=false and omits prev fields when re-registered with identical endpoint and token", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token = "super-secret-auth-token-12345-uuid-67890";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-same-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-same-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-same-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-same-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=false",
      );
    });

    it("does not crash or emit bogus tokenFp when registration has no backend token or endpoint", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const res = await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-nvim-1",
            nvim_socket: "/tmp/nvim.sock",
            tty: "/dev/pts/1",
          }),
        }),
      );

      expect(res.status).toBe(200);
      const regLog = logs.find((l) => l.includes("[session-start] registered"));
      expect(regLog).toBeDefined();
      expect(regLog).toBe("[session-start] registered sessionId=sess-nvim-1 changed=new");
      expect(regLog).not.toContain("tokenFp");
      expect(regLog).not.toContain("endpoint=");
      expect(regLog).not.toContain("undefined");
    });

    it("does not crash or emit bogus tokenFp when registration has endpoint but no auth token", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const res = await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-no-token-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
          }),
        }),
      );

      expect(res.status).toBe(200);
      const regLog = logs.find((l) => l.includes("[session-start] registered"));
      expect(regLog).toBeDefined();
      expect(regLog).toBe(
        "[session-start] registered sessionId=sess-no-token-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute changed=new",
      );
      expect(regLog).not.toContain("tokenFp");
      expect(regLog).not.toContain("undefined");
    });

    it("reports changed=true when only endpoint changes", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token = "super-secret-auth-token-12345-uuid-67890";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-ep-change-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-ep-change-1",
            backend_endpoint: "http://127.0.0.1:8888/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-ep-change-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-ep-change-1 endpoint=http://127.0.0.1:8888/pigeon/direct/execute tokenFp=b7fee892 changed=true prevEndpoint=http://127.0.0.1:9999/pigeon/direct/execute prevTokenFp=b7fee892",
      );
    });

    it("reports changed=true when only token changes", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token1 = "super-secret-auth-token-12345-uuid-67890";
      const token2 = "brand-new-auth-token-99999-uuid-11111";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-tok-change-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token1,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-tok-change-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token2,
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-tok-change-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-tok-change-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=3cebc701 changed=true prevEndpoint=http://127.0.0.1:9999/pigeon/direct/execute prevTokenFp=b7fee892",
      );
    });

    it("reports changed=true when upgrading a session that had no backend endpoint/token", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token = "super-secret-auth-token-12345-uuid-67890";

      // Session start without backend endpoint/token
      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-upgrade-1",
            label: "initial session",
          }),
        }),
      );

      // Upgrade with direct channel endpoint and token
      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-upgrade-1",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe("[session-start] registered sessionId=sess-upgrade-1 changed=new");
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-upgrade-1 endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=true",
      );
    });

    it("reports inherited=endpoint,token when re-registration omits backend fields and preserves existing values", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token = "super-secret-auth-token-12345-uuid-67890";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-both",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-both",
            label: "updated label",
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-inherit-both endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-inherit-both endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=false inherited=endpoint,token",
      );
    });

    it("reports inherited=endpoint when re-registration supplies only fresh token", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token1 = "super-secret-auth-token-12345-uuid-67890";
      const token2 = "brand-new-auth-token-99999-uuid-11111";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-ep",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token1,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-ep",
            backend_auth_token: token2,
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-inherit-ep endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-inherit-ep endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=3cebc701 changed=true prevEndpoint=http://127.0.0.1:9999/pigeon/direct/execute prevTokenFp=b7fee892 inherited=endpoint",
      );
    });

    it("reports inherited=token when re-registration supplies only fresh endpoint", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      const token = "super-secret-auth-token-12345-uuid-67890";

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-tok",
            backend_endpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
            backend_auth_token: token,
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-inherit-tok",
            backend_endpoint: "http://127.0.0.1:8888/pigeon/direct/execute",
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe(
        "[session-start] registered sessionId=sess-inherit-tok endpoint=http://127.0.0.1:9999/pigeon/direct/execute tokenFp=b7fee892 changed=new",
      );
      expect(regLogs[1]).toBe(
        "[session-start] registered sessionId=sess-inherit-tok endpoint=http://127.0.0.1:8888/pigeon/direct/execute tokenFp=b7fee892 changed=true prevEndpoint=http://127.0.0.1:9999/pigeon/direct/execute prevTokenFp=b7fee892 inherited=token",
      );
    });

    it("does not report inherited on fresh registration or when session had no prior backend fields", async () => {
      const app = newApp();
      const logs: string[] = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-bare",
            tty: "/dev/pts/1",
          }),
        }),
      );

      await app(
        new Request("http://localhost/session-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "sess-bare",
            tty: "/dev/pts/2",
          }),
        }),
      );

      const regLogs = logs.filter((l) => l.includes("[session-start] registered"));
      expect(regLogs).toHaveLength(2);
      expect(regLogs[0]).toBe("[session-start] registered sessionId=sess-bare changed=new");
      expect(regLogs[1]).toBe("[session-start] registered sessionId=sess-bare changed=false");
      expect(regLogs[0]).not.toContain("inherited=");
      expect(regLogs[1]).not.toContain("inherited=");
    });
  });
});

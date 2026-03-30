import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { StopNotifier, QuestionNotifier } from "../src/notification-service";

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
    expect(payload.texts).toBeDefined();
    expect(payload.texts.length).toBeGreaterThan(0);
    expect(payload.texts[0]).toContain("Stop");
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
    expect(payload.text).toContain("Question 1 of 2");
    expect(payload.text).toContain("H1");
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
    expect(payload.text).not.toContain("Question 1 of");
    expect(payload.text).toContain("DB Choice");
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
});

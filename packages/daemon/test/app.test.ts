import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { StopNotifier } from "../src/notification-service";

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
        nvim_socket: "/tmp/nvim.sock",
        tty: "pts/8",
        tmux_pane_id: "%3",
        tmux_session: "dev",
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
    expect(listBody.sessions[0]?.transport).toEqual({
      kind: "nvim",
      nvim_socket: "/tmp/nvim.sock",
      instance_name: "pts/8",
      pane_id: "%3",
      session_name: "dev",
    });

    const single = await app(new Request("http://localhost/sessions/sess-1"));
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { ok: boolean; session: { session_id: string } };
    expect(singleBody.session.session_id).toBe("sess-1");
    expect(started).toEqual([]);
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
        nvim_socket: "/tmp/new.sock",
      }),
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; session: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.session.notify).toBe(true);
    expect(body.session.label).toBe("Renamed");
    expect(body.session.transport).toEqual({ kind: "nvim", nvim_socket: "/tmp/new.sock" });
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

  it("returns no-notifier response when notify=true but handler missing", async () => {
    const app = newApp(50_000);

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

    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, notified: false, reason: "no notification handler" });
  });

  it("uses notifier and returns token for stop notifications", async () => {
    const notifier: StopNotifier = {
      sendStopNotification: vi.fn(async () => ({ token: "tok-1" })),
    };

    const app = newApp(60_000, notifier);

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

    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, notified: true, token: "tok-1" });
    expect((notifier.sendStopNotification as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns notified=false when notifier throws", async () => {
    const notifier: StopNotifier = {
      sendStopNotification: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    };

    const app = newApp(70_000, notifier);

    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-4", notify: true }),
    }));

    const stop = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-stop-4", message: "Done" }),
    }));

    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, notified: false, error: "telegram down" });
  });
});

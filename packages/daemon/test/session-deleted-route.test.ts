import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("POST /session-deleted (pigeon-4ogz.21)", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  function newApp(opts: Parameters<typeof createApp>[1] = {}) {
    storage = openStorageDb(":memory:");
    return { app: createApp(storage, opts), storage };
  }

  function post(app: ReturnType<typeof createApp>, body: unknown) {
    return app(
      new Request("http://localhost/session-deleted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("400s without a session_id", async () => {
    const { app } = newApp({ onBackendSessionDeleted: vi.fn() });
    const res = await post(app, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "session_id is required" });
  });

  it("hands the id to the handler and returns its outcome", async () => {
    const onBackendSessionDeleted = vi.fn().mockResolvedValue("torn_down");
    const { app } = newApp({ onBackendSessionDeleted });

    const res = await post(app, { session_id: "ses_1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "torn_down" });
    expect(onBackendSessionDeleted).toHaveBeenCalledWith("ses_1");
  });

  it("answers 200 outcome 'absent' and touches nothing when no handler is wired", async () => {
    const { app, storage: s } = newApp({});
    s.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);

    const res = await post(app, { session_id: "ses_1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "absent" });
    expect(s.sessions.get("ses_1")).not.toBeNull();
  });
});

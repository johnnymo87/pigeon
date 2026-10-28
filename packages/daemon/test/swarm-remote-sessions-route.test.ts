/**
 * `GET /swarm/remote-sessions` (pigeon-k0qn.9): the daemon half of swarm_list's remote
 * discovery. Proxies the worker's `GET /sessions/remote` and adds `relay_send`, which only this
 * daemon knows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

const LISTING = {
  machine_id: "cloudbox",
  sessions: [{ session_id: "ses_onDevbox01", machine_id: "devbox", label: "pigeon", updated_at: 42 }],
  machines: [{ machine_id: "devbox", relay: "available", last_poll_at: 40 }],
  truncated: false,
};

describe("GET /swarm/remote-sessions", () => {
  let storage: StorageDb | null = null;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  const get = (app: ReturnType<typeof createApp>, query = "", headers: Record<string, string> = {}) =>
    app(new Request(`http://localhost/swarm/remote-sessions${query}`, { headers }));

  it("returns the worker's listing plus this daemon's relay_send flag", async () => {
    const listRemoteSessions = vi.fn().mockResolvedValue({ ok: true, listing: LISTING });
    const app = createApp(storage!, { listRemoteSessions, swarmRelaySend: true });
    const res = await get(app, "?limit=7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...LISTING, relay_send: true });
    expect(listRemoteSessions).toHaveBeenCalledWith(7, expect.any(AbortSignal));
  });

  it("relay_send is false unless the daemon was told to relay", async () => {
    const app = createApp(storage!, { listRemoteSessions: vi.fn().mockResolvedValue({ ok: true, listing: LISTING }) });
    expect(await (await get(app)).json()).toMatchObject({ relay_send: false });
  });

  it("passes no limit when none is given, and 400s a bad one without calling the worker", async () => {
    const listRemoteSessions = vi.fn().mockResolvedValue({ ok: true, listing: LISTING });
    const app = createApp(storage!, { listRemoteSessions });
    await get(app);
    expect(listRemoteSessions).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    listRemoteSessions.mockClear();
    for (const q of ["?limit=0", "?limit=-3", "?limit=abc", "?limit=1.5"]) {
      expect((await get(app, q)).status).toBe(400);
    }
    expect(listRemoteSessions).not.toHaveBeenCalled();
  });

  it("503 no_worker on a host with no worker connection", async () => {
    const res = await get(createApp(storage!, {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no_worker" });
  });

  it("502 worker_error naming the worker's status and code", async () => {
    const app = createApp(storage!, {
      listRemoteSessions: vi.fn().mockResolvedValue({ ok: false, status: 401, error: "machine_credential_required" }),
    });
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "worker_error", worker_status: 401, worker_error: "machine_credential_required" });
  });

  it("502 worker_unreachable when the call throws or times out", async () => {
    const app = createApp(storage!, { listRemoteSessions: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "worker_unreachable" });

    const hanging = createApp(storage!, {
      remoteSessionsTimeoutMs: 20,
      listRemoteSessions: (_limit: number | undefined, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    });
    const slow = await get(hanging);
    expect(slow.status).toBe(502);
    expect(await slow.json()).toMatchObject({ error: "worker_unreachable" });
  });

  it("requires the daemon bearer token like every other route", async () => {
    const app = createApp(storage!, {
      authToken: "secret",
      listRemoteSessions: vi.fn().mockResolvedValue({ ok: true, listing: LISTING }),
    });
    expect((await get(app)).status).toBe(401);
    expect((await get(app, "", { Authorization: "Bearer secret" })).status).toBe(200);
  });
});

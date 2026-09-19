import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { registerGooseSession } from "../src/goose/register-session";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";

/**
 * `POST /goose/sessions` and the helper beneath it.
 *
 * The route had NO test of any kind, so neither of the two properties its own
 * comment calls load-bearing -- the 409 that refuses to convert a session of
 * another kind, and the forced `notify: true` -- was verified by anything.
 *
 * It now also carries the id split: the body's `session_id` is GOOSE's name for
 * the session (`YYYYMMDD_N`, a per-machine counter that collides across
 * machines), while pigeon mints and returns its own.
 */
describe("POST /goose/sessions", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now, ...opts });
  }

  function post(app: ReturnType<typeof createApp>, body: unknown) {
    return app(
      new Request("http://localhost/goose/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("mints a pigeon id of its own rather than reusing goose's", async () => {
    const app = newApp();
    const res = await post(app, { session_id: "20260920_1", endpoint: "ws://127.0.0.1:1/acp" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, string>;

    // The returned id must NOT be goose's, or two machines registering their
    // own first-session-of-the-day would collide in the worker's global table.
    expect(json.session_id).not.toBe("20260920_1");
    expect(json.session_id!.startsWith("gse_")).toBe(true);
    expect(json.backend_session_id).toBe("20260920_1");

    const row = storage!.sessions.get(json.session_id!);
    expect(row?.backendSessionId).toBe("20260920_1");
    expect(row?.backendKind).toBe(GOOSE_BACKEND_KIND);
  });

  /**
   * With notify=false the /stop route returns early, so the human never hears a
   * turn finish -- which is indistinguishable from a broken adapter. The route
   * forces it true, and must keep doing so even when asked for the opposite.
   */
  it("forces notify on, even when the body asks for notify=false", async () => {
    const app = newApp();
    const res = await post(app, {
      session_id: "20260920_1",
      endpoint: "ws://127.0.0.1:1/acp",
      notify: false,
    });
    const json = (await res.json()) as Record<string, string>;
    expect(storage!.sessions.get(json.session_id!)?.notify).toBe(true);
  });

  it("refuses to convert a session of another kind, rather than hijacking it", async () => {
    const app = newApp();
    storage!.sessions.upsert({ sessionId: "ses_opencode", backendKind: null }, 1_000);

    const res = await post(app, { session_id: "ses_opencode", endpoint: "ws://127.0.0.1:1/acp" });
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, string>).error).toContain("refusing to convert");

    // And the existing session is untouched -- a refusal that still wrote would
    // be worse than no guard at all.
    const row = storage!.sessions.get("ses_opencode");
    expect(row?.backendKind).toBeNull();
    expect(row?.backendEndpoint).toBeNull();
  });

  it("requires both session_id and endpoint", async () => {
    const app = newApp();
    expect((await post(app, { endpoint: "ws://x/acp" })).status).toBe(400);
    expect((await post(app, { session_id: "20260920_1" })).status).toBe(400);
  });

  /**
   * The caller knows only goose's id, so a second registration of the same
   * session must land on the same pigeon row. Minting a fresh id each time
   * would leave a duplicate session behind for the human to discover.
   */
  it("is idempotent: re-registering the same goose session reuses the pigeon id", async () => {
    const app = newApp();
    const first = (await (await post(app, { session_id: "20260920_1", endpoint: "ws://a/acp" })).json()) as Record<string, string>;
    const second = (await (await post(app, { session_id: "20260920_1", endpoint: "ws://b/acp" })).json()) as Record<string, string>;

    expect(second.session_id).toBe(first.session_id);
    expect(storage!.sessions.list({}).filter((s) => s.backendKind === GOOSE_BACKEND_KIND)).toHaveLength(1);
    // ...and the re-registration still updates the endpoint, which is the
    // reason a human re-registers at all (goose restarted on a new port).
    expect(storage!.sessions.get(first.session_id!)?.backendEndpoint).toBe("ws://b/acp");
  });

  it("announces the session under the PIGEON id", async () => {
    const started: Array<{ id: string; notify: boolean }> = [];
    const app = newApp(1_000, {
      onSessionStart: (id: string, notify: boolean) => { started.push({ id, notify }); },
    });
    const json = (await (await post(app, { session_id: "20260920_1", endpoint: "ws://a/acp" })).json()) as Record<string, string>;
    // The worker registers by whatever this announces, so announcing goose's id
    // would put the colliding name into D1 -- defeating the whole change.
    expect(started).toEqual([{ id: json.session_id, notify: true }]);
  });
});

describe("registerGooseSession", () => {
  let storage: StorageDb | null = null;
  afterEach(() => {
    if (storage) { storage.db.close(); storage = null; }
  });

  /**
   * A session registered before `backend_session_id` existed has NULL there and
   * its pigeon id IS goose's id. Re-registering it must adopt that row rather
   * than mint a parallel one, or the human ends up with two rows for one
   * session -- one of which no longer receives updates.
   */
  it("adopts a legacy row whose pigeon id is goose's id", () => {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId: "20260918_1", backendKind: GOOSE_BACKEND_KIND, backendEndpoint: "ws://old/acp" },
      1_000,
    );

    const res = registerGooseSession(
      storage.sessions,
      { backendSessionId: "20260918_1", endpoint: "ws://new/acp" },
      2_000,
    );

    expect(res).toMatchObject({ ok: true, sessionId: "20260918_1", reused: true });
    // Backfilled in place, so the row is no longer ambiguous.
    expect(storage.sessions.get("20260918_1")?.backendSessionId).toBe("20260918_1");
  });

  it("does not match a pigeon id against the backend-id column", () => {
    storage = openStorageDb(":memory:");
    registerGooseSession(
      storage.sessions,
      { backendSessionId: "20260920_1", endpoint: "ws://a/acp" },
      1_000,
      () => "gse_fixed",
    );
    // Looking a PIGEON id up as a backend id must miss. If this ever matched,
    // the two namespaces would be one again.
    expect(storage.sessions.getByBackendSessionId("gse_fixed")).toBeNull();
    expect(storage.sessions.getByBackendSessionId("20260920_1")?.sessionId).toBe("gse_fixed");
  });
});

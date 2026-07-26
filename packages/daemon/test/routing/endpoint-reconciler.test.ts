/**
 * Registry endpoint fencing, pigeon side (bead pigeon-13p).
 *
 * Regression cover for the 2026-07-25 cloudbox incident: a throwaway
 * `opencode serve` that inherited OPENCODE_SERVE_ID + OPENCODE_ROUTING_DB
 * registered itself into slot serve-1 and rewrote serve_instance.endpoint to
 * the random high port it happened to bind. 76 sessions were routed to a closed
 * port and it was UNHEALABLE: the real serve kept refreshing heartbeat_at and
 * health_state='healthy' on the same row, and seedServes/insertStubIfAbsent uses
 * ON CONFLICT DO NOTHING so PIGEON_SERVE_ENDPOINTS could never correct it — not
 * even across a daemon restart.
 *
 * The fix makes the configured pool endpoints authoritative, continuously.
 */
import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { seedServes, serveIdForIndex } from "../../src/routing/serve-registry";
import {
  reconcileServeEndpoints,
  ServeEndpointReconciler,
} from "../../src/routing/endpoint-reconciler";
import type { ServeInstanceRecord } from "../../src/routing/types";

const POOL = ["http://127.0.0.1:4096", "http://127.0.0.1:4097"];

/** The exact shape of the hijacked row as observed in production on 2026-07-25:
 *  a rogue endpoint AND a rogue instance_uuid, but a fresh heartbeat,
 *  health_state='healthy', draining=0 and a matching binary_epoch — i.e. a row
 *  that every existing liveness check considers perfectly fine. */
function hijackedRow(overrides: Partial<ServeInstanceRecord> = {}): ServeInstanceRecord {
  return {
    serveId: "serve-1",
    instanceUuid: "688b827e-rogue",
    endpoint: "http://127.0.0.1:47037",
    binaryEpoch: 7,
    healthState: "healthy",
    heartbeatAt: 1_000_000,
    draining: false,
    ...overrides,
  };
}

describe("serveIdForIndex", () => {
  // DM5-4 drift firewall: seedServes mints serve ids from PIGEON_SERVE_ENDPOINTS
  // order, and the reconciler must address the SAME slot for the same index or
  // it would reassert serve-0's endpoint onto serve-1.
  it("agrees with the ids seedServes actually writes", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);

    expect(serveIdForIndex(0)).toBe("serve-0");
    expect(serveIdForIndex(1)).toBe("serve-1");
    for (let i = 0; i < POOL.length; i++) {
      const row = s.serves.get(serveIdForIndex(i));
      expect(row, `slot ${i} must exist under serveIdForIndex(${i})`).not.toBeNull();
      expect(row!.endpoint).toBe(POOL[i]);
    }

    s.db.close();
  });
});

describe("ServeInstanceRepo.reassertEndpoint", () => {
  it("rewrites ONLY the endpoint column and leaves every other column byte-identical", () => {
    const s = openStorageDb(":memory:");
    const before = hijackedRow();
    s.serves.upsert(before);

    const changed = s.serves.reassertEndpoint(
      "serve-1",
      "http://127.0.0.1:4097",
      before.endpoint,
    );

    expect(changed).toBe(true);
    // The whole point of the endpoint-column-only rule: rewriting instance_uuid
    // from pigeon's side is what breaks the serve's own lease CAS (changes=0 ->
    // Effect.die -> HTTP 500 on every prompt). A full-row reassert would
    // recreate that damage from pigeon's own hand on every tick.
    expect(s.serves.get("serve-1")).toEqual({
      ...before,
      endpoint: "http://127.0.0.1:4097",
    });

    s.db.close();
  });

  it("is fenced on the observed previous value: a concurrent change wins and we no-op", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(hijackedRow());

    // We read ":47037", but a real registerSelf landed ":4097" before our UPDATE.
    // Reasserting must not clobber the newer value.
    s.serves.reassertEndpoint("serve-1", "http://127.0.0.1:4097", "http://127.0.0.1:47037");
    const changed = s.serves.reassertEndpoint(
      "serve-1",
      "http://127.0.0.1:9999",
      "http://127.0.0.1:47037",
    );

    expect(changed).toBe(false);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");

    s.db.close();
  });

  it("reports no change for an absent serve_id instead of inserting a row", () => {
    const s = openStorageDb(":memory:");

    const changed = s.serves.reassertEndpoint("serve-9", "http://127.0.0.1:4105", "whatever");

    expect(changed).toBe(false);
    expect(s.serves.get("serve-9")).toBeNull();

    s.db.close();
  });
});

describe("reconcileServeEndpoints", () => {
  it("repairs the hijacked endpoint and reports the drift", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow());

    const drifts = reconcileServeEndpoints(s.serves, POOL);

    expect(drifts).toEqual([
      {
        serveId: "serve-1",
        configured: "http://127.0.0.1:4097",
        found: "http://127.0.0.1:47037",
      },
    ]);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");
    s.db.close();
  });

  it("preserves the hijacked instance_uuid — repairing it is NOT pigeon's job", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow());

    reconcileServeEndpoints(s.serves, POOL);

    // Only the serve's own registerSelf may write instance_uuid. Pigeon minting a
    // fresh uuid here would break the live serve's lease CAS on every tick.
    const row = s.serves.get("serve-1")!;
    expect(row.instanceUuid).toBe("688b827e-rogue");
    expect(row.healthState).toBe("healthy");
    expect(row.heartbeatAt).toBe(1_000_000);
    expect(row.binaryEpoch).toBe(7);
    expect(row.draining).toBe(false);

    s.db.close();
  });

  it("is a no-op with no drift when every endpoint already matches config", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    const before = [s.serves.get("serve-0"), s.serves.get("serve-1")];

    expect(reconcileServeEndpoints(s.serves, POOL)).toEqual([]);
    expect([s.serves.get("serve-0"), s.serves.get("serve-1")]).toEqual(before);

    s.db.close();
  });

  it("does not create rows for configured slots that have no row yet (seedServes owns creation)", () => {
    const s = openStorageDb(":memory:");

    expect(reconcileServeEndpoints(s.serves, POOL)).toEqual([]);
    expect(s.serves.get("serve-0")).toBeNull();
    expect(s.serves.get("serve-1")).toBeNull();

    s.db.close();
  });

  it("leaves serve rows outside the configured pool alone (shrinking K must not touch them)", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    const orphan = hijackedRow({ serveId: "serve-3", endpoint: "http://127.0.0.1:4099" });
    s.serves.upsert(orphan);

    // Pool shrank to K=1; serve-1 and serve-3 are no longer configured.
    const drifts = reconcileServeEndpoints(s.serves, [POOL[0]!]);

    expect(drifts).toEqual([]);
    expect(s.serves.get("serve-3")).toEqual(orphan);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");

    s.db.close();
  });

  it("repairs a drifted DRAINING slot too — a hijack leaves draining=0 but repair must not depend on it", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow({ draining: true }));

    const drifts = reconcileServeEndpoints(s.serves, POOL);

    expect(drifts).toHaveLength(1);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");
    expect(s.serves.get("serve-1")!.draining).toBe(true);

    s.db.close();
  });

  it("reports every drifted slot when more than one is hijacked", () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow({ serveId: "serve-0", endpoint: "http://127.0.0.1:47611" }));
    s.serves.upsert(hijackedRow());

    const drifts = reconcileServeEndpoints(s.serves, POOL);

    expect(drifts.map((d: { serveId: string }) => d.serveId)).toEqual(["serve-0", "serve-1"]);
    expect(s.serves.get("serve-0")!.endpoint).toBe("http://127.0.0.1:4096");
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");

    s.db.close();
  });
});

describe("ServeEndpointReconciler", () => {
  function make(
    endpoints: readonly string[] = POOL,
    opts: { alertCooldownMs?: number; machineId?: string } = {},
  ) {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, endpoints, 1000);
    const sendPlainAlert = vi.fn(async () => {});
    const log = vi.fn();
    let now = 10_000;
    const reconciler = new ServeEndpointReconciler({
      serves: s.serves,
      endpoints,
      notifier: { sendPlainAlert },
      log,
      nowFn: () => now,
      alertCooldownMs: opts.alertCooldownMs,
      machineId: opts.machineId,
    });
    return {
      s,
      reconciler,
      sendPlainAlert,
      log,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("alerts on drift with the found and reasserted endpoints in the text", async () => {
    const { s, reconciler, sendPlainAlert } = make(POOL, { machineId: "cloudbox" });
    s.serves.upsert(hijackedRow());

    const drifts = await reconciler.tick();

    expect(drifts).toHaveLength(1);
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    const [text, severity] = sendPlainAlert.mock.calls[0] as unknown as [string, string];
    expect(severity).toBe("error");
    expect(text).toContain("serve-1");
    expect(text).toContain("http://127.0.0.1:47037");
    expect(text).toContain("http://127.0.0.1:4097");
    expect(text).toContain("cloudbox");

    s.db.close();
  });

  it("stays silent when there is no drift", async () => {
    const { s, reconciler, sendPlainAlert } = make();

    expect(await reconciler.tick()).toEqual([]);
    expect(sendPlainAlert).not.toHaveBeenCalled();

    s.db.close();
  });

  it("does not re-alert for the same slot inside the cooldown", async () => {
    const { s, reconciler, sendPlainAlert, advance } = make(POOL, { alertCooldownMs: 600_000 });

    s.serves.upsert(hijackedRow());
    await reconciler.tick();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Re-hijacked 1 minute later: repaired again, but not re-alerted.
    advance(60_000);
    s.serves.upsert(hijackedRow());
    const drifts = await reconciler.tick();

    expect(drifts).toHaveLength(1);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    s.db.close();
  });

  it("re-alerts for the same slot once the cooldown has elapsed", async () => {
    const { s, reconciler, sendPlainAlert, advance } = make(POOL, { alertCooldownMs: 600_000 });

    s.serves.upsert(hijackedRow());
    await reconciler.tick();

    advance(600_001);
    s.serves.upsert(hijackedRow());
    await reconciler.tick();

    expect(sendPlainAlert).toHaveBeenCalledTimes(2);

    s.db.close();
  });

  it("cools down per slot, so a second slot's first hijack still alerts immediately", async () => {
    const { s, reconciler, sendPlainAlert } = make(POOL, { alertCooldownMs: 600_000 });

    s.serves.upsert(hijackedRow());
    await reconciler.tick();
    s.serves.upsert(hijackedRow({ serveId: "serve-0", endpoint: "http://127.0.0.1:47611" }));
    await reconciler.tick();

    expect(sendPlainAlert).toHaveBeenCalledTimes(2);
    expect((sendPlainAlert.mock.calls[1] as unknown as [string])[0]).toContain("serve-0");

    s.db.close();
  });

  it("still repairs when the alert throws — detection must never block the repair", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow());
    const log = vi.fn();
    const reconciler = new ServeEndpointReconciler({
      serves: s.serves,
      endpoints: POOL,
      notifier: {
        sendPlainAlert: async () => {
          throw new Error("telegram down");
        },
      },
      log,
    });

    const drifts = await reconciler.tick();

    expect(drifts).toHaveLength(1);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");
    expect(log.mock.calls.some(([m]) => String(m).includes("alert"))).toBe(true);

    s.db.close();
  });

  it("repairs with no notifier wired at all", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, POOL, 1000);
    s.serves.upsert(hijackedRow());
    const reconciler = new ServeEndpointReconciler({ serves: s.serves, endpoints: POOL });

    expect(await reconciler.tick()).toHaveLength(1);
    expect(s.serves.get("serve-1")!.endpoint).toBe("http://127.0.0.1:4097");

    s.db.close();
  });

  it("safeTick NEVER rejects when the registry read throws — an unhandled rejection would kill the live daemon", async () => {
    // better-sqlite3 throws synchronously on SQLITE_BUSY ("database is locked"),
    // which really happens on this box when serves restart simultaneously. Inside
    // an async method that surfaces as a rejected promise, and Node terminates the
    // process on unhandled rejections by default. This runs in the LIVE daemon.
    const log = vi.fn();
    const exploding = {
      get: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      reassertEndpoint: () => false,
    };
    const reconciler = new ServeEndpointReconciler({
      serves: exploding,
      endpoints: POOL,
      log,
    });

    await expect(reconciler.tick()).rejects.toThrow("database is locked");
    await expect(reconciler.safeTick()).resolves.toEqual([]);
    expect(log.mock.calls.some(([m]) => String(m).includes("tick failed"))).toBe(true);
  });

  it("start() drives safeTick, so a throwing tick cannot escape the timer", async () => {
    const log = vi.fn();
    const reconciler = new ServeEndpointReconciler({
      serves: {
        get: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
        reassertEndpoint: () => false,
      },
      endpoints: POOL,
      log,
    });

    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      reconciler.start(1);
      await new Promise((r) => setTimeout(r, 30));
      reconciler.stop();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
    expect(log.mock.calls.some(([m]) => String(m).includes("tick failed"))).toBe(true);
  });

  it("logs every drift it repairs even when the alert is cooled down", async () => {
    const { s, reconciler, log, advance } = make(POOL, { alertCooldownMs: 600_000 });

    s.serves.upsert(hijackedRow());
    await reconciler.tick();
    advance(1000);
    s.serves.upsert(hijackedRow());
    await reconciler.tick();

    const driftLogs = log.mock.calls.filter(([m]) => String(m).includes("drift"));
    expect(driftLogs).toHaveLength(2);

    s.db.close();
  });
});

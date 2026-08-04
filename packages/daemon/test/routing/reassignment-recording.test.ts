/**
 * Recording of serve reassignments at the single choke point (bead pigeon-f2a).
 *
 * `placeSession` is the ONLY place `owner_generation` is ever bumped —
 * `route-repo.bumpGeneration` exists but has no callers, and
 * `reassignFromDeadServe` performs its moves by delegating to `placeSession`.
 * So instrumenting this one function captures every move in the system, and
 * there is no second path to keep in sync.
 *
 * Two properties matter more than the happy path:
 *
 *  - Only genuine MOVES are recorded. A first placement is session creation, not
 *    flapping; recording it would swamp the rate signal with normal traffic and
 *    make the alert threshold meaningless.
 *  - Recording is NON-FATAL. This runs inside live routing. SQLITE_BUSY on this
 *    shared DB is not hypothetical — it demonstrably happens when serves restart
 *    simultaneously — and an observability insert must never be able to fail a
 *    route. Losing a metric is acceptable; refusing to route a session is not.
 */
import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { IngressRouter } from "../../src/routing/router";
import type { ServeInstanceRecord } from "../../src/routing/types";

const OPTS = {
  leaseTtlMs: 5_000,
  staleServeMs: 2_000,
  idleMigrateMs: 3_000,
  dormantTtlMs: 10_000,
  activeTurnCap: 10,
};

function serve(id: string, now: number, over: Partial<ServeInstanceRecord> = {}): ServeInstanceRecord {
  return {
    serveId: id,
    instanceUuid: `uuid-${id}`,
    endpoint: `http://localhost:${8000 + Number(id.split("-")[1])}`,
    binaryEpoch: 0,
    healthState: "healthy",
    heartbeatAt: now,
    draining: false,
    ...over,
  };
}

describe("reassignment recording", () => {
  it("records a move with its origin, destination and new generation", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    const now = 10_000;

    s.serves.upsert(serve("serve-1", now));
    router.placeSession("ses_x", now);
    expect(s.reassignments.countSince(0)).toBe(0); // first placement is not a move

    // serve-1 dies, serve-2 arrives -> the next placement must relocate.
    s.serves.upsert(serve("serve-1", now, { healthState: "unhealthy" }));
    s.serves.upsert(serve("serve-2", now));
    const moved = router.placeSession("ses_x", now + 1);

    expect(moved.serveId).toBe("serve-2");
    expect(s.reassignments.countSince(0)).toBe(1);

    const top = s.reassignments.topSessionsSince(0, 5);
    expect(top).toEqual([{ sessionId: "ses_x", moves: 1, lastMoveAt: now + 1 }]);

    const row = s.db
      .prepare("SELECT session_id, from_serve_id, to_serve_id, owner_generation FROM reassignment_event")
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      session_id: "ses_x",
      from_serve_id: "serve-1",
      to_serve_id: "serve-2",
      owner_generation: 2, // must mirror the bump placeSession just committed
    });
  });

  it("records nothing when a session is re-placed on the serve it already had", () => {
    // No generation bump happens here, so no move happened. If this recorded, the
    // rate alert would fire on ordinary repeat traffic.
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    const now = 10_000;

    s.serves.upsert(serve("serve-1", now));
    router.placeSession("ses_y", now);
    router.placeSession("ses_y", now + 1);
    router.placeSession("ses_y", now + 2);

    expect(s.assignments.get("ses_y")?.ownerGeneration).toBe(1);
    expect(s.reassignments.countSince(0)).toBe(0);
  });

  it("still routes when the event insert throws", () => {
    // The non-negotiable one. A wedged metrics table must not take routing down.
    const s = openStorageDb(":memory:");
    const exploding = {
      ...s,
      reassignments: {
        record() {
          throw new Error("database is locked");
        },
      },
    } as unknown as ConstructorParameters<typeof IngressRouter>[0];

    const router = new IngressRouter(exploding, OPTS);
    const now = 10_000;

    s.serves.upsert(serve("serve-1", now));
    router.placeSession("ses_z", now);
    s.serves.upsert(serve("serve-1", now, { healthState: "unhealthy" }));
    s.serves.upsert(serve("serve-2", now));

    const moved = router.placeSession("ses_z", now + 1);
    expect(moved.serveId).toBe("serve-2");
    expect(s.assignments.get("ses_z")?.ownerGeneration).toBe(2);
  });

  it("routes normally when no recorder is wired at all", () => {
    // The recorder is optional so that hand-built repo objects elsewhere in the
    // suite keep working. Optional must mean optional, not "throws on undefined".
    const s = openStorageDb(":memory:");
    const withoutRecorder = {
      serves: s.serves,
      assignments: s.assignments,
      leases: s.leases,
      meta: s.meta,
    };
    const router = new IngressRouter(withoutRecorder, OPTS);
    const now = 10_000;

    s.serves.upsert(serve("serve-1", now));
    router.placeSession("ses_w", now);
    s.serves.upsert(serve("serve-1", now, { healthState: "unhealthy" }));
    s.serves.upsert(serve("serve-2", now));

    expect(() => router.placeSession("ses_w", now + 1)).not.toThrow();
    expect(s.assignments.get("ses_w")?.ownerGeneration).toBe(2);
  });
});

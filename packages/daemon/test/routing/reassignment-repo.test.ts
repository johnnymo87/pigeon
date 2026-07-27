/**
 * Reassignment event log (bead pigeon-f2a, increment 1 of the pigeon-u1u arc).
 *
 * WHY A TABLE AND NOT JUST A COUNTER
 *
 * `session_assignment.owner_generation` is today the ONLY durable trace that a
 * session was ever moved between serves. It is how the June flapping regression
 * was eventually root-caused, and the numbers were grim: 407 assignments carrying
 * 2634 cumulative moves, one session moved 24 times, and on 2026-06-23 every one
 * of 59 assignments sat at generation >= 10. Four in-flight turns were killed.
 *
 * The counter alone cannot support an alert, for two reasons:
 *
 *  1. IT CANNOT BE DATED. `session_assignment.updated_at` is churned by
 *     `touchActive` (route-repo.ts:248) and `setDormantFenced` (:273) on totally
 *     unrelated events, so "generation is 12" carries no information about
 *     WHEN those 12 moves happened. Twelve moves over three months is healthy;
 *     twelve in ten minutes is the incident. The counter cannot tell them apart.
 *  2. IT IS LOSSY. It records only how many times, never from where to where.
 *
 * So we log the transitions themselves, timestamped. That makes the alert a
 * question about RATE — which is the only formulation that is not hopelessly
 * confounded, because generation also bumps for entirely legitimate reasons: the
 * bounded-load skip (router.ts:172-178, activeTurnCap=25) and a pool restart,
 * which moves every session on a serve at once and is a normal deploy.
 *
 * SCHEMA SAFETY: this table is defined in its own DDL string, NOT in ROUTING_DDL.
 * The routing DB is shared with the serve pool, which validates
 * `routing_meta.ddl_checksum` against a compiled-in constant, so touching
 * ROUTING_DDL crash-loops every serve. A separate string costs nothing. The last
 * test in this file is what enforces that, and route-schema.test.ts guards the
 * digest itself.
 */
import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initRouteSchema } from "../../src/routing/route-schema";
import {
  initReassignmentSchema,
  ReassignmentEventRepo,
} from "../../src/routing/reassignment-repo";

function freshDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  initRouteSchema(db);
  initReassignmentSchema(db);
  return db;
}

const T0 = 1_700_000_000_000;

describe("initReassignmentSchema", () => {
  it("does not disturb the checksum the serve pool validates against", () => {
    // The entire reason this table lives outside ROUTING_DDL. If this ever fails,
    // every `opencode serve` throws SchemaMismatchError at startup.
    const db = new BetterSqlite3(":memory:");
    initRouteSchema(db);
    const before = db
      .prepare("SELECT ddl_checksum FROM routing_meta WHERE id = 1")
      .get() as { ddl_checksum: string };

    initReassignmentSchema(db);

    const after = db
      .prepare("SELECT ddl_checksum FROM routing_meta WHERE id = 1")
      .get() as { ddl_checksum: string };
    expect(after.ddl_checksum).toBe(before.ddl_checksum);
  });

  it("is idempotent, because it runs on every daemon boot", () => {
    const db = freshDb();
    expect(() => initReassignmentSchema(db)).not.toThrow();
  });
});

describe("ReassignmentEventRepo.countSince", () => {
  it("counts only moves inside the window", () => {
    const repo = new ReassignmentEventRepo(freshDb());
    repo.record({ sessionId: "ses_a", fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: 2, at: T0 - 60_000 });
    repo.record({ sessionId: "ses_b", fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: 2, at: T0 - 10_000 });
    repo.record({ sessionId: "ses_c", fromServeId: "serve-1", toServeId: "serve-0", ownerGeneration: 3, at: T0 - 1_000 });

    // A rate alert that counted the whole table would fire once and then never
    // stop firing, because history only grows. The window is the mechanism.
    expect(repo.countSince(T0 - 30_000)).toBe(2);
  });

  it("returns zero on an empty log rather than throwing", () => {
    expect(new ReassignmentEventRepo(freshDb()).countSince(0)).toBe(0);
  });
});

describe("ReassignmentEventRepo.topSessionsSince", () => {
  it("ranks by move count so the alert can name the worst offender", () => {
    const repo = new ReassignmentEventRepo(freshDb());
    for (let i = 0; i < 5; i++) {
      repo.record({ sessionId: "ses_hot", fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: i + 2, at: T0 - 5_000 + i });
    }
    repo.record({ sessionId: "ses_cold", fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: 2, at: T0 - 4_000 });

    const top = repo.topSessionsSince(T0 - 30_000, 10);
    expect(top[0]).toEqual({ sessionId: "ses_hot", moves: 5 });
    expect(top[1]).toEqual({ sessionId: "ses_cold", moves: 1 });
  });

  it("distinguishes one session thrashing from a pool restart moving many sessions once", () => {
    // This is the single most important discrimination the detector makes.
    // A pool restart legitimately moves EVERY session exactly once and must not
    // alert; one session bouncing repeatedly is the pathology that killed four
    // turns in June. Both produce identical totals, so totals alone are useless.
    const restart = new ReassignmentEventRepo(freshDb());
    for (let i = 0; i < 8; i++) {
      restart.record({ sessionId: `ses_${i}`, fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: 2, at: T0 - 1_000 });
    }

    const thrash = new ReassignmentEventRepo(freshDb());
    for (let i = 0; i < 8; i++) {
      thrash.record({ sessionId: "ses_stuck", fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: i + 2, at: T0 - 1_000 });
    }

    expect(restart.countSince(T0 - 30_000)).toBe(thrash.countSince(T0 - 30_000));
    expect(restart.topSessionsSince(T0 - 30_000, 1)[0]!.moves).toBe(1);
    expect(thrash.topSessionsSince(T0 - 30_000, 1)[0]!.moves).toBe(8);
  });

  it("honours the limit so a wide incident cannot produce an unbounded alert body", () => {
    const repo = new ReassignmentEventRepo(freshDb());
    for (let i = 0; i < 50; i++) {
      repo.record({ sessionId: `ses_${i}`, fromServeId: null, toServeId: "serve-1", ownerGeneration: 2, at: T0 });
    }
    expect(repo.topSessionsSince(T0 - 1, 3)).toHaveLength(3);
  });
});

describe("ReassignmentEventRepo.pruneBefore", () => {
  it("evicts old rows so an append-only log cannot grow without bound", () => {
    const repo = new ReassignmentEventRepo(freshDb());
    repo.record({ sessionId: "ses_old", fromServeId: null, toServeId: "serve-1", ownerGeneration: 2, at: T0 - 90_000 });
    repo.record({ sessionId: "ses_new", fromServeId: null, toServeId: "serve-1", ownerGeneration: 2, at: T0 });

    expect(repo.pruneBefore(T0 - 1_000)).toBe(1);
    expect(repo.countSince(0)).toBe(1);
  });
});

describe("ReassignmentEventRepo.record", () => {
  it("tolerates a null fromServeId", () => {
    // The recorder in `placeSession` only ever logs genuine MOVES, so in practice
    // `fromServeId` is always known — a session's first placement is not a move
    // and is deliberately not recorded (see reassignment-recording.test.ts).
    // The column stays nullable so a future caller that lacks the origin can
    // still contribute a row rather than being forced to invent one.
    const repo = new ReassignmentEventRepo(freshDb());
    expect(() =>
      repo.record({ sessionId: "ses_new", fromServeId: null, toServeId: "serve-0", ownerGeneration: 1, at: T0 }),
    ).not.toThrow();
  });
});

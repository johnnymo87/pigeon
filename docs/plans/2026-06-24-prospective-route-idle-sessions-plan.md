# Prospective `/route` for idle sessions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make pigeon's `GET /route` return a read-only *prospective* serve for idle (lease-expired but real) sessions so idle `opencode attach` TUIs distribute across the pool by HRW instead of all falling back to `:4096`.

**Architecture:** Add `IngressRouter.resolveProspectiveRoute()` (pure reads). The `/route` handler becomes `resolveRoute() ?? resolveProspectiveRoute()`. Prospective is gated on the persisted **assignment** existing, then (in order) honors a still-valid lease's serve, else the assigned serve if healthy, else a fresh `pickServe()` HRW re-pick over the healthy pool, else `null`. To make "assignment exists" a true *live-session* discriminator, assignments are now deleted on session delete/reap. Garbage/deleted sids and an empty healthy pool yield `null` → 404 → consumers fall back to `:4096`.

**Tech Stack:** TypeScript, Node + tsx, vitest, better-sqlite3. Daemon package: `packages/daemon`. Design doc: `docs/plans/2026-06-24-prospective-route-idle-sessions-design.md`. Review: `/tmp/boi9-adversarial-review.md`.

**Tracking bead:** `workstation-boi9`.

---

### Task 0: Worktree + branch

```bash
cd ~/projects/pigeon
git worktree add -b boi9-prospective-route .worktrees/boi9-prospective-route main
cd .worktrees/boi9-prospective-route
npm install   # only if node_modules isn't shared; skip if vitest already runs
```

Verify baseline green: `npm --workspace packages/daemon run test` → PASS.

---

### Task 1: Add `prospective` flag to `RouteResult`

**Files:** Modify `packages/daemon/src/routing/types.ts`.

**Step 1:** Append to the `RouteResult` interface:

```ts
  /** True only for a read-only prospective route (idle session, no lease held). */
  prospective?: boolean;
```

**Step 2:** `npm --workspace packages/daemon run typecheck` → PASS.

**Step 3:** Commit.
```bash
git add packages/daemon/src/routing/types.ts
git commit -m "feat(routing): add optional RouteResult.prospective flag"
```

---

### Task 2: `SessionAssignmentRepo.delete` (TDD)

**Files:** Modify `packages/daemon/src/routing/route-repo.ts`; Test `packages/daemon/test/routing/route-repo.test.ts`.

**Step 1: Failing test.** Append to the assignment section of `route-repo.test.ts` (mirror the file's existing `openStorageDb(":memory:")` setup):

```ts
it("assignments.delete removes the row", () => {
  const s = openStorageDb(":memory:");
  const now = 1000;
  s.assignments.upsert({
    sessionId: "ses_del", directoryKey: null, desiredServeId: "serve-0",
    ownerGeneration: 1, state: "dormant", lastActiveAt: now, updatedAt: now,
  });
  expect(s.assignments.get("ses_del")).not.toBeNull();
  s.assignments.delete("ses_del");
  expect(s.assignments.get("ses_del")).toBeNull();
  // Idempotent: deleting a missing row does not throw.
  expect(() => s.assignments.delete("ses_missing")).not.toThrow();
});
```

**Step 2:** Run `npm --workspace packages/daemon run test -- route-repo.test.ts` → FAIL (`delete` not a function).

**Step 3: Implement.** Add to `SessionAssignmentRepo` (after `get`, near `upsert`):

```ts
  delete(sessionId: string): void {
    this.db.prepare("DELETE FROM session_assignment WHERE session_id = ?").run(sessionId);
  }
```

**Step 4:** Run the test → PASS.

**Step 5:** Commit.
```bash
git add packages/daemon/src/routing/route-repo.ts packages/daemon/test/routing/route-repo.test.ts
git commit -m "feat(routing): SessionAssignmentRepo.delete (workstation-boi9)"
```

---

### Task 3: Delete assignments on session delete + reap (TDD)

**Files:** Modify `packages/daemon/src/session-reaper.ts` and `packages/daemon/src/index.ts`; Test `packages/daemon/test/session-reaper.test.ts`.

**Step 1: Failing reaper test.** Append to `session-reaper.test.ts` (reuse its existing `reapStaleSessions` harness/fixtures; seed a stale session AND an assignment for it):

```ts
it("reaping a stale session deletes its routing assignment", async () => {
  // ...build storage + a stale session 'ses_stale' as the existing tests do...
  storage.assignments.upsert({
    sessionId: "ses_stale", directoryKey: null, desiredServeId: "serve-0",
    ownerGeneration: 1, state: "dormant", lastActiveAt: 0, updatedAt: 0,
  });
  await reapStaleSessions({ storage, unregisterSession: async () => {}, nowFn: () => NOW });
  expect(storage.assignments.get("ses_stale")).toBeNull();
});
```

**Step 2:** Run `npm --workspace packages/daemon run test -- session-reaper.test.ts` → FAIL (assignment still present).

**Step 3: Implement (reaper).** In `reapStaleSessions`, inside the `for (const session of stale)` loop, right after `deps.storage.sessions.delete(session.sessionId);`:

```ts
    // Drop routing state so prospective /route stops naming a serve for a reaped
    // session (keeps "assignment exists" a true live-session discriminator).
    deps.storage.assignments.delete(session.sessionId);
```

**Step 4: Implement (onSessionDelete).** In `packages/daemon/src/index.ts`, update the `onSessionDelete` callback (storage is in scope at `index.ts:34`):

```ts
  onSessionDelete: async (sessionId) => {
    // Drop the routing assignment so a deleted session can't yield a prospective
    // /route 200 (workstation-boi9).
    storage.assignments.delete(sessionId);
    if (poller) {
      await poller.unregisterSession(sessionId);
    }
  },
```

**Step 5:** Run reaper test → PASS; `npm --workspace packages/daemon run typecheck` → PASS.

**Step 6:** Commit.
```bash
git add packages/daemon/src/session-reaper.ts packages/daemon/src/index.ts packages/daemon/test/session-reaper.test.ts
git commit -m "feat: delete routing assignment on session delete/reap (workstation-boi9)"
```

---

### Task 4: `IngressRouter.resolveProspectiveRoute` (TDD)

**Files:** Modify `packages/daemon/src/routing/router.ts`; Test `packages/daemon/test/routing/router.test.ts`.

**Step 1: Write the failing tests.** Append a new `describe` to `router.test.ts` (the file already imports `openStorageDb`, `pickServe`, `IngressRouter`, `ServeInstanceRecord`):

```ts
describe("resolveProspectiveRoute (idle prospective routing)", () => {
  const OPTS = { leaseTtlMs: 5000, staleServeMs: 2000, idleMigrateMs: 3000, dormantTtlMs: 10000, activeTurnCap: 10 };
  const now = 100_000;

  type S = ReturnType<typeof openStorageDb>;
  const seedServe = (s: S, id: string, endpoint: string, opts: { healthy?: boolean; epoch?: number; draining?: boolean; heartbeatAt?: number } = {}) =>
    s.serves.upsert({
      serveId: id, instanceUuid: `uuid-${id}`, endpoint,
      binaryEpoch: opts.epoch ?? 0,
      healthState: opts.healthy === false ? "unhealthy" : "healthy",
      heartbeatAt: opts.heartbeatAt ?? now, draining: opts.draining ?? false,
    });
  const seedAssignment = (s: S, sid: string, serveId: string, state: "assigned" | "dormant" = "dormant") =>
    s.assignments.upsert({ sessionId: sid, directoryKey: null, desiredServeId: serveId, ownerGeneration: 1, state, lastActiveAt: now, updatedAt: now });

  it("REAL dormant path: placeSession -> expire -> sweep -> prospective 200", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    router.placeSession("session-x", now);
    // Keep the serve fresh but let the lease expire, then sweep to dormant.
    const later = now + OPTS.leaseTtlMs + 1;
    s.serves.setHealth("serve-1", "healthy", later);   // fresh heartbeat
    router.sweep(later);
    expect(router.resolveRoute("session-x", later)).toBeNull();
    expect(s.assignments.get("session-x")?.state).toBe("dormant");
    const r = router.resolveProspectiveRoute("session-x", later)!;
    expect(r.serveId).toBe("serve-1");
    expect(r.prospective).toBe(true);
    expect(r.expiresAt).toBe(0);
  });

  it("idle, assigned serve healthy -> assignment serve, no writes", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    seedAssignment(s, "ses_a", "serve-1");
    expect(router.resolveRoute("ses_a", now)).toBeNull();
    const r = router.resolveProspectiveRoute("ses_a", now)!;
    expect(r.serveId).toBe("serve-1");
    expect(r.apiBase).toBe("http://localhost:8001");
    expect(r.eventUrl).toBe("http://localhost:8001/event?session_ids=ses_a");
    expect(r.prospective).toBe(true);
    expect(s.leases.get("ses_a")).toBeNull();
    expect(s.assignments.get("ses_a")?.desiredServeId).toBe("serve-1");
  });

  it("lease-honor: unexpired lease but stale-heartbeat serve -> returns lease serve (not a re-pick)", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    // Owner serve heartbeat is stale (CPU stall) -> isServeHealthy false -> resolveRoute null.
    seedServe(s, "serve-0", "http://localhost:8000", { heartbeatAt: now - OPTS.staleServeMs - 1 });
    seedServe(s, "serve-1", "http://localhost:8001"); // a healthy alternative that a re-pick MIGHT choose
    seedAssignment(s, "ses_b", "serve-0", "assigned");
    // A still-valid, current-epoch lease on serve-0 proves it is alive.
    s.leases.acquireCAS({ sessionId: "ses_b", serveId: "serve-0", instanceUuid: "uuid-serve-0", ownerGeneration: 1, binaryEpoch: 0 }, now, OPTS.leaseTtlMs);
    expect(router.resolveRoute("ses_b", now)).toBeNull();   // null because serve heartbeat stale
    const r = router.resolveProspectiveRoute("ses_b", now)!;
    expect(r.serveId).toBe("serve-0");                       // honored the live owner, did NOT re-point to serve-1
  });

  it("never-placed sid -> null; deleted sid (assignment removed) -> null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    expect(router.resolveProspectiveRoute("ses_ghost", now)).toBeNull();
    seedAssignment(s, "ses_gone", "serve-1");
    s.assignments.delete("ses_gone");
    expect(router.resolveProspectiveRoute("ses_gone", now)).toBeNull();
  });

  it("assigned serve dead + multiple healthy -> true HRW re-pick over the healthy pool", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-0", "http://localhost:8000", { healthy: false }); // dead, assigned
    seedServe(s, "serve-1", "http://localhost:8001");
    seedServe(s, "serve-2", "http://localhost:8002");
    seedServe(s, "serve-3", "http://localhost:8003");
    seedAssignment(s, "ses_c", "serve-0");
    const r = router.resolveProspectiveRoute("ses_c", now)!;
    expect(r.serveId).toBe(pickServe("ses_c", ["serve-1", "serve-2", "serve-3"]));
    expect(r.serveId).not.toBe("serve-0");
  });

  it("assigned serve dead + no other healthy serve -> null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-0", "http://localhost:8000", { healthy: false });
    seedAssignment(s, "ses_d", "serve-0");
    expect(router.resolveProspectiveRoute("ses_d", now)).toBeNull();
  });

  it("wrong-epoch assigned serve -> never returns a stale-epoch serve", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    // meta epoch defaults to 0; seed assigned serve at epoch 1 (stale) and a current-epoch alt.
    seedServe(s, "serve-old", "http://localhost:8000", { epoch: 1 });
    seedServe(s, "serve-new", "http://localhost:8001", { epoch: 0 });
    seedAssignment(s, "ses_e", "serve-old");
    const r = router.resolveProspectiveRoute("ses_e", now);
    if (r) expect(r.serveId).toBe("serve-new");
    else expect(r).toBeNull(); // acceptable if pool empty at current epoch
  });

  it("ignores assignment.state: 'assigned' + expired lease -> 200", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    seedAssignment(s, "ses_f", "serve-1", "assigned"); // not dormant, no lease
    expect(router.resolveProspectiveRoute("ses_f", now)!.serveId).toBe("serve-1");
  });
});
```

> Note: verify the exact `leases.acquireCAS(...)` signature in `route-repo.ts` (~line 280) when writing the lease-honor test; adjust the token object/args to match.

**Step 2:** Run `npm --workspace packages/daemon run test -- router.test.ts` → FAIL (`resolveProspectiveRoute` undefined).

**Step 3: Implement.** In `router.ts`, add immediately after `resolveRoute` (`pickServe` and `ServeInstanceRecord` are already imported):

```ts
  /**
   * Read-only PROSPECTIVE route for an IDLE session (resolveRoute returned null
   * because no valid+healthy lease is held). Predicts the serve the session will
   * (re)activate on so an idle TUI's stream is pre-positioned, instead of all
   * idle TUIs piling onto the default serve. Performs NO writes.
   *
   * Order: (gate) assignment must exist — a never-placed/deleted/garbage sid
   * returns null so GET /route still 404s (no phantom route; assignments are
   * deleted on session delete/reap). (1) honor a still-valid, current-epoch lease
   * on a non-draining serve — an unexpired lease proves the serve is alive even
   * if its heartbeat is stale (CPU-stalled owner), mirroring reassignFromDeadServe.
   * (2) else the assigned serve if currently healthy. (3) else a fresh HRW re-pick
   * over the healthy pool; null if empty (→ caller falls back to the default serve).
   */
  resolveProspectiveRoute(sessionId: string, now: number): RouteResult | null {
    const a = this.repos.assignments.get(sessionId);
    if (!a) {
      return null;
    }

    const epoch = this.repos.meta.get().binaryEpoch;

    const lease = this.repos.leases.get(sessionId);
    if (lease && lease.leaseExpiresAt > now && lease.binaryEpoch === epoch) {
      const leaseServe = this.repos.serves.get(lease.serveId);
      if (leaseServe && !leaseServe.draining) {
        return this.prospectiveResult(sessionId, lease.serveId, leaseServe, lease.ownerGeneration);
      }
    }

    const assigned = this.repos.serves.get(a.desiredServeId);
    if (assigned && this.isServeHealthy(assigned, now, epoch)) {
      return this.prospectiveResult(sessionId, a.desiredServeId, assigned, a.ownerGeneration);
    }

    const healthy = this.repos.serves.listHealthy(now, this.opts.staleServeMs, epoch);
    const chosen = pickServe(sessionId, healthy.map((s) => s.serveId));
    if (!chosen) {
      return null;
    }
    const chosenServe = healthy.find((s) => s.serveId === chosen)!;
    return this.prospectiveResult(sessionId, chosen, chosenServe, a.ownerGeneration);
  }

  private prospectiveResult(
    sessionId: string,
    serveId: string,
    serve: ServeInstanceRecord,
    ownerGeneration: number,
  ): RouteResult {
    return {
      sessionId,
      serveId,
      instanceUuid: serve.instanceUuid,
      ownerGeneration,
      apiBase: serve.endpoint,
      // eventUrl/expiresAt are PREDICTIONS for a prospective route (the serve may
      // not be running the session yet); no /route consumer reads eventUrl today.
      eventUrl: `${serve.endpoint}/event?session_ids=${sessionId}`,
      expiresAt: 0,
      prospective: true,
    };
  }
```

**Step 4:** Run `npm --workspace packages/daemon run test -- router.test.ts` → PASS (new block + all prior router tests green).

**Step 5:** Commit.
```bash
git add packages/daemon/src/routing/router.ts packages/daemon/test/routing/router.test.ts
git commit -m "feat(routing): resolveProspectiveRoute (lease-honor + HRW re-pick) for idle sessions (workstation-boi9)"
```

---

### Task 5: Wire `/route` handler + endpoint tests (TDD)

**Files:** Modify `packages/daemon/src/app.ts` (GET /route block ~541-561); Test `packages/daemon/test/routing/route-endpoint.test.ts`.

**Step 1: Failing endpoint tests.** Append inside `describe("GET /route endpoint", ...)`:

```ts
  it("Idle real session (dormant assignment, no lease) -> 200 prospective", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_idle1", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastActiveAt: t0, updatedAt: t0 });
    const res = await app(new Request("http://localhost/route?session_id=ses_idle1", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiBase).toBe("http://127.0.0.1:4096");
    expect(body.prospective).toBe(true);
    expect(db.leases.get("ses_idle1")).toBeNull();
  });

  it("Idle, assigned serve dead + a second healthy serve -> 200 prospective re-pick", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "unhealthy", heartbeatAt: t0, draining: false });
    db.serves.upsert({ serveId: "serve-1", instanceUuid: "u1", endpoint: "http://127.0.0.1:4097", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_idle2", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastActiveAt: t0, updatedAt: t0 });
    const res = await app(new Request("http://localhost/route?session_id=ses_idle2", { method: "GET" }));
    expect(res.status).toBe(200);
    expect((await res.json()).serveId).toBe("serve-1");
  });

  it("Deleted session (assignment removed) -> 404", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_del", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastActiveAt: t0, updatedAt: t0 });
    db.assignments.delete("ses_del");
    const res = await app(new Request("http://localhost/route?session_id=ses_del", { method: "GET" }));
    expect(res.status).toBe(404);
  });
```

**Step 2: Repurpose the existing "Unhealthy serve -> 404" test (finding #3).** Update its comment to state the 404 holds because the healthy pool is empty (single serve), and that with another healthy serve the same scenario intentionally returns a prospective re-pick (covered by the new test above). Do not weaken its assertion (still 404 with one serve).

**Step 3:** Run `npm --workspace packages/daemon run test -- route-endpoint.test.ts` → the three new tests FAIL with 404/no-prospective (handler not wired yet); existing tests still PASS.

**Step 4: Implement handler.** Replace the resolve+return in the `GET /route` block:

```ts
        // Read-only discovery. Prefer the ACTIVE route (valid lease); if the
        // session is idle (no lease), fall back to a read-only PROSPECTIVE route
        // so idle attach TUIs distribute across the pool instead of all landing
        // on the default serve. Both are null for an unknown/deleted sid -> 404
        // (no phantom route). See docs/plans/2026-06-24-prospective-route-idle-sessions-design.md.
        const now = nowFn();
        const route =
          options.router.resolveRoute(sessionId, now) ??
          options.router.resolveProspectiveRoute(sessionId, now);
        if (!route) {
          return Response.json({ error: "session not routed" }, { status: 404 });
        }
        return Response.json(route);
```

**Step 5:** Run the endpoint suite → all PASS, including verbatim: phantom-write regression (no assignment → 404, no writes), bad-id 400, missing-id 400, no-router 503, placed-session 200 (exact shape), single-serve unhealthy → 404.

**Step 6:** Commit.
```bash
git add packages/daemon/src/app.ts packages/daemon/test/routing/route-endpoint.test.ts
git commit -m "feat(app): /route falls back to prospective route for idle sessions (workstation-boi9)"
```

---

### Task 6: Full daemon gate

Run: `npm --workspace packages/daemon run test && npm --workspace packages/daemon run typecheck`
Expected: PASS, PASS. Fix minimally + commit any fixups.

---

### Task 7: Land + deploy + close bead

**Step 1:** Push + PR (or merge to `main` per pigeon convention).
```bash
git push -u origin boi9-prospective-route
# gh pr create ...  (or fast-forward merge to main)
```

**Step 2:** Deploy on cloudbox (source runs live via tsx; no build):
```bash
git -C ~/projects/pigeon pull
systemctl --user restart pigeon-daemon.service
systemctl --user is-active pigeon-daemon.service   # active
```

**Step 3:** Smoke-test live:
```bash
PIGEON=http://127.0.0.1:4731
curl -s -o /dev/null -w '%{http_code}\n' "$PIGEON/route?session_id=ses_doesnotexist0000"   # 404
for sid in <idle_sid_1> <idle_sid_2> <idle_sid_3>; do
  curl -s "$PIGEON/route?session_id=$sid" | jq -c '{apiBase, prospective}'
done   # expect 200 prospective:true, apiBase spread across 4096-4099 (not all :4096)
```

**Step 4:** Close bead + sync.
```bash
cd ~/projects/workstation
bd close workstation-boi9 --reason "Shipped pigeon prospective /route (PR <link>): resolveProspectiveRoute (assignment gate -> lease-honor -> assigned-serve -> HRW re-pick) + assignment deletion on session delete/reap. Idle sessions now spread across the pool; deleted/garbage sids still 404 (pigeon-eup preserved); empty pool/pigeon-down -> :4096 (never-worse). Deployed via pigeon-daemon restart; smoke-tested idle sids spread across 4096-4099. No opencode-patched change."
bd dolt push
git push
```

---

## Notes for the executor

- Router-level tests use bare ids (`session-*` or `ses_*` both fine); the `ses_` regex is enforced ONLY in the HTTP handler, so endpoint tests MUST use `ses_*`.
- Keep `resolveProspectiveRoute` write-free. If you reach for `placeSession`/`acquireCAS` here, stop — that is the pigeon-eup phantom-route bug.
- The assignment-existence gate MUST stay first (before lease-honor) so a deleted session — whose assignment is now removed — can never be resurfaced via a lingering unexpired lease.
- Verify `leases.acquireCAS` signature when writing the lease-honor test.
- Do not modify `resolveRoute`, `placeSession`, `activeTurnCap`, or the sticky router.
- Cross-repo coupling (do not "fix" here): "never worse than single-serve" for the A2 re-pick relies on opencode-patched `serve-lease` failing OPEN for a non-owner serve. Documented in the design; out of scope for this change.

# Prospective `/route` for idle sessions (concentration fix)

- **Date:** 2026-06-24
- **Status:** Approved (design) — revised after adversarial review (`/tmp/boi9-adversarial-review.md`)
- **Tracking bead:** `workstation-boi9` (P3 bug, in the workstation beads DB)
- **Scope:** pigeon daemon only. No `opencode-patched` / home-manager change.

## Problem

In a K-serve `opencode serve` pool sharing one `opencode.db`, only the serve
that owns a session emits its turn events on its in-memory bus. Clients discover
the owning serve via pigeon `GET /route?session_id=<sid>` and attach there,
degrading to the default serve (`:4096`) on any failure.

`GET /route` returns an `apiBase` **only for ACTIVE sessions** — those holding a
valid, non-expired lease. The chain (verified in source):

- `router.ts:59` `resolveRoute` returns `null` unless there is an assignment AND
  a healthy desired serve AND a valid non-expired lease.
- A session that goes idle has its lease expired by `sweep` (`router.ts:207`),
  which also marks the assignment **dormant** (it is NOT deleted —
  `setDormantFenced`).
- `app.ts:557` maps `resolveRoute` `null` → HTTP **404** `{error:"session not
  routed"}`. This is deliberately read-only: a placing GET re-introduced
  "phantom routes" for stale/garbage sids (bug pigeon-eup).

So `/route` collapses *idle-but-real* and *nonexistent* into one 404. Every
consumer then falls back to `:4096`, so **all idle attach TUIs concentrate their
event streams on serve-0** and never distribute across the pool. (This is what
the now-fixed reconnect leak — bead `workstation-lyj0` — amplified to ~4600
connections on serve-0.)

### Consumers of `GET /route` (all degrade-safe — audited, confirmed by review)

| Consumer | File | Behavior on non-200 | Reads `eventUrl`? |
|---|---|---|---|
| TUI `resolveServeUrl` | `opencode-patched` `packages/tui/src/util/route.ts` | branch on `res.ok`; else current url | no (builds own `sdk.global.event` stream) |
| `oc-auto-attach` | workstation `pkgs/oc-auto-attach/default.nix:250` | `parse_serve_url` → `:4096` | no |
| `opencode-launch` | workstation `pkgs/opencode-launch/default.nix:201` | `parse_serve_url` → `:4096` | no |
| `lgtm-sessions` | workstation `users/dev/home.base.nix:1066` | `parse_serve_url` → `:4096` | no |

**No consumer branches on "404 = idle"; none reads `eventUrl`.** All four read
`.apiBase` from a 200 and otherwise fall back to `:4096`. A server-side change
fixes all four at once with zero client changes.

## Goal & invariants

Spread idle real sessions across the pool by their HRW owner, while preserving:

1. **Phantom-route fix (pigeon-eup):** garbage / never-placed / **deleted** sids
   must still 404 and must create **no** durable routing state. (See "Hardening
   1" — assignments were previously never deleted, so we add deletion to make
   "assignment exists" a true *live-session* discriminator rather than merely
   *ever-placed*.)
2. **Never worse than single-serve:** pigeon down, no healthy serve, or any
   failure → consumers fall back to `:4096` (unchanged). **Cross-repo coupling
   (see "Hardening 3"):** this also relies on `opencode-patched` `serve-lease`
   failing *open* for a non-owner serve, which it does today.
3. **`/route` is read-only:** no lease acquisition, no assignment writes.

## Approach (A, with A2 dead-serve re-pick + lease-honor)

When `resolveRoute` returns `null`, fall back to a new **read-only prospective**
lookup. The persisted **assignment** is both (a) the discriminator that keeps
garbage/deleted sids 404-ing, and (b) the session's HRW owner — where it will
re-activate. The prospective serve pre-positions the idle stream correctly.

### Component 1 — `IngressRouter.resolveProspectiveRoute(sessionId, now): RouteResult | null`

New method in `router.ts`, **pure reads only** (no `leases.*` / `assignments.*`
writes). Steps, in order:

1. **Gate:** `const a = assignments.get(sessionId); if (!a) return null;`
   A never-placed / garbage / deleted sid has no assignment → `null` → 404.
   This gate runs **first**, so step 2's lease-honor can never resurface a
   deleted session (its assignment is gone — see Hardening 1).
2. **Honor a still-valid lease (review finding #4).** `const lease =
   leases.get(sessionId); if (lease && lease.leaseExpiresAt > now &&
   lease.binaryEpoch === epoch)` and `lease`'s serve exists and is not draining,
   return that serve. An unexpired current-epoch lease proves its serve is
   **alive even if its heartbeat looks stale** (single-threaded serve event loop
   blocked by a CPU-heavy turn for `> staleServeMs`) — the same rule
   `reassignFromDeadServe` uses (`router.ts:247-250`) to avoid evicting a
   live-but-busy serve. We only reach here because `resolveRoute` returned null,
   so this covers the stale-heartbeat owner and the brief mid-migration window
   without re-pointing consumers away from where the turn is actually running.
3. **Assigned serve, if healthy:** `const assigned = serves.get(a.desiredServeId);
   if (assigned && isServeHealthy(assigned, now, epoch))` → return it. This is the
   HRW owner and exactly the serve whose assignment lets a TUI-initiated prompt
   `acquire` the lease cleanly (stronger than `:4096`, which usually can't).
4. **A2 re-pick:** assigned serve dead/missing/wrong-epoch → `pickServe(sessionId,
   listHealthy(...).map(serveId))`; `null` if the healthy pool is empty (→ 404 →
   `:4096`). This *approximates* `placeSession`'s destination; it diverges under
   the `activeTurnCap` bounded-load filter and sticky-router pin, which a
   read-only predictor cannot replicate (review finding #6).

The result is built by a small private `prospectiveResult(...)` helper that sets
`prospective: true` and `expiresAt: 0`. `eventUrl` is populated for shape
consistency but is a **prediction** (the serve may not be running the session
yet); no consumer reads it (review finding #7).

> **Note on `state`:** the method intentionally ignores `AssignmentRecord.state`
> (`assigned|draining|dormant|migrating`). The condition is "assignment exists +
> no valid lease", which also covers an `assigned` assignment whose lease expired
> before the next `sweep`. Earlier "dormant" framing was imprecise (finding #8).

### Component 2 — handler wiring (`app.ts`)

```
const now = nowFn();
const route = options.router.resolveRoute(sessionId, now)
           ?? options.router.resolveProspectiveRoute(sessionId, now);
if (!route) return Response.json({ error: "session not routed" }, { status: 404 });
return Response.json(route);
```

### Component 3 — type (`types.ts`)

Add `prospective?: boolean` (optional) to `RouteResult`. The active path omits it,
so the existing "Placed session → 200" exact-shape test is unchanged.

### Hardening 1 — delete assignments on session delete/reap (review finding #1)

Today `SessionAssignmentRepo` has **no delete** and nothing deletes
`session_assignment` (the reaper deletes `storage.sessions` only;
`session-reaper.ts`). So an assignment means "*ever* placed", not "live session",
and a deleted session would yield a prospective 200. Add:

- `SessionAssignmentRepo.delete(sessionId)` (`route-repo.ts`).
- Call it in `onSessionDelete` (`index.ts`) and in `reapStaleSessions`
  (`session-reaper.ts`), alongside the existing session/unregister cleanup.

This makes the step-1 gate a true live-session discriminator and eliminates the
deleted-session-200 path. (Lingering *leases* for a deleted session are
irrelevant: the step-1 assignment gate returns `null` before the lease-honor is
reached, and leases expire on their own via `sweep`.)

### Hardening 2 — honor unexpired lease (folded into Component 1 step 2 above).

### Hardening 3 — document the serve-lease coupling (review finding #5)

"Never worse than single-serve" holds partly because `opencode-patched`
`serve-lease` `withSessionLease` fails **open** unless `assignmentExists`
(`acquire` sets `assignmentExists = assignmentRow && desired_serve_id ===
this.serveId`). A prompt submitted to an A2 re-pick serve (never the assigned
serve) finds `assignmentExists=false` → runs anyway. The A-branch points at the
assigned serve, so `acquire` succeeds. No prospective path triggers a
fail-closed rejection **as long as serve-lease keeps failing open for non-owner
serves.** If that ever changes, revisit A2. Recorded here as a cross-repo
dependency; consider a fail-open regression test in `opencode-patched`.

## Data flow & invariants

| Case | resolveRoute | prospective | HTTP | consumer attaches to |
|---|---|---|---|---|
| Active (valid lease, healthy serve) | RouteResult | (not called) | 200 | owning serve (unchanged) |
| Active, serve heartbeat stale but lease valid (CPU stall) | null | lease serve (step 2) | 200 `prospective` | the live owner (no re-point) |
| Idle, assigned serve healthy | null | assignment serve (step 3) | 200 `prospective` | HRW owner (spread) |
| Idle, assigned serve dead, pool has others | null | HRW re-pick (step 4) | 200 `prospective` | healthy HRW serve |
| Idle, no healthy serve at all | null | null | 404 | `:4096` (never-worse) |
| Never-placed / garbage / **deleted** sid | null | null (no assignment) | 404 | `:4096` (phantom-route fix) |
| Pigeon down | — | — | (curl fails) | `:4096` (never-worse) |

## Testing (vitest, existing harness)

**`test/routing/router.test.ts`** (`resolveProspectiveRoute`):
- **Real dormant path (finding #2):** `placeSession(sid, t0)` → advance past
  `leaseTtlMs` → `sweep(now)`; assert `resolveRoute` null, `resolveProspectiveRoute`
  returns 200 `prospective:true`, and `assignments.get(sid).state==='dormant'`.
- idle, assigned serve healthy → returns assignment serve.
- **lease-honor (finding #4):** valid unexpired lease but serve heartbeat stale
  (resolveRoute null) → returns the lease's serve, not a re-pick.
- never-placed sid → null; **deleted sid** (assignment deleted) → null.
- **multi-serve re-pick (findings #3, #9):** assigned serve dead + ≥2 other
  healthy serves → result `=== pickServe(sid, allHealthyIds)` (true HRW, not just
  "avoid the dead one").
- assigned serve dead + no other healthy serve → null.
- **wrong-epoch (finding #11):** assignment serve at old epoch → re-pick current
  epoch or null; never returns a stale-epoch serve.
- **ignore-state (finding #8):** `assigned` assignment + expired lease → 200.
- asserts **no** assignment/lease writes (read repos before/after).

**`test/routing/route-endpoint.test.ts`** (HTTP):
- NEW idle real session → 200 `prospective:true`, correct `apiBase`.
- NEW idle, assigned serve dead + a second healthy serve → 200 on the second.
- NEW deleted session → 404.
- KEEP phantom-write regression (never-placed → 404, no writes), bad-id 400,
  missing-id 400, no-router 503.
- **Repurpose the single-serve "unhealthy serve → 404" test (finding #3):** it now
  passes because the healthy pool is empty; rename/comment it to assert that
  explicitly, AND add the inverse (placed + owning serve unhealthy + a second
  healthy serve → 200 re-pick) to document the intentional behavior change.

**`test/routing/route-repo.test.ts`:** `assignments.delete` removes the row.
**`test/.../session-reaper*`:** a reaped stale session's assignment is deleted.

Run: `npm --workspace packages/daemon run test` and `... run typecheck`.

## Deploy

pigeon-daemon runs the source tree live via `tsx`
(`~/projects/pigeon/packages/daemon/src/index.ts`) as the user unit
`pigeon-daemon.service` on cloudbox — no build/package step. Deploy:

1. PR + merge in the **pigeon** repo (tests green).
2. On cloudbox: `git -C ~/projects/pigeon pull` then
   `systemctl --user restart pigeon-daemon.service`.
3. Effect is immediate; no opencode-patched release and no nightly-reset
   dependency. Idle attach TUIs re-resolve to their HRW serve on their next
   reconnect (and all new attaches resolve correctly at bootstrap).

## Limitations / future work (YAGNI for now)

- **Never-placed real sessions** (created but no turn ever routed, so no
  assignment) still fall back to `:4096`. Rare; extensible later with a
  `storage.sessions.get(sid)` existence check + fresh `pickServe`, but that
  widens the phantom-route surface — defer until there's evidence it's needed.
- **Prediction ≈ placement, not ==** (finding #6). The A2 re-pick can differ from
  the eventual real owner under `activeTurnCap`/sticky-pin. Acceptable: a
  mismatch still misses the same events `:4096` would, and is strictly better
  than "always `:4096`". For a *stable idle* TUI the re-resolve only fires on
  stream drop (`runSseAttempt`), so convergence is not guaranteed mid-idle — but
  the lease-honor (step 2) removes the one case (live owner, stale heartbeat)
  where that mattered.

## Out of scope

- The reconnect connection leak (bead `workstation-lyj0`, fixed in
  `opencode-patched` v1.17.7-patched.7).
- Any change to lease/placement semantics, `activeTurnCap`, or the sticky router.

# Prospective `/route` for idle sessions (concentration fix)

- **Date:** 2026-06-24
- **Status:** Approved (design)
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

### Consumers of `GET /route` (all degrade-safe — audited)

| Consumer | File | Behavior on non-200 |
|---|---|---|
| TUI `resolveServeUrl` | `opencode-patched` `packages/tui/src/util/route.ts` | fall back to current url |
| `oc-auto-attach` | workstation `pkgs/oc-auto-attach/default.nix:250` | `parse_serve_url` → `:4096` |
| `opencode-launch` | workstation `pkgs/opencode-launch/default.nix:201` | `parse_serve_url` → `:4096` |
| `lgtm-sessions` | workstation `users/dev/home.base.nix:1066` | `parse_serve_url` → `:4096` |

**No consumer branches on "404 = idle".** All four read `.apiBase` from a 200 and
otherwise fall back to `:4096`. A server-side change therefore fixes all four at
once with zero client changes.

## Goal & invariants

Spread idle real sessions across the pool by their HRW owner, while preserving:

1. **Phantom-route fix (pigeon-eup):** garbage / never-placed sids must still 404
   and must create **no** durable routing state.
2. **Never worse than single-serve:** pigeon down, no healthy serve, or any
   failure → consumers fall back to `:4096` (unchanged).
3. **`/route` is read-only:** no lease acquisition, no assignment writes.

## Approach (A, with A2 dead-serve handling)

When `resolveRoute` returns `null`, fall back to a new **read-only prospective**
lookup. The persisted dormant **assignment** is both (a) the discriminator that
keeps garbage sids 404-ing, and (b) the session's HRW owner — i.e. where it will
re-activate. The prospective serve pre-positions the idle stream correctly.

### Component 1 — `IngressRouter.resolveProspectiveRoute(sessionId, now): RouteResult | null`

New method in `router.ts`, **pure reads only**:

1. `const a = this.repos.assignments.get(sessionId); if (!a) return null;`
   → never-placed / garbage sid → `null` (preserves phantom-route fix).
2. `const epoch = this.repos.meta.get().binaryEpoch;`
3. Pick the target serve:
   - `const assigned = this.repos.serves.get(a.desiredServeId);`
   - If `assigned && this.isServeHealthy(assigned, now, epoch)` → **use it**
     (`serveId = a.desiredServeId`, `ownerGeneration = a.ownerGeneration`).
   - **Else (A2 re-pick):** the assigned serve is dead / missing / wrong-epoch
     (e.g. mid binary rollover). Compute a fresh HRW pick over the healthy pool:
     ```
     const healthy = this.repos.serves.listHealthy(now, staleServeMs, epoch);
     const chosen = pickServe(sessionId, healthy.map(s => s.serveId));
     if (!chosen) return null;            // empty pool → 404 → :4096 fallback
     const serve = healthy.find(s => s.serveId === chosen)!;
     ```
     This matches `placeSession`'s real re-pick destination. `ownerGeneration`
     is reported as `a.ownerGeneration` (informational only; `prospective:true`
     signals this is a prediction, not an owned route).
4. Return:
   ```
   { sessionId, serveId, instanceUuid: serve.instanceUuid,
     ownerGeneration, apiBase: serve.endpoint,
     eventUrl: `${serve.endpoint}/event?session_ids=${sessionId}`,
     expiresAt: 0, prospective: true }
   ```

No `leases.*` or `assignments.*` writes anywhere in this method.

### Component 2 — handler wiring (`app.ts`)

```
const route = options.router.resolveRoute(sessionId, nowFn())
           ?? options.router.resolveProspectiveRoute(sessionId, nowFn());
if (!route) return Response.json({ error: "session not routed" }, { status: 404 });
return Response.json(route);
```

### Component 3 — type (`types.ts`)

Add `prospective?: boolean` (optional) to `RouteResult`. The active path omits it,
so the existing "Placed session → 200" exact-shape test is unchanged.

## Data flow & invariants

| Case | resolveRoute | prospective | HTTP | consumer attaches to |
|---|---|---|---|---|
| Active (valid lease) | RouteResult | (not called) | 200 | owning serve (unchanged) |
| Idle, assigned serve healthy | null | assignment serve | 200 `prospective` | HRW owner (spread) |
| Idle, assigned serve dead, pool has others | null | HRW re-pick (A2) | 200 `prospective` | healthy HRW serve |
| Idle, no healthy serve at all | null | null | 404 | `:4096` (never-worse) |
| Never-placed / garbage sid | null | null (no assignment) | 404 | `:4096` (phantom-route fix) |
| Pigeon down | — | — | (curl fails) | `:4096` (never-worse) |

## Testing (vitest, existing harness)

**`test/routing/router.test.ts`** (unit, `resolveProspectiveRoute`):
- placed-then-lease-expired, serve still healthy → returns assignment serve,
  `prospective:true`.
- never-placed sid → `null`.
- assigned serve unhealthy but a *second* healthy serve exists → returns the
  HRW re-pick (A2), not the dead serve.
- assigned serve unhealthy and no other healthy serve → `null`.
- asserts **no** assignment/lease rows written (read `db.assignments.get` /
  `db.leases.get` before/after).

**`test/routing/route-endpoint.test.ts`** (HTTP):
- NEW: idle real session → 200 with `prospective:true` and correct `apiBase`.
  Setup: `router.placeSession(sid, t0)`, refresh serve heartbeat to `tNow`
  (`db.serves.setHealth(serveId,"healthy",tNow)`), build app with
  `nowFn:()=>tNow` where `tNow > t0 + leaseTtlMs` so the lease is expired but the
  serve is fresh.
- NEW: idle real session, assigned serve dead + a second healthy serve →
  200 pointing at the second serve.
- KEEP verbatim: phantom-write regression (never-placed → 404, no writes),
  bad-id 400, missing-id 400, no-router 503, and single-serve "unhealthy serve →
  404" (still 404 under A2 because the healthy pool is empty).

Run: `npm run --workspaces test` and `npm run --workspaces typecheck` (or scoped
to `packages/daemon`).

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

- **Never-placed real sessions** (session created but no turn ever routed, so no
  assignment) still fall back to `:4096`. Rare (most attached sessions ran a
  turn). If it matters, extend with a `storage.sessions.get(sid)` existence
  check + fresh `pickServe` — but that widens the phantom-route surface, so defer
  until there's evidence it's needed.
- **Prediction ≈ placement, not ==.** `placeSession` also applies a bounded-load
  `activeTurnCap` filter and consults the sticky-router pin, neither of which a
  read-only prospective lookup replicates. So the prospective serve can differ
  from the eventual real owner under load. This is acceptable: the TUI's existing
  reconnect re-resolve converges to the true owner once a lease exists, and any
  mismatch is still strictly better than today's "always `:4096`".

## Out of scope

- The reconnect connection leak (bead `workstation-lyj0`, fixed in
  `opencode-patched` v1.17.7-patched.7).
- Any change to lease/placement semantics, `activeTurnCap`, or the sticky router.

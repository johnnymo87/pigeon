# Pigeon Ingress Router (`routing/`)

Maps each opencode **session → the serve that owns it**, so that in a pool of K
`opencode serve` processes (sharing one SQLite DB) every control / query /
discovery operation — and crucially **cross-serve session→session messaging** —
reaches the right serve. Pigeon stays the single control plane (`:4731`); it is
never on the `/event` SSE byte path.

This is the **zao4** half of the pool-of-K-serves replace. Design:
`workstation/docs/plans/2026-06-19-pool-replace-design.md` (§3–§5) and the
implementation plan `…/2026-06-19-zao4-pigeon-ingress-router-plan.md`.

## Status: K=1-first

Built and verified against a **degenerate K=1 pool** (the existing single serve).
`PIGEON_SERVE_ENDPOINTS` defaults to `[OPENCODE_URL]`. Growing K→4 (a serve-pool
supervisor) and the multi-process DB-safety hardening are the separate **mn9r**
milestone (see "Deferred to mn9r" below).

## Components

| File | Role |
|------|------|
| `route-schema.ts` | `initRouteSchema(db)` — 3 tables (below), wired in `storage/database.ts`. |
| `route-repo.ts` | `ServeInstanceRepo`, `SessionAssignmentRepo`, `SessionLeaseRepo`. Hand-written SQL; **atomic, monotonic lease CAS**. |
| `rendezvous.ts` | Pure uniform **HRW** (highest-random-weight) placement: `rankServes`, `pickServe`. Minimal reshuffle on serve-set change. |
| `router.ts` | `IngressRouter` — the brain. `resolveRoute` (read-only), `placeSession`, `ensureRouted`, `touch`, `sweep`, `rebuildFromDb`, `reassignFromDeadServe`. Consumes `sticky-router` for pin/idle-migration. |
| `serve-registry.ts` | `seedServes(...)` — non-destructive seeding of `serve_instance` from configured endpoints (preserves `instance_uuid` across daemon restarts). |
| `serve-health-poller.ts` | `ServeHealthPoller` — periodic `GET <endpoint>/global/health`; marks healthy/unhealthy; reassigns sessions off a dead serve. |
| `client-factory.ts` | `OpencodeClientFactory.forSession(sessionId)` — an `OpencodeClient` bound to the owning serve (endpoint-cached). |
| `directory-resolver.ts` | `makeDirectoryResolver(...)` — read-only, pool-aware session→directory lookup (per-endpoint registry cache). |

### Tables (in the pigeon DB, alongside `sessions`/`swarm_messages`)

- `serve_instance` — the pool registry (serve_id slot, instance_uuid, endpoint, binary_epoch, health_state, heartbeat_at, draining).
- `session_assignment` — desired routing (session→serve, owner_generation, state). Durable source of truth; `rebuildFromDb()` re-seeds the in-memory stickiness from it on boot.
- `session_lease` — the exclusive right to RUN a session now (CAS-guarded; `owner_generation` is monotonic so a stale-generation "zombie" can never reacquire, even after expiry).

## `GET /route?session_id=ses_…`

**Read-only** discovery endpoint. Returns the owning serve so a client can connect
**directly** to it for the session-scoped `/event` stream (requires the opencode
`/event?session_ids=` patch, bead x8wi).

It reports a session's *current* route via `resolveRoute` (read-only); it does
**not** place/assign. A lookup for a session that has never been routed returns
`404` and leaves no `session_assignment`/`session_lease` behind. Manufacturing a
route here (the old `ensureRouted` behavior) produced phantom assignments+leases
for stale/mistyped/never-existent sids and masked the real "session not found"
condition (pigeon-eup). Placement happens on the in-process control/swarm paths
(`OpencodeClientFactory.forSession` → `ensureRouted`), not via this endpoint.

```json
{ "sessionId", "serveId", "instanceUuid", "ownerGeneration",
  "apiBase": "http://127.0.0.1:4096",
  "eventUrl": "http://127.0.0.1:4096/event?session_ids=<sid>",
  "expiresAt": <lease epoch ms> }
```
- `200` with the route JSON when the session is currently routed (assignment +
  valid lease on a healthy serve).
- `404 { "error": "session not routed" }` when the session has no current valid
  route (never placed, or its serve/lease is no longer valid). External callers
  (`oc-auto-attach`, `opencode-launch`) treat this as "fall back to `OPENCODE_URL`"
  and do their own conclusive `GET /session/<id>` existence check.
- `400` invalid/missing `session_id`; `503` when routing unconfigured.

## Cross-serve session→session messaging

`session → POST /swarm/send → swarm_messages → SwarmArbiter`. The arbiter resolves
the **target** session's owning serve (via `clientForSession` + read-only
`directoryForSession`) and `sendPrompt`s to THAT serve. Because there is exactly
one pigeon daemon shared by all serves, a session on serve A can message a session
on serve B; pigeon looks B up in the registry and forwards. Proven by
`test/routing/cross-serve-delivery.test.ts` (two real fake serves; asserts the
message lands on the target's serve and not the other, plus failover).

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `PIGEON_SERVE_ENDPOINTS` | `[OPENCODE_URL]` | Comma list of serve base URLs (the pool). Empty + no `OPENCODE_URL` ⇒ router disabled. |
| `PIGEON_LEASE_TTL_MS` | `30000` | Lease lifetime. |
| `PIGEON_SERVE_STALE_MS` | `15000` | A serve is stale (unhealthy) if no heartbeat within this window. |
| `PIGEON_HEALTH_POLL_MS` | `5000` | Health-poll + sweep interval. |
| `PIGEON_ACTIVE_TURN_CAP` | `25` | Bounded-load: skip a serve at/over this many active assignments (best-effort). |
| `PIGEON_IDLE_MIGRATE_MS` | `60000` | A pinned session migrates to its HRW target only after this idle gap. |
| `PIGEON_DORMANT_TTL_MS` | `300000` | Stickiness sweep TTL. |
| `PIGEON_BIND_HOST` | `127.0.0.1` | Daemon HTTP bind host (was previously all-interfaces). |
| `PIGEON_DAEMON_AUTH_TOKEN` | unset | If set, ALL routes except `GET /health` require `Authorization: Bearer <token>`. **Unset ⇒ no enforcement (back-compat).** |

## Auth rollout note (IMPORTANT)

Auth is **enforce-when-configured** (deny-by-default). When `PIGEON_DAEMON_AUTH_TOKEN` is set,
EVERY daemon client must send the bearer token:
- the opencode plugin (`daemon-client.ts` `daemonHeaders()`),
- the `pigeon-send` CLI, workstation tooling, and reset-workspace.
All daemon clients have been patched to transmit `PIGEON_DAEMON_AUTH_TOKEN`.
Only `GET /health` remains in the anonymous allowlist for liveness probing.

## Design decisions (locked)

- **Pigeon is the sole lease authority** (it health-checks serves and owns the
  lease rows). No opencode patches are required for zao4.
- **Uniform HRW + sticky assignments**: existing assignments are never recomputed;
  HRW only picks for new/dormant placement, so a K change doesn't reshuffle live
  sessions. Capacity-weighting is deferred.
- **Caller supplies `desired`**: `IngressRouter` computes the HRW desired target and
  feeds it to the pure `StickyRouter`, which enforces pin + idle-migration.

## Deferred to mn9r (NOT in zao4)

- Serve-pool **supervisor** (boot K serves on fixed ports) + per-device pool sizing
  (this stack deploys to devbox/macOS/crostini too — a Chromebook can't run K=4).
- **Serve-side lease enforcement** (a serve refusing to run a session whose lease it
  doesn't hold) + `createNext` read-back.
- `OPENCODE_DB` pinning + `OPENCODE_DISABLE_CHANNEL_DB`; **atomic binary cutover** +
  maintenance fence (`binary_epoch`).
- The **sops auth token** + `pigeon-daemon.service` env + loopback enforcement in
  workstation Nix (coordinated with the cfp/T13 session, shared tree).
- Client migration (attach/run/oc-launch/oc-revive/lgtm/reset-workspace → discovery
  + per-session `/event`) and removal of the `:4096` single endpoint.
- Elasticity (K_min/K_max autoscale), capacity-weighted HRW, `307` redirect on `/event`.

## Follow-ups (tracked)

- bead **zao4.10**: make the telegram `execute` / `revive-and-deliver` *fallback*
  path pool-aware (the primary adapter path already uses the session's per-serve
  `backend_endpoint`).
- Minor: `ServeHealthPoller.start()` polls after the first interval, not
  immediately — serves are `unknown` for one `PIGEON_HEALTH_POLL_MS` window at boot.

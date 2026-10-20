# Cross-machine swarm, Phase 1 — implementation plan

Spec: `docs/plans/2026-10-20-cross-machine-swarm-design.md` §1–§2. Epic `pigeon-k0qn`.
Beads in this PR: `pigeon-qioa`, `pigeon-k0qn.1`, `pigeon-k0qn.2`, `pigeon-k0qn.3`.

## 1. No foreign Telegram notice (`pigeon-qioa`)

Decided at outbox SEND time, not insert time: `OutboxSender` option `gateSwarmOnLocalSession`
(on in `index.ts`) holds a `kind='swarm'` entry while its session has no local `sessions` row
(uncounted retry every 5s) and drops it as `no_local_session` after 60s. An insert-time skip
(the first draft) would also drop the notice for a session reaped after 7 idle days and revived
by the very message, whose plugin re-registers seconds after delivery; review caught it. A
foreign session never gains a row, so its notice is never posted. Cancels (`wc:`) are swarm
entries too and follow the same rule.

## 2. Worker `GET /sessions/:id/owner` (`pigeon-k0qn.1`)

`worker/src/sessions.ts` + route in `worker/src/index.ts`. API-key auth. `SELECT machine_id,
updated_at FROM sessions WHERE session_id = ?` → `200 {machine_id, last_seen}` or `404`.
Read-only (no `updated_at` touch). `StorageError` → 503.

## 3. Tri-state locality + fast fail (`pigeon-k0qn.2`)

New `daemon/src/routing/locality.ts`: `makeLocalityResolver({getSession, baseUrlsFor, fetchFn,
timeoutMs})` → `(id) => Promise<"local"|"remote"|"unknown">`.

- local row → `local`; `gse_` without row → `remote` (never probe: serve answers 500).
- otherwise GET `<base>/session/<id>` (no directory header, serve auth header if configured) over
  candidate bases in order — `ingressRouter.resolveRoute(id)?.apiBase` (read-only), then
  `config.opencodeUrl`, then `config.serveEndpoints`, deduped. A 200 from any base → local
  (stop). Otherwise at least one 404 → remote; otherwise → `unknown`. Requiring every base
  keeps one stray serve on another data dir from failing a local session. Each probe bounded
  (3s). No cache.

`daemon/src/swarm/arbiter.ts` `drainTargetInner`: before `clientForSession` (so a remote or
unknown id never reaches `ensureRouted`):

- `remote` → `RemoteTargetError extends PermanentDeliveryError` → existing permanent path (failed
  on first attempt, `notifySenderOfFailure`, wake alert), with a custom notice
  (`formatRemoteFailureNotice`) — the default one ends "safe to resend", and a resend fails
  identically. Reason from `ownerOf(id)` bounded 2s,
  decoration only: names the owning machine and last-seen when known; when the worker names THIS
  machine (stale D1 row) it says "not found on this machine" without claiming a remote owner.
- `unknown` → `TargetUnavailableError` (outage class: retried, never treated as remote).
- New optional `ArbiterOptions`: `localityOf`, `ownerOf`, `selfMachineId`. Absent `localityOf`
  = always local (preserves existing tests/behaviour).

Daemon `Poller.lookupSessionOwner(id, signal)` → `GET /sessions/:id/owner`; 404 → null; not
recorded in worker-health (decoration). Wired in `index.ts`.

Shared-`opencode.db` assumption: every host's serves (cloudbox K=4, devbox and darwin K=2 via
workstation `serve-pool.nix`) are pinned to one file by `OPENCODE_DB` +
`OPENCODE_DISABLE_CHANNEL_DB` (verified live on cloudbox via `/proc/<pid>/environ`; devbox
`home.devbox.nix`, darwin `home.darwin.nix`). Recorded on the bead.

## 4. Docs (`pigeon-k0qn.3`)

AGENTS.md Swarm IPC, `swarm-architecture`, `swarm-operations`, `daemon-architecture` skills:
cross-machine fast fail; drop stale `pigeon-send` / `opencode-send` references.

## Deploy

Worker deploy (owner route) and daemon restart per `cross-device-deployment`. Order-free: a
daemon against an old worker gets 404 → omits the owner name.

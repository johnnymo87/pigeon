# Cross-machine swarm, Phase 1 — implementation plan

Spec: `docs/plans/2026-10-20-cross-machine-swarm-design.md` §1–§2. Epic `pigeon-k0qn`.
Beads in this PR: `pigeon-qioa`, `pigeon-k0qn.1`, `pigeon-k0qn.2`, `pigeon-k0qn.3`.

## 1. No foreign Telegram notice (`pigeon-qioa`)

`daemon/src/swarm/telegram-notice.ts` `enqueueSwarmTelegramNotice`: return early (logged,
`reason=no-local-session`) when `storage.sessions.get(toSession)` is null. Placed before the
ancillary gate. The cancel notice needs no change: it already follows the fate of the `w:` row.

Residual, accepted: a message sent to a local session in the seconds before its plugin's
`/session-start` posts no notice. Before this change that notice reached the outbox, which
re-registered from a null local row and then compensated it away (`outbox-sender.ts:540-563`),
so it did not land either.

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
  `config.opencodeUrl`, then `config.serveEndpoints`, deduped. First definitive answer wins:
  200 → local, 404 → remote. Any other status / timeout / transport error → try next; none
  definitive → `unknown`. Each probe bounded (3s). No cache.

`daemon/src/swarm/arbiter.ts` `drainTargetInner`: before `clientForSession` (so a remote or
unknown id never reaches `ensureRouted`):

- `remote` → `RemoteTargetError extends PermanentDeliveryError` → existing permanent path (failed
  on first attempt, `notifySenderOfFailure`, wake alert). Reason from `ownerOf(id)` bounded 2s,
  decoration only: names the owning machine and last-seen when known; when the worker names THIS
  machine (stale D1 row) it says "not found on this machine" without claiming a remote owner.
- `unknown` → `TargetUnavailableError` (outage class: retried, never treated as remote).
- New optional `ArbiterOptions`: `localityOf`, `ownerOf`, `selfMachineId`. Absent `localityOf`
  = always local (preserves existing tests/behaviour).

Daemon `Poller.lookupSessionOwner(id, signal)` → `GET /sessions/:id/owner`; 404 → null; not
recorded in worker-health (decoration). Wired in `index.ts`.

Shared-`opencode.db` assumption: only cloudbox runs a serve pool (workstation `hosts/cloudbox`
`servePool`); devbox and macOS run one serve, so one DB trivially. Recorded on the bead.

## 4. Docs (`pigeon-k0qn.3`)

AGENTS.md Swarm IPC, `swarm-architecture`, `swarm-operations`, `daemon-architecture` skills:
cross-machine fast fail; drop stale `pigeon-send` / `opencode-send` references.

## Deploy

Worker deploy (owner route) and daemon restart per `cross-device-deployment`. Order-free: a
daemon against an old worker gets 404 → omits the owner name.

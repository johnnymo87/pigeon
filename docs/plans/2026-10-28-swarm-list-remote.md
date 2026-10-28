# swarm_list remote discovery (pigeon-k0qn.9)

Spec: `2026-10-20-cross-machine-swarm-design.md` §3.4. This note records the decisions §3.4 leaves
open. Three pieces, one PR.

## Worker: `GET /sessions/remote?limit=<n>`

- **Machine credential only** (`requireMachinePrincipal`). "Other machines" means other than the
  *caller*, and only a machine credential says who the caller is. Taking the machine from the URL
  or a query parameter would repeat the self-assertion the relay routes refuse. The shared key gets
  the same 401 `machine_credential_required` the relay routes give it.
- **Rows:** `sessions` where `machine_id <> caller`, `updated_at` within 7 days
  (`REGISTER_TAKEOVER_STALE_MS`: the same horizon after which a row is considered abandoned), and
  `session_id LIKE 'ses_%'`. `gse_` rows are left out because a goose session cannot be a remote
  target (§7); listing it would only invite a send that fails. Newest first; `limit` defaults to
  100 and is clamped to 500. `truncated` says whether more rows matched.
- **Per-machine relay status** (`relayReachability` in `relay.ts`, which `POST /swarm/relay`
  now answers from too, so the two cannot drift), so an agent can tell before sending whether a send could work. For
  each machine that appears in the rows, `relay` is what `POST /swarm/relay` would answer for a
  message from the caller, in the same check order: `not_retired` (owner still accepts the shared
  key), `not_accepted` (owner's accept set lacks the caller), `offline` (last poll older than
  `RELAY_ONLINE_MS`), else `available`. A missing `machine_relay_accept` table (schema not
  applied) gives `unknown` rather than failing the listing. This is a snapshot: the relay route
  re-checks on every send.
- Read-only: it never touches `updated_at`.

Response: `{machine_id, sessions: [{session_id, machine_id, label, updated_at}], machines:
[{machine_id, relay, last_poll_at}], truncated}`.

## Daemon: `GET /swarm/remote-sessions?limit=<n>`

Bearer-authenticated like every other daemon route. Proxies the worker route through the poller's
credential, bounded at 5s. Adds `relay_send` (this daemon's `PIGEON_SWARM_RELAY_SEND`), because
the worker cannot know whether the *sending* side is switched on. Errors: no worker connection
→ 503 `no_worker`; worker non-2xx → 502 `worker_error` with the worker's status and error code;
timeout or transport failure → 502 `worker_unreachable`. Not recorded in the worker-health
monitor (decoration, like `lookupTopics`).

## Plugin: `swarm_list remote: true`

Calls the daemon route instead of the serve. Output lists id, updated, machine, label, then one
line per machine with its relay status, then a warning line when `relay_send` is false
("this machine does not relay; sends to these sessions fail"). Local listing is unchanged.

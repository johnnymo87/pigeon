# Relay hold — implementation plan

Design: `2026-10-30-relay-hold-design.md` (approved). Bead `pigeon-k0qn.22`. Worktree
`~/projects/pigeon/.worktrees/k0qn22-relay-hold`. Run `npm run test` and `npm run typecheck` from
the worktree root; each task commits once, bare `git commit`, message prefix `[NO-JIRA]`.

## Task 1 — worker: accept for a sleeping machine, hand out `relayed_at`

`packages/worker/src/relay.ts`, tests in `packages/worker/test/relay.test.ts`.

1. Add `export const RELAY_GONE_MS = 7 * 24 * 60 * 60 * 1000;` beside `RELAY_ONLINE_MS`, with a
   comment: a machine silent this long is treated as decommissioned or renamed (its accept row and
   sessions survive until the 14-day sweep), not asleep.
2. `handleRelay`: when `reach.relay === "offline"`, refuse `503 target_offline` only if
   `reach.lastPollAt === null` (guard; unreachable today, see design) or
   `now - reach.lastPollAt > RELAY_GONE_MS`. The refusal detail for the >7d case names how long
   (e.g. `${toMachine} has not polled for 9 days`). Otherwise fall through to the queue-cap check
   and the insert, unchanged. Check order is otherwise unchanged.
3. `relayReachability`: behaviour unchanged. Rewrite the docstring: it is the descriptive answer
   used by `GET /sessions/remote` and remote launch's return-path check; `handleRelay` reads
   `offline` as "hold" unless silent > `RELAY_GONE_MS`, so `offline` in discovery means "held".
4. `handOutRelayItems`: message items gain `relayed_at: r.created_at` (the row's `created_at`, the
   time the worker accepted the relay). Failure items unchanged. Update the `HandOutItem` type.
5. Remote launch (`remote-launch.ts`) is NOT changed. Add a test asserting `/launch/relay` to a
   machine last polled e.g. 10 minutes ago still answers `503 target_offline`, if no such test
   exists.
6. Tests (failing first): target last polled 10 min ago → 202 and a `queued` row; last poll
   exactly `RELAY_GONE_MS` ago → 202, `RELAY_GONE_MS + 1` → 503 `target_offline`; a machine silent
   > 7 days that is also not in the accept list still answers `not_accepted` (and not-retired still
   `receiver_not_retired`); `queue_full` applies to a sleeping target; an item accepted while the
   target was offline is handed out through `handlePollNext` (or `handOutRelayItems`, whichever the
   existing tests use for the poll path) on its next poll and carries `relayed_at` equal to the
   accept time; `GET /sessions/remote` still reports `offline` for that machine. Update any existing
   test that asserted `target_offline` for a merely-stale target.

## Task 2 — daemon and plugin

Daemon `packages/daemon/src`, plugin `packages/opencode-plugin/src`, tests beside existing ones.

1. `storage/relay-inbound-repo.ts`: add nullable `relayed_at INTEGER` to `swarm_relay_inbound`
   (in `CREATE TABLE` and as an idempotent `ALTER TABLE ... ADD COLUMN`, following the pattern in
   `storage/swarm-schema.ts`); `record()` takes optional `relayedAt: number | null`; `asRecord`
   exposes `relayedAt`.
2. `swarm/relay-receiver.ts` `receiveMessage`: read `it.relayed_at`; keep it only when it is a
   finite number, else null (an old worker omits it). Pass to `record()`. It is never a refusal.
3. `swarm/envelope.ts`: `EnvelopeFields.heldMs?: number | null`; render `held_ms="<int>"` right
   after `from_machine`, finite-guarded and floored like `delivered_late_ms`.
4. `swarm/arbiter.ts` (the `renderEnvelope` call, ~L590): `heldMs` = `now - inbound.relayedAt`
   when the row has an inbound record with a non-null `relayedAt` and that difference exceeds
   60_000; otherwise null. (Clock skew between worker and daemon is why the 60 s floor exists.)
   Pull-banked relayed rows have no envelope and are out of scope.
5. `swarm/relay-notice.ts`: the `never_collected` notice no longer ends "so it is safe to resend".
   New wording, still rendered from the code alone: the worker held it for <machine> and the
   machine never collected it (asleep, down, or gone); nothing was written to the target; check
   `swarm_list remote: true` and resend only if it is still relevant. Keep "was NOT received" (the
   verb tests and the design contract key on it). `not_delivered_on_receiver` keeps its current
   text. The generic `formatFailureNotice` (used for `queue_full` exhaustion and every local
   failure) is NOT changed: `queue_full` fails in ~6 minutes, not after a 24 h hold, so it cannot
   loop the way `never_collected` can.
6. Plugin `swarm-list-tool.ts`: `explainRelay` takes the machine's `last_poll_at` and `now`.
   `offline` with `last_poll_at` within 7 days → `offline (<machine> last polled <relativeAge>; a
   message sent now is held up to 24h and delivered if it wakes in time)`; older than 7 days →
   `offline (<machine> has not polled for <age>; sends are refused)`; `last_poll_at` null → today's
   text. Header line: replace `"available" means the worker will queue it` with wording that says
   both `available` and `offline` (within 7 days) are queued by the worker. Use the file's existing
   `relativeAge` helper.
7. Tests: inbound record stores `relayed_at` and null when absent/non-numeric; envelope renders
   `held_ms` and omits it when null/NaN; arbiter renders `held_ms` for a relayed row with
   `relayedAt` 2 h old and omits it at 30 s and for a local row; new `never_collected` text;
   plugin wording for the three `offline` cases and the header.

## Task 3 — docs (orchestrator)

Per the design's Docs list, plus `darwin-rebuild` → `home-switch` / `darwin-switch` in
`.agents/skills/cross-device-deployment/SKILL.md` and `docs/plans/2026-10-29-remote-launch-design.md`.
Then a separate workstation PR for `assets/opencode/skills/swarm-messaging/SKILL.md`.

## Deliberate narrowing vs. the design

- `queue_full` exhaustion wording is unchanged (step 2.5 says why).

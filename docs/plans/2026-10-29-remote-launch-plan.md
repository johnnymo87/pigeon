# Remote Launch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (implementer /
> spec-reviewer / code-reviewer) to implement this plan task-by-task.

**Goal:** An agent on machine A calls `swarm_launch(machine, directory, prompt, tag?)` and a fresh
headless opencode session starts on machine B; A's agent gets a `launch.result` swarm message with
the new session id or a coded reason.

**Spec:** `docs/plans/2026-10-29-remote-launch-design.md` (approved; §9 is binding). Where this plan
and the design disagree, the design wins; stop and ask.

**Architecture:** Copies the cross-machine relay (`packages/worker/src/relay.ts`, daemon
`swarm/relay-receiver.ts`, `worker/relay-client.ts`): D1 table at the worker, items handed out on the
existing poll, acked, every outcome turned into a result row for the requester. B launches through
the existing `/launch` code (`daemon/src/worker/launch-ingest.ts`), refactored into a reusable core.

**Tech:** TypeScript, Cloudflare Worker + D1 (vitest-pool-workers), daemon on Node + better-sqlite3
(vitest), opencode plugin (vitest).

**Bead:** `pigeon-k0qn.17`. Two stacked PRs:

- **PR 1 (worker)**, branch `k0qn17-remote-launch`: Tasks 1–3. Includes the design + this plan.
- **PR 2 (daemon + plugin + docs)**, branch `k0qn17-daemon` off PR 1: Tasks 4–10.

**Commands:** from the worktree root `/home/dev/projects/pigeon/.worktrees/k0qn17-remote-launch`:
`npm run test --workspace @pigeon/worker`, `npm run test --workspace @pigeon/daemon`,
`npm run test --workspace @pigeon/opencode-plugin` (tests in `packages/opencode-plugin/test/`),
`npm run typecheck`. Run a single file with
`npx vitest run test/<file> ` inside the package directory. Commit messages start `[NO-JIRA]`. Run
`git commit` bare (never set an identity).

---

## Wire contract (shared by every task; byte-exact on both sides)

### `POST /launch/relay` (worker; machine key only)

Request: `{launch_id, from, machine, directory, prompt, tag, expires_at?}` (`tag` string or null, `expires_at` optional).

| Check (in this order) | Answer |
|---|---|
| not a machine key | 401 (from `requireMachinePrincipal`) |
| body invalid | 400 `{error:"invalid", detail}` |
| same `(caller, launch_id)` stored, same hash | 202 `{accepted:true, duplicate:true, launch_id, to_machine, expires_at}` |
| same key, different hash | 409 `launch_id_conflict` |
| effective expiry - now < LAUNCH_LEASE_MS | 410 `{error:"expired", detail:"fewer than one lease of life left"}` |
| `from` registered to another machine | 403 `sender_not_yours` |
| `machine` = caller | 409 `same_machine` |
| target not retired (`isSharedKeyRetiredFor`) | 403 `receiver_not_retired` |
| target's `machine_launch_accept` lacks caller | 403 `not_accepted` |
| target's `last_poll_at` null or older than 60 s | 503 `target_offline` |
| `relayReachability(db, env, target, caller, now).relay !== "available"` | 409 `no_return_path` |
| ≥ 10 launches queued/leased for target | 429 `queue_full` |
| ≥ 30 launches created by caller in the last hour | 429 `rate_limited` |
| ok | 202 `{accepted:true, launch_id, to_machine, expires_at}` |
| any "no such table" | 503 `launch_unavailable` |

Validation: `launch_id` `^[^:\s]{1,128}$`; `from` `^ses_[A-Za-z0-9_-]{8,128}$`; `machine`
`MACHINE_ID_PATTERN`; `directory` string, 1–512 chars, no `[\x00-\x1f\x7f]`; `prompt` string,
1–16000 code points (`[...prompt].length`); `tag` null/absent or `isValidTag` (worker
`tag-command.ts`); `expires_at` optional finite number (epoch ms). Hash = `sha256Hex(JSON.stringify([machine, from, directory, prompt, tag]))`.

### Poll header

`X-Pigeon-Swarm-Relay: accept=<m,…>; launch=<m,…>; failures=1`. `parseRelayHeader` gains
`launch: string[]` (empty when the token is absent; same filtering/sort/cap as `accept`).

### Poll response

Gains `launches: [...]` (present only when non-empty), next to `swarm`:

```ts
type LaunchHandOut =
  | { item: "launch"; from_machine: string; launch_id: string; from: string; directory: string;
      prompt: string; tag: string | null; expires_at: number }
  | { item: "launch_result"; from_machine: string; result_id: string; launch_id: string;
      machine: string; outcome: "launched" | "refused" | "unconfirmed";
      session_id: string | null; reason: string | null };
```

`launch_result.from_machine` is the requester (A, the polling machine); `machine` is B.
`never_collected` is `outcome:"refused", reason:"never_collected"`.

### `POST /launch/relay/ack` (worker; machine key only)

```ts
{ items: Array<
  | { kind: "launch"; from_machine: string; launch_id: string;
      outcome: "launched" | "refused" | "unconfirmed"; session_id?: string; reason?: string }
  | { kind: "result"; from_machine: string; result_id: string;
      outcome: "delivered" | "refused"; reason?: string }> }
```

≤ 100 items. `launched` requires `session_id` (`^ses_[A-Za-z0-9_-]{8,128}$`); `unconfirmed` may carry
one; `refused` requires `reason` `^[a-z0-9_]{1,64}$`. Answer `{ok:true, results:[{…key, result:
"ok"|"not_found"|"not_yours"}]}`. Acker must be the row's `to_machine`.

### Daemon `POST /swarm/launch` (local, daemon auth as `/swarm/send`)

Request `{launch_id, from, machine, directory, prompt, tag?}`. Answers:
`403 {error:"launch_send_disabled"}`; `400 {error:"invalid", detail}`; `503 {error:"no_worker"}`;
`202 {launch_id, status:"accepted", to_machine}`; `202 {launch_id, status:"pending"}`; a worker
refusal is passed through as `{error:<code>, detail}` with the worker's status. Same `launch_id`
again → the stored state, never a second worker request beyond the retry loop.

---

## PR 1 — worker

### Task 1: tables + `POST /launch/relay`

**Files:**
- Modify: `packages/worker/src/d1-schema.sql` (append)
- Create: `packages/worker/src/remote-launch.ts`
- Modify: `packages/worker/src/index.ts` (route `POST /launch/relay`, next to `/swarm/relay`)
- Test: `packages/worker/test/remote-launch.test.ts` (copy the harness of `test/relay.test.ts`:
  `call`, `addKey`, `seedSession`, `poll`, `beforeAll` schema apply, `beforeEach` cleanup; use
  machine ids `rl-a`, `rl-b`, `rl-c` and session ids `ses_rlA…` so cleanup cannot touch relay tests)

**Schema** (append to `d1-schema.sql`):

```sql
-- Remote launch (pigeon-k0qn.17, docs/plans/2026-10-29-remote-launch-design.md).
-- item_kind 'launch': A asks B to start a session. item_kind 'result': the receipt for A,
-- keyed r:<launch_id> (or r:<launch_id>:<outcome> for a correction, design §9.1).
CREATE TABLE IF NOT EXISTS remote_launch (
  from_machine  TEXT NOT NULL,
  launch_id     TEXT NOT NULL,
  item_kind     TEXT NOT NULL,              -- 'launch' | 'result'
  to_machine    TEXT NOT NULL,
  from_session  TEXT NOT NULL,
  body_json     TEXT NOT NULL,
  body_sha256   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|leased|launched|refused|expired (results: queued|leased|delivered|refused|expired)
  session_id    TEXT,
  reason        TEXT,
  lease_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  leased_at     INTEGER,
  expires_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  PRIMARY KEY (from_machine, launch_id)
);
CREATE INDEX IF NOT EXISTS idx_remote_launch_handout ON remote_launch(to_machine, status, created_at);
CREATE INDEX IF NOT EXISTS idx_remote_launch_expiry ON remote_launch(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_remote_launch_from ON remote_launch(from_machine, item_kind, created_at);

-- Which machines a machine runs launches for, from the poll header's launch= token.
CREATE TABLE IF NOT EXISTS machine_launch_accept (
  machine_id  TEXT PRIMARY KEY,
  accept_csv  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

**Constants** (export from `remote-launch.ts`): `LAUNCH_TTL_MS = 15*60_000`,
`LAUNCH_LEASE_MS = 60_000`, `LAUNCH_MAX_LEASES = 3`, `LAUNCH_HANDOUT_LIMIT = 1`,
`LAUNCH_RESULT_HANDOUT_LIMIT = 20`, `LAUNCH_RESULT_TTL_MS = 24*3600_000`, `LAUNCH_RESULT_MAX_LEASES = 5`,
`LAUNCH_QUEUE_CAP = 10`, `LAUNCH_RATE_PER_HOUR = 30`, `LAUNCH_RETENTION_MS = 7*24*3600_000`,
`LAUNCH_MAX_PROMPT = 16_000`, `LAUNCH_MAX_DIRECTORY = 512`, `LAUNCH_ONLINE_MS = 60_000`.

Reuse from `relay.ts` / `credentials.ts`: `requireMachinePrincipal`, `machineMismatch`,
`isSharedKeyRetiredFor`, `sha256Hex`, `MACHINE_ID_PATTERN`, `SENDER_ID`, `isMissingTable`,
`relayReachability`. Do not change relay behaviour. Store body_json for a launch as
`{from, directory, prompt, tag}`.

**Tests first** (one `it` each; all through `worker.fetch`):
1. valid request → 202, row `queued`, `to_machine` B, `expires_at = created_at + LAUNCH_TTL_MS`.
2. shared key → 401.
3. each validation failure → 400 (bad launch_id with `:`, non-`ses_` from, 513-char directory,
   directory with `\n`, empty prompt, 16001-code-point prompt (use an astral char to prove code points
   not UTF-16 units), invalid tag).
4. same launch_id, same body → 202 duplicate **even after B goes offline** (age `machines.last_poll_at`).
5. same launch_id, different prompt → 409 `launch_id_conflict`.
6. `from` registered to C → 403 `sender_not_yours`; unregistered `from` passes.
7. machine = caller → 409 `same_machine`.
8. B not in `SHARED_KEY_REFUSED_MACHINES` → 403 `receiver_not_retired`.
9. B's launch accept lacks A (poll B with `accept=rl-a; failures=1`, no `launch=`) → 403 `not_accepted`.
   (This needs Task 2's accept-set write. Until then, seed `machine_launch_accept` directly; keep the
   direct seed in a helper so Task 2 can switch the test to a real poll.)
10. B offline → 503 `target_offline`.
11. return path missing (B accepts launches from A, but A's relay accept lacks B) → 409 `no_return_path`;
    with A polled as `accept=rl-b; failures=1` → 202.
12. 10 queued for B → 429 `queue_full`; 30 created by A within the hour (to B and C) → 429 `rate_limited`.
13. tables dropped → 503 `launch_unavailable` (copy relay.test.ts:278's approach).

Steps: write tests → run (fail) → implement `handleLaunchRelay(db, env, request, now = Date.now())`
→ run (pass) → typecheck → commit `[NO-JIRA] Worker: POST /launch/relay queues a remote launch`.

### Task 2: hand-out on poll, ack, result rows

**Files:** `packages/worker/src/relay.ts` (parseRelayHeader `launch`), `remote-launch.ts`,
`poll.ts`, `index.ts` (route `POST /launch/relay/ack`), tests in `test/remote-launch.test.ts`
(and one case in `test/relay.test.ts` for the parser).

**`handOutLaunchItems(db, machineId, headerValue, now)`** — never throws (log, return `[]`), like
`handOutRelayItems`:
1. Parse the header. Header absent → clear `machine_launch_accept` for the machine (`accept_csv = ''`
   only when not already empty) and return `[]`. Otherwise upsert `accept_csv = launch.join(",")`,
   writing only when it changes (copy the relay upsert's `WHERE … IS NOT excluded.accept_csv`).
2. Run `runLaunchExpiry(db, now, { machine: machineId, limit: 20 })` (Task 3; in this task stub it
   as a no-op export so the call site exists) **before** leasing, so results minted by expiry go out
   on this same poll.
3. Lease at most `LAUNCH_HANDOUT_LIMIT` launch rows:
   `to_machine = ? AND item_kind='launch' AND from_machine IN (<launch list>) AND (status='queued' OR
   (status='leased' AND leased_at < now-LEASE)) AND lease_count < LAUNCH_MAX_LEASES AND
   expires_at - ? >= LAUNCH_LEASE_MS ORDER BY created_at LIMIT 1` (UPDATE … RETURNING, same shape as
   relay hand-out, re-checking the status predicate in the outer WHERE). Skip when the list is empty.
4. If `failures` is set, lease up to `LAUNCH_RESULT_HANDOUT_LIMIT` result rows
   (`item_kind='result' AND to_machine = ?`, lease rules with `LAUNCH_RESULT_MAX_LEASES`,
   `expires_at > now`).
5. Map rows to `LaunchHandOut`, sorted by `created_at`, launch first.

**`poll.ts`:** call `handOutLaunchItems` only for machine principals, right after
`handOutRelayItems`. Generalise the early return: if both arrays are empty, return `nextCommand(...)`
unchanged; else attach `swarm` only if non-empty and `launches` only if non-empty (a 204 becomes
`200 {…}`). Keep the existing try/catch around the command step.

**`handleLaunchRelayAck(db, env, request, now)`:** validate per the wire contract, then per item:
- row missing → `not_found`; `row.to_machine !== principal` → `not_yours`.
- **result row** (`kind:"result"`, must be `item_kind='result'`): `UPDATE … SET status = outcome,
  reason, settled_at WHERE status IN ('queued','leased')`. A refused result is logged and dropped
  (never answered).
- **launch row** (`kind:"launch"`, must be `item_kind='launch'`):
  - status `queued`/`leased` → settle: `launched` → status `launched`, `session_id`;
    `refused` → `refused`, `reason`; `unconfirmed` → `expired`, `reason='unconfirmed'`,
    `session_id` if given. In the **same `db.batch`**, mint the result row `r:<launch_id>` with
    `INSERT … ON CONFLICT DO NOTHING` (helper `resultInsert(db, row, outcome, sessionId, reason, key, now)`;
    result row: `from_machine = to_machine = row.from_machine`, `from_session = row.from_session`,
    `body_json = {launch_id, machine: row.to_machine, outcome, session_id, reason}`, `body_sha256 = ''`,
    `expires_at = now + LAUNCH_RESULT_TTL_MS`). Guard the settle with `WHERE status IN ('queued','leased')`
    and mint only `WHERE EXISTS` that guard, exactly as `failureStatement` does.
  - status `expired` → **correction** (design §9.1/§9.4), allowed only when
    `outcome ∈ {launched, refused}`, or `outcome = unconfirmed` with a `session_id` while
    `row.session_id IS NULL`. Update the launch row (`status`, `session_id`, `reason`,
    guarded `WHERE status='expired'`), then: if `r:<launch_id>` exists with status `queued`, UPDATE its
    `body_json` in place; otherwise insert `r:<launch_id>:<outcome>` (`ON CONFLICT DO NOTHING`).
  - status `launched`/`refused` → no-op (never reverse), `ok`.
  - `result: "ok"` for every handled item.

**Tests first:**
1. parser: `accept=a; launch=c,b,BAD!; failures=1` → `launch: ["b","c"]`; no token → `[]`.
2. poll with `launch=rl-a` writes the accept set; a poll without the token clears it; a poll with no
   header clears it; unchanged header does not rewrite (check `updated_at`).
3. queued launch is handed out once in `launches` with the contract shape; a second poll within the
   lease gets nothing; after the lease lapses it is handed out again; after 3 leases never again.
4. only 1 launch per poll even with 3 queued; oldest first.
5. a launch with < 60 s of life left is not handed out.
6. launch from a machine not in B's `launch=` list is not handed out.
7. ack `launched` → row `launched`, result row `r:<id>` queued for A; A's poll with `failures=1`
   gets `launch_result` `{outcome:"launched", session_id, machine:"rl-b"}`; A's poll **without**
   `failures=1` gets nothing.
8. ack `refused` reason `no_such_directory` → result refused with that reason.
9. ack `unconfirmed` with session id → launch row `expired`/`unconfirmed`, result carries the id.
10. ack by C → `not_yours`; unknown id → `not_found`; `launched` without session_id → 400;
    `refused` without reason → 400; reason `Bad Reason` → 400.
11. correction while `r:<id>` still queued: expire (set row `expired`/`unconfirmed` and insert queued
    `r:<id>` directly), then ack `launched` → still one result row, body now `launched`.
12. correction after `r:<id>` was collected (leased): ack `launched` → new row `r:<id>:launched`;
    A's poll gets it.
13. ack `refused` on a `launched` row → `ok`, row unchanged, no new result row.
14. A acks result `delivered` → result row `delivered`, not handed out again.
15. poll response with both relay items and launches carries both arrays; a command plus launches
    carries the command fields plus `launches`.

Commit `[NO-JIRA] Worker: hand remote launches out on the poll, with acks and result rows`.

### Task 3: expiry, cron, retention

**Files:** `remote-launch.ts`, `index.ts` (scheduled), tests.

**`runLaunchExpiry(db, now, opts: { machine?: string; limit?: number } = {})`:** selects launch rows
`status IN ('queued','leased') AND (expires_at <= now OR (status='leased' AND lease_count >= LAUNCH_MAX_LEASES AND leased_at < now - LEASE))`,
restricted to `(from_machine = ? OR to_machine = ?)` when `machine` is given, `LIMIT` (default 500).
Per row, in one batch: mint `r:<launch_id>` (queued → `refused`/`never_collected`; leased →
`unconfirmed`, no session id) guarded `WHERE EXISTS` the row is still in that status, then settle the
row `expired` with the matching reason. Result rows past `expires_at` (queued/leased) → `expired`,
logged, never answered. Then prune `item_kind IN ('launch','result') AND status NOT IN ('queued','leased') AND created_at < now - LAUNCH_RETENTION_MS`.
Missing table → return zeros. Called from the poll path through `handOutLaunchItems` (wrapped by its
never-throw) and from the hourly cron in `index.ts` next to `runRelayExpiry`, in its own try/catch.

**Tests first:**
1. queued launch past expiry → `expired`/`never_collected`; A's next poll gets `launch_result`
   refused `never_collected` — **with B never polling again** (requester-poll path).
2. leased launch past expiry → `unconfirmed` result, `session_id: null`.
3. leased 3 times and lapsed → expired `unconfirmed` before its TTL.
4. late `launched` ack after (1) → correction per Task 2 rule (this is the race the design names).
5. scoped run for machine C touches nothing of A→B.
6. retention prunes settled rows older than 7 days; queued rows are never pruned.
7. the cron entry point runs it (call `worker.scheduled` the way existing tests do, or unit-test the
   function and assert the import/call in index.ts by a scheduled-handler test if one exists).

Then update `.agents/skills/worker-architecture/SKILL.md` with a short "Remote launch" entry (routes,
tables, header token). Commit `[NO-JIRA] Worker: expire remote launches from the requester's poll and the cron`.

**PR 1 gate:** worker tests + full `npm run typecheck` green; adversarial review of the PR 1 diff;
open PR 1 (shepherding-pull-requests).

---

## PR 2 — daemon, plugin, docs (branch `k0qn17-daemon` from PR 1's head)

### Task 4: config, header token, per-call timeouts, launch core

**Files:** `daemon/src/config.ts`, `daemon/src/worker/relay-client.ts` (`relayPollHeader`),
`daemon/src/opencode-client.ts`, `daemon/src/routing/serve-outcome.ts` (export `transportCode`),
`daemon/src/worker/launch-ingest.ts`; tests in `config.test.ts`, `swarm-relay.test.ts` (or wherever
`relayPollHeader` is tested — grep), `opencode-client.test.ts`, `launch-ingest.test.ts`.

1. **Config:** `remoteLaunchFrom: string[]` from `PIGEON_REMOTE_LAUNCH_FROM` via `parseMachineList`
   (self excluded); `remoteLaunchSend: boolean` from `PIGEON_REMOTE_LAUNCH_SEND === "1"`. Both default off.
2. **Header:** `relayPollHeader(acceptFrom, failures, launchFrom: readonly string[] = [])` appends
   `; launch=<csv>` only when `launchFrom` is non-empty, before `; failures=1`
   (`accept=a; launch=b; failures=1`). Return null only when all three are empty/false. Existing calls
   unchanged.
3. **Timeouts:** `request()` takes an optional `timeoutMs` (default `this.requestTimeoutMs`, used for
   both the timer and the `RequestTimeoutError`). `healthCheck(opts?: {timeoutMs?})`,
   `createSession(directory, opts?)`, `sendPrompt(sessionId, directory, prompt, opts?)` pass it. No
   behaviour change without `opts`.
4. **Launch core** in `launch-ingest.ts`:

```ts
export type LaunchStartOutcome =
  | { outcome: "launched"; sessionId: string }
  | { outcome: "refused"; reason: string; detail: string }          // nothing is running
  | { outcome: "unconfirmed"; sessionId: string | null; detail: string };

export interface LaunchStartInput {
  directory: string;              // already resolved, absolute
  prompt: string;
  opencodeClient: OpencodeClient;
  resolveOwnerClient?: (sessionId: string) => OpencodeClient | undefined;
  budgets?: { healthMs: number; createMs: number; promptMs: number };  // remote: 5000/15000/20000
  onCreated?: (sessionId: string) => void;   // called synchronously right after createSession returns
}
export async function startSession(input: LaunchStartInput): Promise<LaunchStartOutcome>; // never throws
```

   Classification (design §3, §9.2): unhealthy → refused `serve_unavailable`. `createSession`:
   `RequestTimeoutError` → unconfirmed, null id; `TransportError` with code `ECONNREFUSED` → refused
   `serve_unreachable`; any other `TransportError` → unconfirmed, null id; HTTP failure → refused
   `create_failed`. `sendPrompt`: ok → launched; `OpencodeHttpError` 4xx → refused `prompt_rejected`
   and `deleteSession` best-effort (swallow); `ECONNREFUSED` → refused `prompt_unreachable` and
   best-effort delete; timeout, 5xx, other transport → unconfirmed with the id. `onCreated` throwing
   must not change the outcome (catch, log).

   Export `autoAttach(sessionId, spawn?)` (the existing block, unchanged) and `applyTag` (unchanged).
   `ingestLaunchCommand` keeps its Telegram messages but calls `startSession` (no budgets) and stops
   reporting "Failed to launch" for a session that exists: unconfirmed with an id → `Session started
   <id> but its prompt may not have arrived: <detail>` (plus attach + tag); refused →
   `Failed to launch session<machine>: <detail>`; unhealthy keeps `opencode serve is not running<machine>.`

**Tests first:** config parsing (empty, list with self, `SEND=1`/`0`); header strings; a
`createSession` with `timeoutMs: 50` against a never-answering fetch rejects with
`RequestTimeoutError` mentioning 50ms; `startSession` table: each classification row above with a
fake client (assert `deleteSession` called for refused-after-create, `onCreated` called with the id
before `sendPrompt`); all existing `launch-ingest.test.ts` cases pass unchanged except the ones whose
message changes by design (update them, and say which in the commit message).

Commit `[NO-JIRA] Daemon: remote-launch config, poll token, per-call timeouts and a reusable launch core`.

### Task 5: storage and worker client

**Files:** create `daemon/src/storage/remote-launch-repo.ts`, wire into `storage/database.ts`
(`remoteLaunch: RemoteLaunchRepository`); create `daemon/src/worker/remote-launch-client.ts`;
tests `test/remote-launch-repo.test.ts`, `test/remote-launch-client.test.ts`.

Schema (`initRemoteLaunchSchema`):

```sql
CREATE TABLE IF NOT EXISTS remote_launch_inbound (       -- B side
  from_machine TEXT NOT NULL, launch_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  state TEXT NOT NULL,                  -- received | created | settled
  session_id TEXT, outcome TEXT, reason TEXT,
  ack_done INTEGER NOT NULL DEFAULT 0, ack_attempts INTEGER NOT NULL DEFAULT 0, next_ack_at INTEGER,
  received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (from_machine, launch_id)
);
CREATE TABLE IF NOT EXISTS remote_launch_outbound (      -- A side
  launch_id TEXT PRIMARY KEY,
  from_session TEXT NOT NULL, to_machine TEXT NOT NULL, directory TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,                  -- sending | accepted | refused | resolved | deadline
  resolved_outcome TEXT,                -- launched | refused | unconfirmed: last outcome told to the agent
  refusal_code TEXT, refusal_status INTEGER, refusal_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  created_at INTEGER NOT NULL, request_expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS remote_launch_results_seen (  -- A side, dedup by result row id
  result_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, received_at INTEGER NOT NULL
);
```

Repository methods (each one statement; names are a suggestion, keep them small and tested):
inbound `get`, `insertReceived` (ON CONFLICT DO NOTHING, returns boolean), `markCreated(sessionId)`,
`settle(outcome, sessionId, reason)` (only from received/created), `markAckDone`, `markAckRetry(nextAt)`,
`listAcksDue(now, limit)`, `pruneOlderThan`; outbound `get`, `insert`, `markAccepted`,
`markRefused(code, status, detail)`, `markRetry(nextAt)`, `markResolved`, `markDeadline`,
`listSendDue(now)`, `listDeadlinePassed(now)`, `pruneOlderThan`; results-seen `record(resultId,
launchId, now)` returning false on repeat. `request_expires_at = created + 15 min`;
`deadline_at = request_expires_at + 60 s + 120 s`.

`RemoteLaunchClient` (copy `RelayClient`'s `post` with a 10 s timeout, never throws):
- `request(body)` → `{kind:"accepted", toMachine, duplicate}` | `{kind:"refused", code, detail, status}`
  | `{kind:"transient", detail}`. **Refused = any worker answer with a known code** (design §9.6):
  `invalid, launch_id_conflict, expired, sender_not_yours, same_machine, receiver_not_retired,
  not_accepted, target_offline, no_return_path, queue_full, rate_limited, launch_unavailable`.
  The request body always carries `expires_at = outbound.request_expires_at` (PR 1 review: the
  worker anchors the launch's life to the requester's deadline, so A's `deadline_at` stays valid). 404 with no code →
  `refused` code `worker_too_old`. Unknown code, 5xx, network → transient.
- `ack(items)` → boolean.

Tests: each method; client classification table with a fake fetch, incl. `503 target_offline` →
refused and `503` with no body → transient.

Commit `[NO-JIRA] Daemon: remote-launch storage and worker client`.

### Task 6: receiving side (machine B)

**Files:** create `daemon/src/swarm/remote-launch-receiver.ts`; test `test/remote-launch-receiver.test.ts`.

```ts
export interface LaunchReceiverDeps {
  storage: StorageDb;
  selfMachineId: string;
  launchFrom: readonly string[];          // config.remoteLaunchFrom
  relaySendEnabled: boolean;              // config.swarmRelaySend (design §9.3)
  opencodeClient?: OpencodeClient;
  resolveOwnerClient?: (id: string) => OpencodeClient | undefined;
  ack: (items: LaunchAckItem[]) => Promise<boolean>;
  runOcTags?: () => OcTagsRunner | null;  // resolved per launch
  onTagged?: (sessionId: string) => void;
  spawn?: …;                              // for autoAttach, test seam
  statDirectory?: (path: string) => boolean;  // test seam; default fs.statSync(...).isDirectory()
  nowFn?: () => number;
  log?: …;
}
export async function processLaunchItems(deps, items: unknown[]): Promise<void>;  // launch items only; never throws
export async function retryLaunchAcks(deps): Promise<void>;                       // acks due from the table
```

Per `item:"launch"` (in order; each refusal is recorded `settled` so a re-handout re-acks the same):
1. Missing/invalid `from_machine` or `launch_id` → log and skip (nothing to ack by).
2. Shape invalid (from not `ses_`, directory/prompt not strings, tag invalid) → refused `invalid`.
3. Existing inbound row → no launch; ack per state: settled → its outcome/session/reason;
   created → `unconfirmed` + session id; received → `unconfirmed`, no id.
4. `from_machine` not in `launchFrom` or = self → refused `not_accepted`.
5. `!relaySendEnabled` → refused `no_return_path`.
6. no `opencodeClient` → refused `serve_unavailable`.
7. `insertReceived`. Directory: `resolveHome(expandShorthand(dir))`; not absolute or not a directory →
   settle refused `no_such_directory`; contains a character above U+00FF → refused
   `invalid_directory` (it becomes the `x-opencode-directory` header, and `fetch` throws on such a
   value before sending, which would otherwise read as an ambiguous transport error).
8. `startSession({directory, prompt: framed, budgets: {5000,15000,20000}, onCreated: markCreated})`.
   Framed prompt = `[Remote launch requested by ${from} on ${fromMachine}; report back with swarm_send to ${from}.]\n\n${prompt}`.
9. `settle(...)`, then `ack([...])` → `markAckDone` or `markAckRetry(now + backoff)`. **Acks go one
   item per request** (the worker 400s a whole batch for one bad item, and a poisoned batch retried
   from the table would block every later ack), and every item is checked against the wire regexes
   before sending; an item that fails them is logged and marked done (it can never succeed).
10. **After the ack, not awaited by the tick** (`void (async () => {...})()` with its own catch):
    for launched/unconfirmed-with-id: `autoAttach`, `applyTag(item.tag)` if a tag is present, and
    `storage.alerts.enqueue({source:"remote-launch", refMsgId:`rl:${fromMachine}:${launchId}`,
    severity:"info", text})` with text
    `🚀 Remote launch from ${fromMachine} (${from}): session ${sid} in ${dir}\n${truncate(prompt, 300)}`
    (`truncate` from `tag-ingest.ts`; for unconfirmed add ` (prompt may not have arrived)`).

`LaunchAckItem` = `{kind:"launch", from_machine, launch_id, outcome, session_id?, reason?}` (wire contract).

Tests (fake client, in-memory storage `openStorageDb(":memory:")`): happy path acks `launched`
with the id and records settled; prompt framing text exact; each refusal row above; re-handout of
settled/created/received rows acks without calling `createSession` again (assert call count = 1);
prompt timeout → `unconfirmed` with id; ack failure → `retryLaunchAcks` later sends the same item;
alert enqueued once even when processed twice (refMsgId dedup); tag applied via fake runner;
nothing awaits the tag (a never-resolving runner does not block `processLaunchItems`).

Commit `[NO-JIRA] Daemon: run remote launches handed out to this machine`.

### Task 7: requesting side (machine A)

**Files:** create `daemon/src/swarm/remote-launch-requester.ts` (route helper, sender tick, result
receipt, notice text); modify `daemon/src/app.ts` (route `POST /swarm/launch`, new
`CreateAppOptions`: `remoteLaunch?: RemoteLaunchRequester`); tests
`test/remote-launch-requester.test.ts`, `test/swarm-launch-route.test.ts`.

```ts
export class RemoteLaunchRequester {
  constructor(deps: { storage; client: Pick<RemoteLaunchClient,"request"|"ack">; sendEnabled: boolean;
    resolveRequesterTag?: (sessionId: string) => Promise<string | null>; nowFn?; log? });
  handleRequest(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  tick(): Promise<void>;                          // send retries + deadlines
  processResults(items: unknown[]): LaunchResultAck[];   // sync; launch_result items only
}
```

- `handleRequest`: disabled → 403 `launch_send_disabled`. Validate (same rules as the worker; daemon
  copy is fine, keep it in this file). Existing outbound row for `launch_id`: different `from` or
  `machine` → 409 `launch_id_conflict`; else answer from its state (accepted/resolved/deadline →
  202 accepted; sending → 202 pending; refused → stored code/status). New: tag = body.tag ??
  `await resolveRequesterTag(from)` (null on any failure); insert outbound `sending` **before** the
  POST; `client.request`; accepted → `markAccepted` → 202 accepted; refused → `markRefused` → that
  status/code (no local swarm message: the caller is told inline); transient → `markRetry(now+5s)` →
  202 pending.
- `tick()`: for `listSendDue(now)` with `now < request_expires_at`: request again; accepted →
  accepted; refused → `markRefused` **and** insert the local refused `launch.result` (design §9.6);
  transient → backoff (5 s doubling, cap 60 s). For `listDeadlinePassed(now)` in state
  sending/accepted: insert local `unconfirmed` (no id) and `markDeadline`. Never throws.
- `processResults(items)`: for each `item:"launch_result"`: require `from_machine === self`, an
  outbound row with that `launch_id` and `to_machine === item.machine` → else ack `refused`
  `no_matching_launch`. If `results_seen.record(result_id)` is false → ack `delivered`, no message.
  Validate `session_id` against `^ses_[A-Za-z0-9_-]{8,128}$` (invalid → treat as null) and `reason`
  against `^[a-z0-9_]{1,64}$` (invalid → `unrecognised`). Insert the local message via
  `bankOrInsertSwarmMessage` (`fromSession:"pigeon"`, `toSession: outbound.from_session`,
  `kind:"launch.result"`, `priority:"normal"`, `replyTo:null`, payload from
  `formatLaunchResult(...)`), `markResolved(outcome)` (sets `resolved_outcome`), ack `delivered`.
  **Never downgrade** (PR 1 review): if `resolved_outcome` is `launched` or `refused` and the incoming
  outcome is `unconfirmed`, ack `delivered` and insert no message (a correction can overtake the
  original after a lost poll response). The deadline's local `unconfirmed` sets
  `resolved_outcome = 'unconfirmed'`, so a later real result is still delivered.
  Self machine id comes from deps (add `selfMachineId`).
- `formatLaunchResult({launchId, machine, directory, outcome, sessionId, reason})` (texts are a
  contract; tests pin them):
  - launched: `REMOTE LAUNCH STARTED: launch ${id} started session ${sid} on ${machine} in ${dir}. Message it with swarm_send to ${sid}.`
  - refused, reason never_collected: `REMOTE LAUNCH NOT STARTED: launch ${id} was never collected by ${machine} and did NOT start. Safe to retry.`
  - refused, other: `REMOTE LAUNCH REFUSED: launch ${id} did NOT start on ${machine} (${reason}). Safe to retry.`
  - unconfirmed with id: `REMOTE LAUNCH UNCONFIRMED: launch ${id} created session ${sid} on ${machine}, but its prompt may not have arrived. swarm_send it the task if it does not report in. Do NOT launch again.`
  - unconfirmed without id: `REMOTE LAUNCH UNCONFIRMED: launch ${id} may or may not have started on ${machine}. Check swarm_list remote: true before retrying.`
- `app.ts` route: `POST /swarm/launch` → `opts.remoteLaunch ? handleRequest : 503 {error:"no_worker"}`
  (when send is enabled but no worker, `index.ts` passes none). Same auth as other `/swarm/*` routes.

Tests: route answers per contract incl. idempotent repeat; outbound row exists before the client is
called (assert inside the fake `request`); transient then accepted on tick; transient then refused on
tick inserts a refused `launch.result` swarm row to the requester; deadline inserts unconfirmed once;
result receipt inserts one swarm row and a duplicate result id inserts none; correction
(`r:x` unconfirmed then `r:x:launched`) inserts two rows; foreign/mismatched results acked refused;
tag inheritance used only when `tag` absent.

Commit `[NO-JIRA] Daemon: request remote launches and turn results into launch.result messages`.

### Task 8: poller + daemon wiring

**Files:** `daemon/src/worker/poller.ts`, `daemon/src/index.ts`, tests in `test/poller.test.ts`.

- Poller: `pollNext` also returns `launches: unknown[]` (from `body.launches`, stripped from the
  command like `swarm`). New callback `onLaunchItems?: (items: unknown[]) => Promise<void>`, awaited
  after `onRelayItems` and before `dispatch`, its throw logged and swallowed.
- `index.ts`:
  - `remoteLaunchClient` when worker url + key exist.
  - Capability for receiving: `launchCapable = config.remoteLaunchFrom.length > 0 && opencodeClient
    && config.telegramBotToken && config.telegramChatId && remoteLaunchClient` (design §9.5). Header
    `relayPollHeader(config.swarmRelayAcceptFrom, true, launchCapable ? config.remoteLaunchFrom : [])`.
    Log one line with launch_from / launch_send, and a warning naming the missing piece when
    `remoteLaunchFrom` is set but not capable.
  - `onLaunchItems`: split items; `launch_result` → `requester.processResults` → ack via
    `remoteLaunchClient.ack` (`kind:"result"`); `launch` → `processLaunchItems(receiverDeps, …)`;
    then `retryLaunchAcks(receiverDeps)`.
  - `requester = new RemoteLaunchRequester({...sendEnabled: config.remoteLaunchSend, resolveRequesterTag})`
    when a client exists; `setInterval(() => void requester.tick(), 5000)` started next to the
    relay fail sender; pass `remoteLaunch: requester` to `createApp`. `resolveRequesterTag` runs
    `resolveRunOcTags(INHERIT_WHICH_TIMEOUT_MS)?.(["which", id])`, `parseWhichLine`, and returns the
    tag only when `kind === "session"`.
  - Prune: in the hourly maintenance block, `storage.remoteLaunch.prune…(now - 8 days)`.
  - Stop the interval in graceful shutdown next to the other timers.

Tests: poller returns/forwards `launches`; callback order relay → launches → command; a throwing
`onLaunchItems` does not cost the command. index.ts wiring has no unit test; it is covered by
Task 9 and by typecheck.

Commit `[NO-JIRA] Daemon: wire remote launch into the poller and the app`.

### Task 9: plugin tool + end-to-end

**Files:** create `opencode-plugin/src/swarm-launch-tool.ts`, register in `opencode-plugin/src/index.ts`
next to `swarm_send`; test `opencode-plugin/test/swarm-launch-tool.test.ts`. Create `daemon/test/swarm-launch-e2e.test.ts`.

Tool `swarm_launch` (`SWARM_LAUNCH_TOOL_NAME`), args `{machine, directory, prompt, tag?}`, description
must say: starts a FRESH session on another machine; call ONCE per launch; the result arrives as a
`launch.result` swarm message; `pending` means do not call again; a pool restart on that machine kills
the launched session (see the cross-device-deployment skill).
- `from` = root of `ctx.sessionID`: `resolveRootSession(id)` follows `parentID` via
  `GET /session/<id>` on the plugin's `internalFetch` + `ctx.serverUrl` (as `swarm-list-tool.ts`
  does), at most 8 hops; any failure → use the id it has.
- Mints `launch_id = rl_<base36 now>_<8 hex>` once; POSTs `/swarm/launch` with swarm_send's retry
  policy (transient = network/5xx/429, same launch_id every attempt; 401 re-auth once).
- Output: accepted → `Launch <id> accepted for <machine>. The result arrives as a launch.result swarm message.`;
  pending → `Launch <id> is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.`;
  retries exhausted on a transport failure → the same pending text **only if** at least one attempt
  reached the daemon with a 5xx; otherwise throw `swarm_launch failed: daemon unreachable` (nothing
  was recorded); 4xx → throw with `<code>: <detail>`; 404 without a code → throw
  `pigeon on this machine is too old for swarm_launch`.

E2E (copy the D1 shim + worker module loading from `swarm-relay-e2e.test.ts`; import the worker's
`remote-launch.ts` the same runtime-path way): two daemons' storage, real worker routes, fake opencode
client on B.
1. A requests → B's poll hands out → B launches (fake createSession returns `ses_e2eLaunched01`) →
   ack → A's poll → A's storage holds one `launch.result` swarm row to the requester with the id.
2. Lost ack: B processes, its ack is dropped by a failing fetch; lease lapses; re-handout → no second
   `createSession`; ack lands; A gets exactly one result.
3. B never polls: A's polls past 15 min (advance `now`) → A gets `never_collected`.
4. B refuses (`no_such_directory`) → A's result says refused with that reason.

Commit `[NO-JIRA] Plugin: swarm_launch tool; remote launch end-to-end test`.

### Task 10: docs

**Files:** `AGENTS.md` (new "Remote launch" subsection under Swarm IPC: what it is, the two env
flags default off, check order summary, result texts, the pool-restart trap, rollback),
`.agents/skills/swarm-architecture/SKILL.md` (tables, routes, header token, lifecycle),
`.agents/skills/swarm-operations/SKILL.md` (inspect `remote_launch` in D1 and the three daemon tables;
reading `[remote-launch]` logs), `.agents/skills/cross-device-deployment/SKILL.md` ("Remote upgrade"
recipe: the prompt to launch on B — pull, `npm install` as a separate call, restart the daemon,
verify, report with `swarm_send`, then schedule the serve-pool restart last from a delayed
`systemd-run` job, and say a plugin change cannot be verified by the session itself; Mac rebuilds
still need Jonathan). Mark the design doc status "built" with the PR numbers once known.

Commit `[NO-JIRA] Docs: remote launch`.

**PR 2 gate:** all three packages' tests + typecheck green; adversarial review of the PR 2 diff; open
PR 2 based on PR 1's branch (shepherding-pull-requests).

---

## Out of scope (file as beads under `pigeon-k0qn`)

- Workstation: `swarm-messaging` skill section for `swarm_launch`; per-host env flags
  (`PIGEON_REMOTE_LAUNCH_FROM`, `PIGEON_REMOTE_LAUNCH_SEND`) — only when Jonathan asks to enable.
- `swarm_list remote:true` showing launch reachability per machine.
- goose backend launches; worktree creation.

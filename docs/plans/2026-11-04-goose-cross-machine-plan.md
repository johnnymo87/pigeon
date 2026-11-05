# Goose sessions own cross-machine work — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** A goose session (`gse_…`) can request a remote launch, schedule wakes, receive replies
from other machines, and send to remote sessions.

**Design:** `docs/plans/2026-11-04-goose-cross-machine-design.md` (read D1–D4 first; this plan
cites them). Bead: honk-9qf.29 (honk tracker).

**Tech stack:** pigeon = TypeScript, vitest (`cd packages/daemon && npx vitest run <file>`;
`cd packages/worker && npx vitest run <file>`; `npm run typecheck` per package). honk = Rust
(`cargo test -p honk`, `cargo clippy -p honk --all-targets -- -D warnings`, `cargo fmt`).

**Rules for every task:** TDD (failing test first). Never widen the shared `ses_` regexes
(`SESSION_ID_RE` in remote-launch-requester.ts / remote-launch-receiver.ts, worker `SENDER_ID`):
they also validate launched ids, acks and discovery. Add new constants. Commit with
`[NO-JIRA] <summary>` messages; plain `git commit` (no identity flags). Implement only your task;
if you find work for another task, say so in your report.

---

### Task P1: worker accepts `gse_` launch requesters and relay senders (design D1, D3)

**Files:** `packages/worker/src/relay.ts` (`SENDER_ID` :52, `validateRelayBody` :149),
`packages/worker/src/remote-launch.ts` (:96). Tests: `packages/worker/test/relay.test.ts`,
`packages/worker/test/remote-launch.test.ts`.

1. In `relay.ts` add `export const RELAY_SENDER_ID = /^(ses|gse)_[A-Za-z0-9_-]{8,128}$/;` and use
   it in `validateRelayBody` for `from`; message `"from must be a ses_ or gse_ session id"`.
2. In `remote-launch.ts` add `const REQUESTER_ID = RELAY_SENDER_ID` (import) and use it at :96;
   message `"from must be a ses_ or gse_ session id"`. Leave `SENDER_ID` at :997/:1008 and in
   `remote-sessions.ts` unchanged.
3. Tests: a `gse_` `from` is accepted by `/swarm/relay` and `/launch/relay` (registered-to-caller
   and unregistered both pass; registered to another machine → 403 `sender_not_yours`); a
   `gse_` launched `session_id` in a launch ack is still refused; `pigeon` / `xyz_` senders still
   400; remote discovery still lists `ses_` only. Update existing assertions on the old error text.

### Task P2: `markGooseRemoteReachable` helper (design D2)

**Files:** create `packages/daemon/src/goose/remote-reachable.ts`; test
`packages/daemon/test/goose-remote-reachable.test.ts`.

Export a factory:

```ts
export interface RemoteReachableDeps {
  sessions: Pick<SessionRepo, "get" | "setPullSources">;   // use the real repo type names
  register?: (sessionId: string, label: string | null, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;       // default 5000
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}
export function createMarkGooseRemoteReachable(deps): (sessionId: string) => Promise<{ marked: boolean; registered: boolean | "cached" | "skipped" }>
```

Behaviour:
- Not a `gse_` id, or no row, or `row.backendKind !== GOOSE_BACKEND_KIND` → `{marked:false, registered:"skipped"}`; no writes.
- Synchronously (no `await` before the write): effective list = `row.pullSources ?? ["telegram-reply"]`
  (check `types.ts` for the actual default helper); append `swarm` and `swarm-remote` if missing;
  call `setPullSources` only if it changed.
- Then, if `register` is set and the id is not in an in-memory `Set` of ids registered this
  lifetime: call it with an `AbortController` aborted after `timeoutMs`, raced against the
  deadline (a register that ignores its signal must not hold the caller). A result that is
  `{ok:false}` or a throw/timeout → log `"remote-reachable: registration failed"` and return
  `registered:false` (not added to the set, so a later contact retries). Success → add to the set.
- Never throws.

Tests: additive write from NULL, from `["telegram-reply","swarm"]`, idempotent second call (no
second `setPullSources`, register called once then `"cached"`), opencode/unknown ids skipped,
register failure → not cached and retried next call, register that never resolves → returns
within timeout (use fake timers or a short `timeoutMs`).

### Task P3: launch requester accepts `gse_` (design D1, D2)

**Files:** `packages/daemon/src/swarm/remote-launch-requester.ts`, `packages/daemon/src/index.ts`
(:540-559). Test: `packages/daemon/test/remote-launch-requester.test.ts`.

1. Add `REQUESTER_ID = /^(ses|gse)_[A-Za-z0-9_-]{8,128}$/`; use it at :124 with detail
   `"from must be a ses_ or gse_ session id"`. Keep `SESSION_ID_RE` for :484.
2. After the existing validation, before idempotency lookup is fine: a `gse_` `from` whose local
   row is missing or not a goose row → `{status:409, body:{error:"no_session", detail:"no goose session <id> on this machine"}}`.
3. New optional dep `markRemoteReachable?: (sessionId: string) => Promise<unknown>`. Call it
   (awaited; it never throws, but wrap in try/catch anyway) for a `gse_` `from` right before
   `this.client.request(requestBody)` on the first-send path (around :280). Not for replays of an
   existing `launch_id`.
4. In `processResults` and the refusal/deadline paths (:368, :410, :520): if
   `bankOrInsertSwarmMessage` returns `status:"refused"`, `this.log("launch result not delivered", {launchId, to, reason, error})`
   (and `console.warn` if `log` is the default). Behaviour otherwise unchanged (still acked).
5. `index.ts`: `resolveRequesterTag` maps through `whichKeyFor(sessionId, storage.sessions)`
   (`tag-key.ts`); null → return null without running oc-tags. Also, for a goose requester that is
   a stall-watch coordinator (`coordinatorProgramOf(row)` returns `{program}`), return the program,
   matching `/launch`'s inheritance (see how `/launch --backend goose` / goose launch ingest does
   it in e769b91 and mirror it; if that logic lives in a helper, reuse it). Wire
   `markRemoteReachable` from a single `createMarkGooseRemoteReachable` instance created in
   index.ts with `register: poller ? (id, label, signal) => poller.registerSession(id, label ?? undefined, signal) : undefined`.
   That same instance is reused by Task P5 — export/keep it in a variable.

Tests: `gse_` from with a goose row accepted and posted (body `from` is the gse id); `gse_` with no
row → 409 `no_session`, nothing posted; mark called before `client.request` (record call order);
mark not called for `ses_` or on replay; refused launch.result is logged; existing `ses_` tests
unchanged except error-text updates.

### Task P4: target daemon accepts a `gse_` requester (design D1)

**Files:** `packages/daemon/src/swarm/remote-launch-receiver.ts` (:29, :222). Test:
`packages/daemon/test/remote-launch-receiver.test.ts`.

Add `REQUESTER_ID` (same regex); use at :222 only. Keep `SESSION_ID_RE` at :79/:89. Test: a
launch item from `gse_…` starts a session whose framed prompt names the `gse_` id; ack
`session_id` validation still `ses_`-only.

### Task P5: arbiter and relay receiver handle `gse_` senders (design D3)

**Files:** `packages/daemon/src/swarm/arbiter.ts` (`RELAY_SENDER_ID` :147, remote branch
:599-604), `packages/daemon/src/swarm/relay-receiver.ts` (:27, :79, :149), `index.ts` (arbiter
construction ~:983). Tests: `packages/daemon/test/swarm-arbiter-locality.test.ts` /
`swarm-relay.test.ts` (find the existing relay-sender tests), `swarm-relay-e2e.test.ts`.

1. `RELAY_SENDER_ID` → `^(ses|gse)_[A-Za-z0-9_-]{8,128}$`. Update the comment at :599.
2. New optional arbiter dep `markRemoteReachable?: (sessionId) => Promise<unknown>`; in the remote
   branch, when `this.relay` is set and the sender starts with `gse_`, await it before
   `this.relayRow(next, target)`. Wire the P3 instance in index.ts.
3. `relay-receiver.ts`: widen the sender regex used at :79 and :149 to `^(ses|gse)_…` (new
   constant; check what :27 is shared with). Error text `"from must be a ses_ or gse_ id"`.
4. Tests: a local `gse_` sender's row to a remote target is relayed (relay body `from` is the gse
   id) and mark is called first; `pigeon` sender still fails as before; receiver inserts a relayed
   item from a remote `gse_` for a local opencode target; receiver still refuses a `gse_` sender that
   is a local session (`from_is_local`); e2e: gse_ on machine A → ses_ on B → reply ses_ B → gse_ A
   delivered (use the existing two-machine e2e harness; the A row must have `swarm-remote`, set by
   the mark on A's send).

### Task P6: local send/schedule to a remote `gse_` (design D2 send side)

**Files:** `packages/daemon/src/swarm/bank-or-insert.ts` (:62-69), `packages/daemon/src/app.ts`
(`/swarm/send` ~:953, `/swarm/schedule` ~:1060, options ~:347). Tests:
`packages/daemon/test/swarm-bank-or-insert.test.ts`, `swarm-routes.test.ts`.

1. `BankOrInsertInput.allowRemoteGoose?: boolean`. When true and the target is a `gse_` with no
   local row, skip the `no_session` refusal and insert into `swarm_messages` as for any session
   (the arbiter's locality check relays it).
2. New app option `lookupSessionOwner?: (id: string, signal: AbortSignal) => Promise<{machineId: string} | null>`
   (wire to `poller.lookupSessionOwner` in index.ts) and use `opts.machineId`. In `/swarm/send` and
   `/swarm/schedule` only, when `opts.swarmRelaySend === true`, `to` starts with `gse_`, and
   `storage.sessions.get(to)` is null: look up the owner with a ~3 s bound.
   - owner null (404) → keep the existing 409 `no goose session … on this machine` (do not pass the flag);
   - owner is this machine → same 409;
   - owner elsewhere → pass `allowRemoteGoose: true`;
   - lookup throws / times out / not wired → fail open: pass `allowRemoteGoose: true`.
   Relay send off → unchanged 409.
3. Never set the flag anywhere else (notify-sender, launch requester, watchdog, relay-receiver).
4. Tests: each branch above for both routes; relayed-in rows (relay-receiver) to an unknown gse_
   still refused; scheduled message to a remote gse_ is inserted with `deliver_at` and is NOT
   relayed before due (assert via the arbiter ready query or existing helper).

### Task P7: docs (pigeon)

Update to match the code: `AGENTS.md` ("What never relays", discovery, launch results — goose
requesters and gse_ targets/senders now relay under the D2 rule), `.agents/skills/swarm-architecture/SKILL.md`
(:248, :296 area), `.agents/skills/swarm-operations/SKILL.md` (:151 area),
`docs/plans/2026-10-20-cross-machine-swarm-design.md` §4/§7 and
`docs/plans/2026-10-29-remote-launch-design.md` "Not in v1" (append a dated pointer to the new
design rather than rewriting history). Read each passage first; keep edits minimal and factual.

### Task H1: honk swarm MCP tools (design D4)

**Repo:** `/home/dev/projects/honk/.worktrees/goose-swarm-launch`. **Files:**
`crates/honk/src/swarm_mcp.rs`, `crates/honk/tests/swarm_mcp.rs` (tool-list pins ~:259, :327).
Reference implementations to port (read them):
`/home/dev/projects/pigeon/packages/opencode-plugin/src/swarm-launch-tool.ts`,
`swarm-schedule-tool.ts`, `swarm-scheduled-tool.ts`, and the `remote` branch of the plugin's
swarm_list (find it in `packages/opencode-plugin/src/`). Pigeon routes: `app.ts` `/swarm/launch`
(:918), `/swarm/schedule` (:986), `/swarm/scheduled` (:1114), cancel (:1141),
`/swarm/remote-sessions` (:1187).

- Every new tool gets `from` from `ensure_mailbox` (the `gse_` id), like `swarm_send`.
- `swarm_launch {machine, directory, prompt, tag?}`: body `{launch_id, from, machine, directory, prompt[, tag]}`;
  `launch_id = rl_<base36 unix ms>_<8 hex>` minted once per call; 6 attempts, backoff 500 ms
  doubling, cap 8 s; per-request timeout 30 s (`RequestBuilder::timeout`). Classification exactly
  as the plugin (4xx except 429 terminal; 429 queue_full/rate_limited terminal; 503
  target_offline/launch_unavailable/no_worker terminal; other 5xx and non-connection-refused
  transport errors are ambiguous → after the last attempt return a `pending` text, not an error;
  all attempts connection-refused → error). Texts mirror the plugin's (accepted → "Launch X
  accepted for M. The result arrives as a launch.result swarm message."; pending → "… Do NOT call
  swarm_launch again …").
- `swarm_schedule {message, at?, after?, to?, kind?, priority?, expires_in?, ref?}`: exactly one of
  at/after (client-side check); `to` defaults to self; `msg_id = msg_<base36 ms>_<8 hex>` minted
  once; same backoff; 503 never retried; 409 on attempt ≥ 2 → success "already banked"; 429/5xx
  transient; other 4xx permanent. Success text includes msg_id, deliver_at, expires_at (format as
  the plugin does).
- `swarm_scheduled {action: "list"|"cancel", msg_id?}`: list → `GET /swarm/scheduled?session=<gse>`
  formatted like the plugin; cancel → `POST /swarm/scheduled/<urlencoded id>/cancel {from}` with
  404/403/409 mapped to readable errors.
- `swarm_list {limit?, remote?}`: `remote: true` → `GET /swarm/remote-sessions[?limit=]`, rendered
  like the plugin's remote view (id, updated, machine, label, relay reachability, and this
  machine's `relay_send`).
- Tool descriptions: port the plugin's (they carry the message-economy and wake-payload rules).
  `swarm_send`'s description should no longer imply gse_ is local-only, if it does.
- Use the existing `bearer_auth` / token-file pattern. Use `rand` or `uuid` only if already a
  dependency (check `Cargo.toml`); otherwise derive hex from `getrandom`/time — no new heavy deps.
- Tests (in `crates/honk/tests/swarm_mcp.rs`, using the existing fake-pigeon harness there):
  launch accepted / pending-after-5xx / terminal 400 with pigeon's error+detail / same launch_id
  across retries / timeout override; schedule success, at+after both → error, 409-on-retry
  success; scheduled list and cancel; swarm_list remote rendering. Update tool-list pins.
- `cargo fmt`, `cargo clippy -p honk --all-targets -- -D warnings`, `cargo test -p honk` green.

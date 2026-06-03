# Triple-Injection Fix: Idempotent Command Delivery Over At-Least-Once Transport

**Date:** 2026-06-03
**Status:** Phase 1 implemented + committed (`39fd2f0`, on `main`). Phase 2 core (2a + 2b) implemented (not yet deployed). Optional 2c/2d/2e deferred.

> **For Claude:** Phase 1 is done (commit `39fd2f0`). Phase 2 core is done — see "Phase 2 implementation log" at the end. Read the "linchpin insight" and "at-least-once invariant" before touching this: at-least-once (never drop) is a hard constraint, and the plugin-side `commandId` dedup is the core mechanism (a daemon-only ledger does NOT fix the 2× because revive bypasses the plugin).

## Problem

When a user replies to an opencode session via Telegram **while the agent is
busy working its current turn**, the reply text is injected into the session
**up to three times** (observed in `ses_1e67fcd27ffeTiig7XQR5VoQ5q`). The agent
sees three copies of the same user message.

### Root cause

A non-idempotent side effect ("append this Telegram command as one user message
to opencode session S") sits behind an at-least-once transport and **two
independent timeout-triggered retry layers**, none of which can distinguish
"the request failed" from "the request succeeded but the response was slow/lost."
A request timeout is the classic *ambiguous* outcome.

The injection happens via two **different sinks** that share no dedup state:

1. Plugin path: daemon → `DirectChannelAdapter` → plugin `/pigeon/direct/execute`
   → opencode-serve `prompt_async`.
2. Revive path: daemon → `reviveAndDeliver` → opencode-serve `sendPrompt`
   (bypasses the plugin entirely).

Neither the plugin's `onExecute` (`packages/opencode-plugin/src/index.ts:78`)
nor `reviveAndDeliver` (`packages/daemon/src/worker/revive-and-deliver.ts:84`)
keys on `commandId`, so every (re)invocation re-injects.

### The three legs (single `commandId`)

The trigger is the daemon→plugin execute call timing out at 15s. That happens
when the single-threaded opencode-serve process is busy generating the current
assistant turn, so the plugin's in-process Node HTTP server can't respond
within 15s. The daemon's `AbortController` fires; aborting the client `fetch`
cancels the *wait*, not the server-side handler that already started — so the
injection completes server-side regardless.

| Leg | Code | Result |
|-----|------|--------|
| #1 | `executeViaOpencodeDirectChannel` attempt 1 (`packages/daemon/src/opencode-direct/adapter.ts:100`) | plugin injects; daemon aborts at 15s |
| #2 | adapter retry, `DEFAULT_MAX_RETRIES = 1` (`adapter.ts:55,125-128`) | plugin injects again; daemon aborts again |
| #3 | `isConnectionError("timed out")===true` → `reviveAndDeliver` → `sendPrompt` (`command-ingest.ts:371,411-428`) | opencode injects a third time |

Net: **one reply → three injections.**

### Log evidence (legs #2→#3 visible; #1↔#2 silent because the adapter logger isn't wired to console)

```
11:56:45 [command-ingest] delivery failed commandId=1691d1c8... error=Request timed out after 15000ms
11:56:51 [command-ingest] revived sessionId=ses_1e67... commandId=1691d1c8... (plugin-free fallback)
```

### Second opinion (ChatGPT, 2026-06-03)

Confirmed the analysis. Key points incorporated below:
- The **bug is the missing idempotency key**, not the timeout itself.
- Both injection paths must funnel through **one** idempotent sink keyed on
  `commandId`; plugin-only dedup is insufficient because the revive path bypasses
  the plugin.
- **Never auto-retry a non-idempotent op on an ambiguous timeout** without an
  idempotency key the sink enforces. `ECONNREFUSED` ("nothing was listening",
  definitely-not-delivered) is materially different from `timed out` ("caller
  stopped waiting", ambiguous).
- True effectively-once would require the dedup record inside the component that
  performs the durable transcript append (opencode core). We can't modify
  opencode core, so a daemon-side ledger is an *approximation* — accepted.
- Tradeoff for chat injection: ChatGPT leaned toward **do-not-duplicate (and
  surface unknown)** over **retry-and-maybe-duplicate**.

### Governing constraint (owner decision, 2026-06-03)

**We require at-least-once delivery: never drop a message.** A duplicate is an
annoyance; a dropped reply is data loss and unacceptable. This *overrides*
ChatGPT's "prefer do-not-duplicate" lean wherever the two conflict. Concretely:
on an ambiguous failure (timeout) we must still (re)deliver, accepting a possible
duplicate. The only way to get both at-least-once **and** no-duplicates is
idempotency at the sink (Phase 2).

---

## Phase 1 — Reduce duplication without dropping (implement now)

**One** surgical, low-risk change that removes the redundant *adapter* retry
(leg #2) while keeping the revive guarantee (leg #3) intact. After Phase 1 the
worst case drops from **3× → 2×** and at-least-once is preserved: we never drop.

> Earlier drafts of this plan also "stopped reviving on timeout" (a second
> change, "C"). That was **rejected**: it converts an ambiguous timeout into a
> dropped message (at-most-once), violating the governing constraint. We keep
> reviving on timeout. Getting to a true 1× *without* dropping is Phase 2.

### Change B — adapter makes a single execute attempt (removes leg #2)

The execute path is non-idempotent, so the adapter must not silently retry it on
its own — a retry re-injects. Pass `maxRetries: 0` from
`DirectChannelAdapter.deliverCommand` into `executeViaOpencodeDirectChannel`. We
do **not** change the `DEFAULT_MAX_RETRIES` constant (other callers/tests rely on
it); the change is scoped to the direct execute path.

This is safe for at-least-once: when the single attempt times out or the plugin
is unreachable, `command-ingest`'s existing `isConnectionError` branch still
revives via opencode-serve, which guarantees delivery.

- File: `packages/daemon/src/adapters/direct-channel.ts` — add `maxRetries: 0`
  to the `executeViaOpencodeDirectChannel` input.

### Why we deliberately keep reviving on timeout

A request timeout is **ambiguous**: the plugin may or may not have injected the
prompt before we stopped waiting. To honor at-least-once we must assume it might
*not* have landed and (re)deliver via revive. `command-ingest.ts`'s
`isConnectionError(result.error)` already returns `true` for `"timed out"`, so
the revive path fires — unchanged from production today. The residual duplicate
(when the original attempt *did* land) is removed in Phase 2 by an idempotency
key, not by dropping.

### Phase 1 behavior matrix

| Adapter result | Old behavior | New behavior (Phase 1) |
|---|---|---|
| ok | inject once, markDone | unchanged (1×) |
| `ECONNREFUSED` (plugin dead) | revive (inject via serve) / delete session | unchanged (1×, no dup — nothing landed) |
| `timed out` (plugin busy) | retry POST (+1 inject) **then** revive (+1 inject) → up to **3×** | single attempt **then** revive → up to **2×**; never drops |
| terminal (rejected/result.success=false) | ack and move on (no revive) | unchanged |

### Tests (TDD)

- `packages/daemon/test/opencode-direct-routing.integration.test.ts` —
  `onExecute` called **once** (was twice) now that the execute path doesn't retry
  on 500. (RED→GREEN watched.)
- `packages/daemon/test/command-ingest.test.ts` — new
  `at-least-once delivery on ambiguous timeout (never drop)` block: a `timed out`
  adapter failure **still** calls `sendPrompt` (revive) and acks. This is the
  regression guard that locks the at-least-once guarantee — it must keep passing.
- Existing `connection-error fallback (revive-on-reply)` block (ECONNREFUSED →
  revive) continues to pass unchanged.

### Phase 1 guarantee

- **At-least-once preserved.** Every reply is delivered at least once via the
  plugin attempt and/or the revive fallback. No code path drops a reply that the
  old code would have delivered.
- **Duplication reduced.** Worst case 3× → 2× by removing the redundant adapter
  retry.
- **Not exactly-once.** A busy session can still produce 2× (original attempt
  landed + revive). Eliminating that requires Phase 2.

---

## Phase 2 — Effectively-once without dropping (APPROVED for implementation)

> **Status (2026-06-03):** Owner approved building Phase 2. Implement with TDD.
> At-least-once is still the **hard invariant** — Phase 2 must never introduce a
> drop. Goal: collapse the Phase-1 worst case (2×) to **1× in the common case
> (plugin alive)** while preserving at-least-once.

### The linchpin insight (read before coding)

Phase 1 leaves a 2× because the timeout fallback **revives via
`sendPrompt`, which bypasses the plugin**. A daemon-side dedup ledger ALONE does
**not** fix this: on a timeout the daemon does not know the first attempt landed,
so it cannot dedup its own fallback. The only place that can recognise "I already
injected commandId X" on the retry is **the sink that performed the first
injection** — i.e. the **plugin** (which owns `prompt_async`).

Therefore the core of Phase 2 is **two coupled changes**:

1. **Make the plugin execute path idempotent on `commandId`** (the sink dedups).
2. **On an ambiguous timeout, retry through the (now idempotent) plugin instead
   of reviving via `sendPrompt`.** Reserve revive for `definitely_not_delivered`
   (ECONNREFUSED), where nothing was injected so there's nothing to duplicate.

`commandId` is already globally unique per Telegram command (minted by the
worker) and already travels in the execute envelope — no new key needed.

### At-least-once invariant (the rule that prevents regressions)

**Never skip or drop delivery based on uncertainty. Only the plugin may no-op,
and only when it has positively recorded that `commandId` was already injected.**

- Daemon side: keep retrying an ambiguous timeout (bounded) through the plugin.
  If retries are exhausted and we still have no confirmation, fall back to revive
  (`sendPrompt`) — accepting a possible duplicate — rather than dropping.
- The existing `inbox` table already dedups worker **re-lease** of a command
  whose status is `done` (`InboxRepository.persist` = `INSERT OR IGNORE`; skip if
  `done`). Do not regress that.

### 2a. Plugin-side idempotency on `commandId` (`packages/opencode-plugin/src/direct-channel.ts` / `index.ts`)

In `onExecute`, before calling `prompt_async`:
- Maintain `Map<commandId, { status: "in_flight" | "succeeded"; result?; expiresAt }>`.
- **Record the entry synchronously BEFORE the first `await`** (prevents two
  concurrent duplicate POSTs from both injecting).
- If `commandId` already present:
  - `succeeded` → return the cached success (`result.status = "duplicate"`), do
    NOT call `prompt_async`.
  - `in_flight` → await the in-flight promise (or return `duplicate` accepted).
- After `prompt_async` resolves OK → mark `succeeded` (cache result).
- TTL-evict entries (≈1h; must exceed the daemon's bounded-retry window). In-memory
  only — lost on opencode-serve restart (see residual).
- Tests (`packages/opencode-plugin/test/…` — mirror existing direct-channel tests):
  same `commandId` twice → `prompt_async` called **once**; concurrent duplicates →
  one injection; different `commandId` → two injections.

### 2b. Daemon: retry-through-plugin on ambiguous, revive only on dead plugin

Reintroduce `classifyDeliveryFailure(error)` →
`"definitely_not_delivered" | "ambiguous" | "terminal"` (the version from the
reverted Phase-1 Change C — see git history of this file / commit 39fd2f0's parent
discussion). In `command-ingest.ts` `deliverViaAdapter`:
- `ambiguous` (timeout/reset) → re-attempt via the **plugin** adapter, bounded
  (e.g. up to N attempts with backoff, total < 60s worker lease). The plugin
  dedups, so a landed-first-attempt yields 1×. On success → `markDone`. If all
  attempts remain ambiguous → revive via `sendPrompt` as last resort (possible
  dup, never drop) → `markDone`.
- `definitely_not_delivered` (ECONNREFUSED/DNS/`fetch failed`) → revive
  immediately (existing path; safe, nothing landed).
- `terminal` → unchanged (ack, move on).
- Re-enable the adapter retry for execute **only** once the plugin is idempotent
  (i.e. revert Phase-1 `maxRetries: 0` to a small N), OR drive retries from
  `command-ingest`. Pick one layer; don't double-retry.
- Tests: ambiguous timeout where plugin "already saw commandId" → exactly one
  injection end-to-end; ambiguous where plugin never got it → redelivered;
  ECONNREFUSED → revive; nothing ever dropped.

### 2c. (Optional hardening) durable injection ledger (better-sqlite3)

Only needed to dedup across **daemon restarts** and to record `unknown` for
later reconciliation. The inbox + plugin dedup cover the common cases; add this
only if cross-restart duplicates prove to matter in practice.

```sql
CREATE TABLE IF NOT EXISTS injection_idempotency (
  idempotency_key   TEXT PRIMARY KEY,   -- 'opencode-inject:v1:<machineId>:<commandId>'
  command_id        TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,      -- sha256(sessionId + '\0' + text); reuse w/ different payload = loud error
  status            TEXT NOT NULL,      -- 'in_flight' | 'succeeded' | 'failed_terminal' | 'unknown'
  first_attempt_at  INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  result_json       TEXT
);
```
**Skip delivery ONLY when status = `succeeded`.** `in_flight`/`unknown`/absent →
deliver (at-least-once). TTL ≥ 24h (must exceed the full replay horizon, not just
the 60s lease).

### 2d. (Optional) one idempotent sink + lint guard

Funnel the plugin path and `reviveAndDeliver` through a single
`injectUserCommandOnce({ commandId, sessionId, text })` and ban direct
`prompt_async`/`sendPrompt` calls elsewhere, so the two sinks can't drift again.

### 2e. (Optional) question-reply path

Route question replies through the same idempotency so the
`throwIfTransientQuestionReplyFailure` → worker re-lease loop can't double-deliver
(currently mostly masked by opencode's "already answered" response).

### Residual / long term

- Plugin dedup is in-memory: a timeout followed by an opencode-serve **restart**
  before the daemon's retry can still duplicate (new plugin has no memory; revive
  bypasses it). Durable plugin dedup (2c) or reconciliation shrinks this; only
  opencode-core accepting an idempotency key on message-append removes it fully.

---

## Rollout

1. Phase 1 (commit `39fd2f0`) lands on `main`; deploy daemon per
   `cross-device-deployment` (daemon-only; no worker/plugin changes).
2. Validate Phase 1: reply to a **busy** session; confirm ≤ 2× and never 0×.
3. Phase 2: plugin + daemon changes → deploy both. Validate: reply to a busy
   session → exactly 1× in the common (plugin-alive) case; never 0×.

---

## Phase 2 implementation log (2026-06-03)

Built the **core** (2a + 2b). Optional 2c/2d/2e were **not** built (see below).

### What landed

**2a — plugin execute sink idempotent on `commandId`:**
- New `packages/opencode-plugin/src/execute-dedup.ts` → `withExecuteDedup(onExecute, { ttlMs?, now? })`. In-memory `Map<commandId, in_flight|succeeded>`; records the in-flight entry **synchronously before** invoking `onExecute` (deferred-promise pattern) so concurrent duplicate POSTs piggyback on one injection. Caches **successes only** (TTL default 1h); failures and throws are evicted so retries re-attempt (at-least-once). A repeat of a `succeeded` key returns the cached result with `output: "duplicate"`.
- Wired in `startDirectChannelServer` (`direct-channel.ts`) so the sink is idempotent by construction for every caller (plugin `index.ts` and tests). New optional `DirectChannelOptions.executeDedup`.
- Tests: `packages/opencode-plugin/test/execute-dedup.test.ts` (7 unit cases) + an HTTP-boundary case in `test/direct-channel.test.ts` (same `commandId` twice over the wire → `onExecute` once, 2nd response `output:"duplicate"`).
- **Did not touch `index.ts`** (the uncommitted DEBUG instrumentation lives there). Wiring the dedup into `startDirectChannelServer` covers `index.ts`'s `onExecute` for free.

**2b — re-enable the adapter retry (now safe):**
- `packages/daemon/src/adapters/direct-channel.ts`: `maxRetries: 0` → `maxRetries: 1`. Small N (≤2×15s) keeps a single command under the worker's 60s lease and minimises blocking of the sequential poller. The retry carries the same `commandId`; the now-idempotent plugin dedups it → a landed-but-slow first attempt collapses to 1×.
- Tests: new `packages/daemon/test/direct-channel-adapter.test.ts` (abort on attempt 1 → success on attempt 2 → `ok`, 2 fetches). Updated the integration "plugin handler throws exception (500)" case to expect **2** `onExecute` calls (throws aren't deduped → retried for at-least-once).

### Deliberate deviations from the design above

- **No `classifyDeliveryFailure` in `command-ingest`.** Under the at-least-once
  constraint, both `ambiguous` (timeout) and `definitely_not_delivered`
  (ECONNREFUSED) ultimately revive on persistent failure, so classification
  would not change behaviour. The adapter's bounded idempotent retry handles the
  ambiguous case; `command-ingest`'s existing `isConnectionError → revive` stays
  as the last-resort safety net (unchanged). Adding a classifier would be dead
  complexity. **`command-ingest.ts` was not modified.**
- **2c (durable ledger), 2d (single sink + lint), 2e (question-reply path) not
  built.** They are hardening for cross-restart dedup and sink-drift prevention;
  the inbox + plugin dedup cover the common cases. Revisit only if cross-restart
  duplicates show up in practice.

### Resulting guarantee

- **Common case (plugin alive):** busy-session reply → **1×** (adapter retry hits
  the idempotent plugin).
- **At-least-once preserved:** a turn that stays busy across both adapter attempts
  falls through to the last-resort revive (possible 2×, **never 0×**). Plugin
  death (ECONNREFUSED) → revive (1×, nothing landed).
- **Residual:** plugin dedup is in-memory → a timeout followed by an
  opencode-serve restart before the retry can still duplicate (revive bypasses
  the plugin). Shrunk, not eliminated; only opencode-core idempotency removes it.

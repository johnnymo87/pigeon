# Triple-Injection Fix: Idempotent Command Delivery Over At-Least-Once Transport

**Date:** 2026-06-03
**Status:** Design — Phase 1 approved for implementation; Phase 2 forward-looking

> **For Claude:** Phase 1 is implemented task-by-task with TDD (see `superpowers:test-driven-development`). Phase 2 is a forward-looking design captured here and tracked in beads; do **not** implement Phase 2 unless explicitly asked.

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

## Phase 2 — Durable effectively-once (forward-looking; do NOT build yet)

Goal: make injection effectively-once across **both** sinks and across daemon /
opencode-serve restarts, so we can safely re-enable retries.

### 2a. One idempotent sink

Introduce a single `injectUserCommandOnce({ commandId, sessionId, text, ... })`
in the daemon. It is the **only** code allowed to call the plugin execute path or
`reviveAndDeliver`/`sendPrompt`. Ban direct calls elsewhere (lint/code-review
rule). This kills sink drift structurally.

### 2b. Durable idempotency ledger (better-sqlite3)

```sql
CREATE TABLE IF NOT EXISTS injection_idempotency (
  idempotency_key   TEXT PRIMARY KEY,   -- 'opencode-inject:v1:<machineId>:<commandId>'
  command_id        TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,      -- sha256(sessionId + '\0' + text); reuse-with-different-payload = loud error
  status            TEXT NOT NULL,      -- 'in_flight' | 'succeeded' | 'failed_terminal' | 'unknown'
  first_attempt_at  INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  result_json       TEXT
);
```

Flow: `INSERT OR IGNORE` the key as `in_flight` **before** injecting. If the row
already exists → skip (duplicate) and ack. After injecting, set `succeeded`.
On ambiguous failure → `unknown` (hold for reconciliation; do not blind-retry).
On terminal → `failed_terminal`. TTL ≥ 24h (must exceed the full replay horizon:
worker 60s lease + daemon retry + restart/recovery + manual replay + D1
retention), **not** just the 60s lease.

### 2c. Plugin-side in-memory dedup (defense-in-depth)

Record the key **synchronously before the first `await`** (in-flight map) so two
duplicate POSTs racing into the plugin can't both inject. Returns cached result
on repeat. In-memory only — a shield, not the source of truth (lost on restart).

### 2d. Re-enable safe retries + ack semantics

Once the sink is idempotent, retrying ambiguous timeouts becomes safe (the retry
carries the key). The plugin should ack on **durable acceptance**, distinguishing
transport-ack / side-effect-result / agent-result. Response shape: `result.status`
∈ `queued | duplicate`.

### 2e. Also covers the question-reply path

Route question replies through the same ledger so the
`throwIfTransientQuestionReplyFailure` → worker re-lease loop can't double-deliver
(currently mostly masked by opencode's "already answered" behavior).

### Long term

If opencode ever accepts an idempotency key / metadata on a user message, move
the dedup boundary into opencode's transcript append — the only place that can
make injection *truly* effectively-once.

---

## Rollout

1. Phase 1 lands on `main`, deploy daemon per `cross-device-deployment`. No worker
   or plugin changes required for Phase 1 (daemon-only).
2. Validate with the bug repro: reply to a busy session; confirm a single
   injection and a clean ack.
3. Phase 2 scheduled separately (beads).

# Triple-Injection Fix: Idempotent Command Delivery Over At-Least-Once Transport

**Date:** 2026-06-03
**Status:** Phase 1 committed (`39fd2f0`, on `main`). Phase 2 core (2a + 2b) implemented + hardened per ChatGPT review (payload_hash + deadline-aware retry-through-plugin). Not yet deployed. Optional 2c/2d/2e + items C/D/E deferred (see "Review round 2").

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

Built the **core** (2a + 2b), then hardened it after a ChatGPT code review (see
"Review round 2"). Optional 2c/2d/2e were **not** built (see "Deferred").

### 2a — plugin execute sink idempotent on `commandId`

- New `packages/opencode-plugin/src/execute-dedup.ts` → `withExecuteDedup(onExecute, { ttlMs?, now?, log? })`. In-memory `Map<commandId, { status: in_flight|succeeded; payloadHash }>`; records the in-flight entry **synchronously before** invoking `onExecute` so concurrent duplicate POSTs piggyback on one injection. Caches **successes only** (TTL default 1h); failures and throws are evicted so retries re-attempt (at-least-once). A repeat of a `succeeded` key returns the cached result with `output: "duplicate"`.
- A **synchronous** throw from `onExecute` is caught (try/catch) and converted to a rejection that clears the entry — otherwise it would leak a stuck `in_flight` and hang every duplicate (review fix; not reachable today since the real handler is `async`, but a latent utility bug).
- **`payload_hash` guard (review item A):** each entry stores a sha256 over the *semantic* payload (`sessionId` + `command` + media mime/filename/url; excludes volatile metadata). On a `commandId` hit with a **different** hash we treat the two as genuinely distinct messages and **deliver this one anyway** (loud `log(...)` for operators) rather than returning the prior cached success. Rationale: a silent dedup there would **drop** a user message, and never-drop outranks the dedup invariant. (This deviates from the reviewer's "return 409 / don't ack" suggestion for the same never-drop reason.)
- Wired in `startDirectChannelServer` (`direct-channel.ts`) so the sink is idempotent by construction for every caller (plugin `index.ts` and tests). New optional `DirectChannelOptions.executeDedup`. **Did not touch `index.ts`** (uncommitted DEBUG instrumentation lives there).
- Tests: `packages/opencode-plugin/test/execute-dedup.test.ts` (11 unit cases incl. sync-throw + payload-hash) + an HTTP-boundary case in `test/direct-channel.test.ts`.

### 2b — retry ambiguous timeouts *through the idempotent plugin*, revive only as last resort

After the review, the retry layer moved from the adapter into `command-ingest`
(one layer, deadline- and classification-aware). The adapter is back to a
**single attempt** (`DirectChannelAdapter` `maxRetries: 0`).

- New `classifyDeliveryFailure(error)` in `command-ingest.ts` →
  `ambiguous` (timeout/abort) | `definitely_not_delivered` (refused/DNS/network) | `terminal` (else). `isConnectionError` now delegates to it (= `!== terminal`), so the keyword set lives in one place and question-reply behaviour is unchanged.
- `deliverViaAdapter` now runs a **deadline-aware budget loop**: while the failure is `ambiguous` and we're within `DEFAULT_DELIVERY_BUDGET_MS` (40s, < 60s lease → ~3 attempts), it re-delivers through the (idempotent) plugin. `definitely_not_delivered` skips the loop and revives immediately (retrying a dead plugin can't help). `terminal` is acked and dropped (no connection-shaped error; revive wouldn't help — pre-existing behaviour). On budget exhaustion with a still-ambiguous failure it falls through to the existing **revive** fallback (possible dup, never a drop). New injectable `now` / `sleep` / `deliveryBudgetMs` options for testing.
- Tests: `command-ingest.test.ts` adds "retries within budget then succeeds (no revive)" and "retries then revives when persistently busy"; existing ambiguous tests pin the budget to 0 to exercise the immediate-revive path. `direct-channel-adapter.test.ts` now locks the **single-attempt** adapter; the integration "plugin handler throws (500)" case expects **1** `onExecute` call (terminal, not retried).

### Resulting guarantee

- **Common case (plugin alive):** busy-session reply → **1×**. The plugin dedups the in-budget retries, so a landed-but-slow first attempt never duplicates; turns that free up within ~40s get a clean single delivery.
- **At-least-once preserved:** a turn that stays busy past the budget falls through to the last-resort revive (possible 2×, **never 0×**). Dead plugin (refused) → immediate revive (1×, nothing landed). `payload_hash` mismatch → deliver anyway (never drop).
- **Residual (known, accepted):** in-memory dedup → a timeout followed by an opencode-serve **restart** before the retry can still duplicate (revive bypasses the plugin). Only opencode-core idempotency removes it fully.

---

## Review round 2 (ChatGPT, 2026-06-03) — verdict + dispositions

> "The core architecture is the right one under your constraints… put idempotency as close as possible to the non-idempotent append sink, retry ambiguous failures through that idempotent path, and only use non-idempotent fallback when preserving at-least-once requires it. The remaining problem is that revive is still outside that architecture."

**Acted on:** sync-throw fix; `payload_hash` guard (item A); deadline-aware
retry-through-plugin + classification (item B); verified the "ambiguous timeout
→ terminal drop" worry does **not** occur (`isConnectionError` matches
`timed out`/`abort` → revive; locked with a parametrized regression test).

### Deferred / maybe-later (revisit triggers in parens)

- **C — daemon per-`commandId` single-flight lock.** The inbox skips a re-lease only when the row is already `done`; it does **not** prevent two *concurrent* processors of the same still-unfinished command (worker re-lease while a long delivery is in flight). If both fall through to **revive**, that's a 2× the plugin dedup can't catch. Low probability now (a delivery is < ~45s ≪ 60s lease), but real. *Revisit if:* deliveries routinely approach the lease, or duplicates appear with concurrent-ingest log signatures. Fix: a CAS `processing` status or an in-process mutex keyed by `commandId`.
- **Revive still bypasses the dedup authority** (the architectural residual the reviewer keeps flagging). The deadline-aware budget shrinks the window; fully closing it needs either a daemon-accessible delivery-state ledger that **revive** also consults (≈ deferred 2c/2d) or opencode-core idempotency. *Revisit if:* the in-memory + budget approach still produces noticeable duplicates in practice.
- **Sequential-poller blocking (tradeoff introduced by B).** The poll loop is sequential (`poll(); await dispatch()`), so an ambiguous delivery can now hold the loop for up to ~40s, delaying commands to *other* sessions on the same machine. Acceptable on single-session machines; worse on busy multi-session ones. *Revisit if:* multi-session machines see latency. Fix: make the poller concurrent, or move long retry/revive off the poll loop (e.g. a delivery worker pool), then the budget can be raised without head-of-line blocking.
- **D — missing `commandId`.** Reviewer suggested rejecting with 400; we **keep** the execute-bypass (`!key → onExecute`) because rejecting would **drop** the message (violates never-drop). The validator already requires `commandId`, so this is defensive only. *Revisit if:* we ever want loud detection — log a warning instead of rejecting.
- **E — observability polish.** (1) `withExecuteDedup` overwrites `output` with `"duplicate"` on a cache hit, discarding the original output; prefer a separate `duplicate: true` field (needs an `ExecuteResult` type change). (2) Split TTLs for `in_flight` vs `succeeded`. (3) Log `in_flight` evictions at warn level (they're duplicate-risk events). *Revisit if:* debugging dedup behaviour in prod gets painful.
- **Reviewer residuals we accept as inherent** (no action, need opencode-core support): `prompt_async` returning success before the append is durable could mask a lost message; an HTTP-500 *after* a successful append-then-crash could duplicate on retry (not reachable in our `onExecute`, which only throws *before* the append).

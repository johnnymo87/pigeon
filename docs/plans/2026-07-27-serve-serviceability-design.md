# Serve serviceability: closing pigeon-886

Status: REVISED after adversarial review — ready to implement with the amendments in §5.1
Bead: `pigeon-886`
Verification: `pigeon-ntk` (closed — all six items answered)
Related: `pigeon-f2a` (flap alerting), `pigeon-amr` (drain lever under skew),
`pigeon-h21` (arbiter queue wedge — found by this review), `pigeon-zjv` (closed,
FALSIFIED — read its correction before proposing a self-probe)

> **Revision note (2026-07-27).** The first draft's core recommendation was correct in
> concept and **wrong in mechanism**, in the same shape as the error that falsified
> `pigeon-zjv`. Draft §6 said the verdict should be ANDed into `isServeHealthy`; that
> silently selects *evacuation by lease-steal* and would kill in-flight turns — the exact
> June failure — because `placeSession` has no live-lease guard. Verified independently
> (§5.1 A). Five amendments in §5.1; the option analysis in §1–§5 stands.

## 1. The problem, stated precisely

A serve can be **live, responsive, and completely unable to do its job**, and pigeon
will keep routing sessions to it indefinitely.

`IngressRouter.isServeHealthy` (`packages/daemon/src/routing/router.ts:49-57`) admits a
serve on four conditions: `health_state === 'healthy'`, a fresh `heartbeat_at`,
`!draining`, and a matching `binary_epoch`. Every one of those is satisfied by a serve
that cannot serve.

The reason is that **all four are attested by components that keep working when the
serve stops working**:

| Signal | Written by | Survives a broken serve? |
|---|---|---|
| `health_state='healthy'` | the serve's own heartbeat, unconditionally, every 5s | **yes** — and see below |
| `heartbeat_at` | same statement | **yes** |
| `draining` | only `markDead` (shutdown) and `selfHeal` | yes |
| `binary_epoch` | `registerSelf` at boot | yes |

The heartbeat runs on a **worker thread** — deliberately, as serve-lease "Fix C"
(`serve-lease.patch:1180-1190,1313`), to stop pigeon false-declaring a busy serve dead.
The workstation ops skill states the consequence plainly: it *"attests 'worker can write
sqlite', not 'serve can serve'"*. Fix C solved a real flapping incident (§2) and should
not be reverted; but it means liveness attestation is now **structurally decoupled** from
serviceability.

In `self` liveness mode — which is what **all three hosts run** (`pigeon-ntk` item 4) —
the serve is effectively the sole writer of its own health. That is the bug in one
sentence: **the component being judged is the only judge.**

> **Correction.** An earlier draft said "pigeon never writes `health_state` at all" in self
> mode. That is false. `sweepStale` (`serve-health-poller.ts:75-91`) writes
> `health_state='unhealthy'` on a stale heartbeat and *is* wired in self mode
> (`index.ts:54-58`). It is inert in every wedge class we care about — the worker-thread
> heartbeat keeps `heartbeat_at` fresh, so the staleness condition never fires — but a
> conditional second writer already exists, and rule 3 below must be read with that in
> mind rather than as an absolute invariant.

### 1.1 Two failure classes, only one of which is covered

| Class | Example | Detected today? |
|---|---|---|
| **A. Process/loop dead** | crash, port unbound, event loop frozen | **Yes** — systemd canary, ~8 min (1-min timer × 7 failures) |
| **B. Responsive but not serviceable** | every prompt 500s in ~15ms; DB locked; provider auth dead; session queue jammed | **No. Nothing detects this, ever.** |

Class B is the bead's real content, and it is **unbounded**. My earlier "canary-bounded
~8 min" framing was wrong for it, and `pigeon-886`'s title has been corrected.

### 1.2 Why the only probe we have cannot see class B

`GET /global/health` is a static constant:

```ts
// packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:75-77
const health = Effect.fn("GlobalHttpApi.health")(function* () {
  return { healthy: true as const, version: InstallationVersion }
})
```

`InstallationVersion` is an imported constant. The route is on `RootHttpApi`, which
deliberately does **not** receive `instanceContextLayer` or `workspaceRoutingLayer`
(`server.ts:112-116` vs `145-155`) — so it performs no instance bootstrap, no workspace
resolution, no DB access. No patch modifies it.

**A passing probe proves only "the process is alive and its event loop is turning."** The
500-in-15ms class *by construction* has a responsive loop — that's why it returns in
15ms — so it passes forever.

This invalidates a large part of the option space, including options I previously
recommended. Every existing consumer of this probe inherits the blind spot: the serve
canary (`hosts/cloudbox/configuration.nix:1024-1025`), pigeon's `ServeHealthPoller`, the
frontdoor wedge probe (`src/wedge.ts:40`, `src/health.ts:9-21` — discards the body), and
the frontdoor canary. The maintainers half-know: `configuration.nix:1031-1034` notes the
body is used only for the version field and does drift detection out-of-band via
`/proc/<pid>/exe`.

> **Design rule 1: a liveness probe cannot establish serviceability.** Any direction whose
> only evidence is `/global/health` is disqualified for class B.

## 2. Constraint: do not reintroduce flapping

This is not hypothetical. From the live routing DB (`pigeon-ntk` item 6): **407
assignments carry 2,634 cumulative serve moves**; `owner_generation` reaches 25; on
2026-06-23 *every one of* 59 assignments had `gen ≥ 10`; devbox independently measured
`gen` up to 48. Four in-flight turns were killed ("session lease lost mid-run"). Root
cause: `sweepStale` false-positived against a *live but busy* serve and evacuated it.

Three mitigations hold it closed today: the live-lease eviction guard
(`router.ts:299-312`), `PIGEON_SERVE_STALE_MS=20000`, and Fix C. Zero incidents since
2026-07-02.

Two lessons bind this design:

> **Design rule 2: any new "unhealthy" verdict must not be able to evict a serve that is
> genuinely working but slow.** A CPU-heavy turn must never look like a dead serve.

> **Design rule 3: a second writer to `health_state` is forbidden.** Pigeon's `setHealth`
> touches the same two columns as the heartbeat at the same 5s cadence, so the two writers
> fight and the slot flaps. Flapping also *poisons evacuation*, because
> `reassignFromDeadServe` → `placeSession` (`router.ts:313`) picks from the healthy set at
> that instant and can re-place a session straight back.

## 3. Constraint: the schema is cheaper than we thought — in one specific way

`pigeon-ntk` item 2 corrected a load-bearing assumption. The serve's
`EXPECTED_DDL_CHECKSUM` is SHA-256 over **pigeon's `ROUTING_DDL` template string**
(`route-schema.ts:52`), *not* over `sqlite_master` or the live schema.

| Change | Serve coordination |
|---|---|
| New **table** outside `ROUTING_DDL` | **none** — free |
| Column via existing `runAdditiveMigrations` (`storage/schema.ts:30-60`) | **none** — free |
| Any edit to `ROUTING_DDL` | 8-step cross-repo lockstep; slip ⇒ pool-wide crash-loop |

Proven empirically: the live DB already carries 11 tables and 18 indexes on the same file
while the checksum validates.

> **Trap:** `ROUTING_DDL` uses `CREATE TABLE IF NOT EXISTS`, so adding a column *inside* it
> is a silent no-op on every existing DB — the column is never created, while the checksum
> mismatch separately bricks every serve. On mismatch the serve throws *after* the listener
> binds and logs "listening", via `Effect.promise` ⇒ unrecoverable defect ⇒ exit 1 ⇒
> `Restart=always` crash-loop. There is no migration mechanism.

> **Design rule 4: durable state is affordable, but only as a new table or an additive
> column. Never touch `ROUTING_DDL`.**

## 4. What we can stop worrying about

- **Evacuation is not blocked.** Lease renewal runs on the **main loop**
  (`Effect.forkScoped`, `serve-lease.patch:1544-1580`), TTL 30s / renew 10s, scoped to an
  in-flight run. A wedged serve stops renewing; the guard at `router.ts:309-311` releases
  within 30s, and immediately in the 500-in-15ms case (the scoped finalizer releases). The
  worker thread beats `serve_instance` only.
- **No second DB reader.** Only the daemon reads `serve_instance` for routing; frontdoor,
  `oc-auto-attach`, `oc-pool-attach`, `opencode-launch` and TUI attach all go through
  `GET /route`. So a daemon-internal verdict is not invisible to anyone — *provided* it is
  threaded into `listHealthy`/`resolveRoute`, which read health back from SQLite.
- **No host runs `http` mode**, so the `setHealth`-vs-heartbeat write war is not live
  anywhere today. It is a trap waiting for whoever flips the default, not a current bug.

## 5. Options

Directions (i)–(iv) were carried in from the bead. Verification eliminated or demoted most
of them; (v) is new and is the only one that addresses class B directly.

| # | Direction | Class A | Class B | Cost | Verdict |
|---|---|---|---|---|---|
| i | Reachability column/table, probe-fed | yes | **no** | low (rule 4) | insufficient alone |
| ii | Heartbeat stops asserting `healthy` | yes | no | very high | **reject** |
| iii | In-memory verdict, probe-fed | yes | **no** | lowest | insufficient alone |
| iv | Dead-man's switch on main loop | yes | **no** | medium + pool bounce | **demoted** |
| v | **Outcome-based verdict** | partly | **yes** | low–medium | **recommended core** |

**(ii) Reject.** Requires an opencode-patched change plus a full pool restart before it
does anything; every other `healthy`-writer must be swept in the same change; the column's
meaning is ambiguous during the mixed-binary window.

**(iv) Demoted — this is the important reversal.** A dead-man's switch degrades health when
the main loop stops bumping a shared timestamp. That detects *loop starvation* — which is
**class A, already covered by the canary**. It is blind to class B, the unbounded one. It
is a genuine improvement in latency-to-detect for class A (≈30s vs ≈8min) but it does not
touch the actual bug. I previously recommended it as the follow-on; that was wrong.

**(v) Outcome-based verdict — the proposal.** Stop asking the serve whether it is well and
start observing whether work sent to it succeeds. N consecutive *delivery* failures against
a serve is direct evidence of unserviceability. It requires no new endpoint, and it is
immune to the probe/work gap **by construction** — it measures the actual thing.

Properties against the rules: it need never write `health_state` (rule 3 ✓); it cannot be
fooled by a static 200 (rule 1 ✓); a slow-but-working serve *succeeds*, just late, so it is
not evicted (rule 2 ✓ — **only if** we count failures and never latency; see §5.1 C, which
is stricter than it sounds).

An accidental strength worth recording: **provider outages cannot poison this signal.**
`prompt_async` returns 200 at *accept*, before any provider call is made. Model and
provider failures are asynchronous and invisible to the delivery outcome, so a
provider-wide outage does not mark every serve suspect.

Its weakness is the mirror image: a serve producing **no daemon-visible outcomes** is not
evaluated. That is broader than "idle" — see §5.1 E.

> **The draft's supporting claim was wrong and is withdrawn.** It said pigeon "already has"
> this evidence, citing command-delivery failures and the swarm arbiter. Both cited sources
> are defective:
>
> - **Command-delivery failure is a signal about the *plugin*, not the serve.**
>   `DirectChannelAdapter` posts to `session.backendEndpoint`
>   (`adapters/direct-channel.ts:22`) — a *separate ephemeral-port listener the plugin binds
>   itself* (`opencode-plugin/src/direct-channel.ts:91-101`, `port ?? 0`). ECONNREFUSED
>   there means this session's plugin is gone, which is exactly why the existing consumer
>   treats it as *session* death. Concrete false-positive: the nightly workspace reset kills
>   every main-tmux TUI, so the next morning every delivery ECONNREFUSEs on a dead plugin
>   port — counting those per-serve would mark the entire pool suspect every single morning.
>   **This signal must be excluded from the verdict.**
> - **The arbiter's signal is real but currently unattributable.** `OpencodeClient.baseUrl`
>   is `private readonly` (`opencode-client.ts:7`), so the arbiter cannot say which serve a
>   failure belongs to. Errors are flat strings (`opencode-client.ts:112`), and
>   404-session-gone, `PermanentDeliveryError`, "no healthy serve" and directory-resolution
>   failures (`arbiter.ts:91-96,118`) are all non-serve failures needing filtering.
>
> The repair is cheap and stays single-repo (§5.1 B), so this does not change the plan's
> ordering — but a cold implementer reading the draft would have wired up the plugin-channel
> signal, which is why the claim is called out rather than quietly fixed.

## 5.1 Amendments (binding — the design is these five points)

### A. The verdict must NOT be ANDed into `isServeHealthy`

This is the draft's severe error. Tracing the sentence *"`isServeHealthy` ANDs in 'not
currently suspect'"* through the code:

1. `resolveRoute` returns `null` for **every** session on a suspect serve — including
   sessions holding a live lease mid-turn (`router.ts:67`).
2. Every daemon-internal touch runs `clientForSession` → `forSession` → `ensureRouted`
   (`client-factory.ts:16`) → on null → **`placeSession`** (`router.ts:240`).
3. **`placeSession` has no live-lease guard.** Verified: `router.ts:163-200` goes straight
   from `listHealthy` → pick → `upsert` with a bumped `owner_generation` (`:189-195`). The
   guard exists *only* in `reassignFromDeadServe` (`router.ts:299-312`) — the Fix-A comment
   describing precisely this kill.
4. `acquireCAS`'s take-over ladder branch B — *same epoch, higher generation wins*
   (`route-repo.ts:350-352`) — **steals the live lease**; the serve's `renewCAS` then fails
   and the turn dies with "session lease lost mid-run."

Triggers are constant, not rare: the swarm arbiter calls `clientForSession` on every queued
message (`index.ts:303`, 500ms tick) and every Telegram command does too
(`index.ts:120,151,166,181,…`). Today the path is unreachable only because `isServeHealthy`
almost never flips false while a lease is live. The verdict would make it routine —
and precisely while a serve is busy failing, i.e. when its sessions are most likely mid-turn.

**Amendment:** thread the verdict into `listHealthy` filtering at `placeSession`
(`router.ts:163`) and into `resolveProspectiveRoute` branches 2–3 (`router.ts:126,130`).
**Never into `resolveRoute`.** Suspicion then stops new placements and idle re-picks while
in-flight and leased sessions are untouched, and the steal path is structurally unreachable.

This also **settles §7 Q3**: it is not a judgment call. The "evacuate" side loses, because
the only evacuation primitive that exists is the one that killed four turns in June.
Evacuation of a suspect-but-live serve should not exist; if the serve is genuinely dead its
leases lapse within 30s on their own (§4).

### B. Signal definition: serve-directed HTTP outcomes only, attributed and filtered

- **Include:** connection-refused and **5xx** from daemon→serve `OpencodeClient` calls.
- **Exclude:** the plugin direct-channel signal entirely (see §5 box); all **4xx**
  (404-session-gone is not serve ill-health); `PermanentDeliveryError`; "no healthy serve";
  directory-resolution failures.
- **Requires** exposing serve attribution in the client factory — `baseUrl` is currently
  private (`opencode-client.ts:7`). Small, daemon-local, single-repo.

### C. Timeouts must NEVER count toward the verdict

The draft listed transport failure as *"ECONNREFUSED, timeout, 5xx."* Including timeouts
violates rule 2 directly: a CPU-pegged main loop mid-heavy-turn delays even the cheap
`prompt_async` accept, and that is the exact state Fix C exists to protect. Counting
timeouts marks *busy* serves suspect; combined with the draft's amendment-A bug it would
have killed their turns.

Excluding timeouts leaves accept-but-hang invisible to the verdict — **and that is
correct**, because the canary genuinely covers it: a frozen or starved loop fails
`curl --max-time 3` against `/global/health` (`configuration.nix:1029-1041`) and is
restarted at ~8 min. The split is clean:

> **hangs → canary. Refused + fast-5xx → outcome verdict.**

Separately, the missing timeout on `sendPrompt` is a real bug — filed as `pigeon-h21` — but
it must be fixed for queue-liveness reasons only, feeding nothing into the verdict.

### D. Anti-poisoning, and recovery that can actually fire

- **≥2 distinct sessions** must contribute failures within the window before a serve becomes
  suspect. Without this, one session that reliably 500s for session-specific reasons marks a
  healthy serve suspect — and the arbiter retries a single failing message up to 10 times
  against the same target (`arbiter.ts:16,127-141`), so one session can produce the whole
  consecutive-failure run by itself.
- **Key the verdict on `(serve_id, instance_uuid)`, not `serve_id`.** Restarting the unit is
  the documented cure for most class-B states; a fixed serve re-registers with a fresh
  `instance_uuid`, which is a free and reliable "this is a new process" signal already in
  the row. Keyed on `serve_id` alone, a fixed serve inherits stale suspicion.
- **Half-open probation.** "A positive success is required to leave suspect" is
  *unsatisfiable as stated*: suspicion stops placements, so a suspect serve receives no
  traffic, produces no success, and stays suspect until the daemon restarts. On devbox and
  darwin (**K=2**, `serve-pool.nix:36-39`) that is a permanent 50% capacity loss from one
  bad hour, and "never all suspect" degenerates to "at most one, chosen by arrival order."
  Amend to the standard circuit-breaker shape: after T minutes, admit **one trial
  placement** and judge its outcome. Elapsed time triggers the trial; success still closes
  the breaker.

### E. The verdict sees only the daemon's slice

The frontdoor resolves via `GET /route` and then proxies **directly to serves**
(`resolve.ts:34-80`, `proxy.ts`); it never reports outcomes back to pigeon. So the daemon
observes only swarm messages and Telegram commands. An **active** serve failing every
frontdoor prompt while receiving no daemon traffic is as invisible as an idle one — the
draft's "idle serve" caveat was too narrow.

The frontdoor already classifies upstream 5xx per request (`proxy.ts:139-150,168-183`), so
a localhost `POST /serve-outcome` hint is a far cheaper closure of this gap than a readiness
endpoint. Added as **increment 2.5**, ahead of increment 3.

*Checked and clear:* the frontdoor's wedge probe does **not** fight a daemon-side verdict —
`onWedged` merely 503s the single waiting request and stops (`proxy.ts:139-150`); it
restarts nothing and writes nothing.

## 6. Recommended shape

Three increments, each independently shippable and each useful alone.

**Increment 1 — observability, including the verdict's sensor in shadow mode
(`pigeon-f2a`).** Ship the flap/oscillation alert *before* any mechanism that creates new
transitions. Track `max(owner_generation)` and its rate, plus repeated moves of the *same*
session. Justification: the last incident was invisible for weeks and was found by
root-causing killed turns, not by an alert — nothing on the flap path logs anything and
there is no history table. Alert on **rate**, not absolute value: generation also bumps via
the bounded-load skip (`router.ts:172-178`, `activeTurnCap=25`) and legitimately on pool
restart. Consider a reassignment-event table — free per rule 4, and worth more than the
counter because generation bumps cannot currently be dated.

**Also ship increment 2's counter here, in shadow mode: count and log per-serve
refused/5xx outcomes without acting on them.** N and the window cannot be chosen honestly
otherwise — nobody knows the base rate of refused/5xx per serve in healthy operation, and
nothing logs it today (`pigeon-ntk` item 6). This turns the §6 sequencing tension into
"the fix's sensor ships first."

**Increment 2 — outcome-based verdict (v), daemon-internal.** Per-serve consecutive-failure
counter fed by real delivery outcomes, enforcing after shadow-mode data sets the
thresholds. No schema change, no serve change, no pool restart, single-repo deploy.
Requirements, all binding per §5.1:

- Threaded into `listHealthy`/`resolveProspectiveRoute` only — **never `resolveRoute`** (A).
- Serve-directed HTTP outcomes only; refused + 5xx; plugin channel and 4xx excluded (B).
- **Timeouts never count** (C).
- ≥2 distinct sessions to enter; `(serve_id, instance_uuid)` keyed; half-open probation
  after T (D).
- Bounded blast radius: never let all serves be suspect. Degrade to "route anyway, alert
  loudly" rather than `NoHealthyServeError`. With A + C + the distinct-session rule this is
  a backstop for genuinely systemic causes, not the load-bearing wall it would have been in
  the draft.
- Log every transition (increment 1 makes it visible).

**Increment 2.5 — frontdoor outcome hints.** A localhost `POST /serve-outcome` from the
frontdoor, which already classifies upstream 5xx per request
(`proxy.ts:139-150,168-183`). Closes the blind spot in §5.1 E far more cheaply than a
readiness endpoint, and makes the verdict reflect the traffic that actually dominates.

**Increment 3 — a real readiness endpoint, only if 2 and 2.5 prove insufficient.** An
endpoint that exercises what a prompt needs (App/DB init, session store, provider auth)
rather than returning a constant. opencode-patched change plus a pool bounce, and it needs
its own timeout/hysteresis design so a heavy turn does not fail it. Defer until we know the
gap actually bites.

Explicitly **not** doing: enabling the http poller as a stopgap (rule 3); the self-probe
from the falsified `pigeon-zjv`; direction (ii).

Sequencing rationale: increment 1 is pure observability and de-risks everything after it;
increment 2 is the only change that addresses the unbounded class; increment 3 is the
expensive one and we should not pay for it before knowing if we need it.

## 7. Questions — resolved by review

1. **Transport-vs-application split determinable today?** *Partly, and the draft cited the
   wrong sources.* Resolved by §5.1 B: define the signal as serve-directed HTTP outcomes
   only, add attribution in the client factory. Stays daemon-local, so the ordering does
   **not** flip.
2. **Idle-serve gap acceptable in the interim?** *The gap is wider than "idle"* (§5.1 E) and
   is closed by increment 2.5 rather than tolerated.
3. **Stop new placements only, or evacuate?** *Settled: placements only.* Not a judgment
   call — the only evacuation primitive that exists is the one that killed four turns
   (§5.1 A).
4. **Should the verdict be durable?** *No — durability is actively harmful.* The draft had
   this backwards: a daemon restart is when a broken serve is most likely to have been
   *fixed*, not re-admitted. In-memory plus `instance_uuid` keying gives correct reset
   semantics for free (§5.1 D).
5. **Is `pigeon-amr` a prerequisite?** *No.* The verdict lives in daemon memory; self-heal
   touches only DB columns. If anything the verdict is defence-in-depth during skew.
6. **Over-rotated on class B / undersold the dead-man's switch?** *No — the demotion was
   right and under-argued.* A ~30s main-loop dead-man's switch is **rule-2-violating by
   construction**: CPU-heavy turns legitimately starve the loop for tens of seconds, which
   is the documented incident Fix C exists for. It would re-flag exactly the busy serves
   Fix C protects, via a serve-side write. Not merely redundant with the canary — harmful.

   *Caveat to carry:* the canary's 7-consecutive threshold resets on any success, so an
   *intermittently* starved serve (say, blocked 50s per minute) evades it indefinitely. The
   observed "7 isolated blips, none reaching 2/7" is consistent with exactly that pattern.
   This weakens confidence in the canary — but a dead-man's switch has the same intermittency
   hole, so it argues for better observability (increment 1), not for (iv).

## 8. Remaining risks

- The transport/application classifier is still the most likely place to get this wrong,
  even with §5.1 B narrowing it. Shadow mode exists to catch that before it acts.
- Thresholds are guesses until increment 1 produces base-rate data. Say so in the alert text.
- `pigeon-h21` (arbiter queue wedge) should land before or with increment 2; a wedged
  per-target queue produces *no* outcomes, which the verdict reads as "no evidence" rather
  than "broken."

1. **Is the transport/application failure split reliably determinable** from what the
   daemon sees today, or does it need a plugin-side change to distinguish "the serve is
   broken" from "the model returned an error"? If it needs a plugin change, increment 2's
   cost rises toward increment 3's and the ordering may flip.
2. **Is the idle-serve gap acceptable in the interim?** A serve that breaks while idle
   burns exactly one session before being marked suspect. Is one sacrificial session per
   breakage tolerable, or does that alone justify increment 3?
3. **Does `reassignFromDeadServe` do the right thing for a suspect-but-live serve?** It was
   written for dead serves. Moving sessions off a live serve mid-turn is what killed four
   turns in June. Should suspicion only stop *new* placements and leave in-flight sessions
   alone until their lease lapses naturally?
4. **Should the verdict be durable after all?** Rule 4 says a table is free. In-memory is
   simpler and there is no second reader, but the verdict is lost on daemon restart — is
   converging over N×5s after a restart acceptable, given a restart is exactly when a
   broken serve might be re-admitted?
5. **Is `pigeon-amr` a prerequisite?** If self-heal can clear `draining` under skew, can it
   also interfere with a suspect verdict, or are they fully independent?
6. **Have I over-rotated on class B?** Class A is covered at ~8 min by the canary; a
   dead-man's switch would cut that to ~30s for real. Is that latency improvement worth
   more than I have credited, given class B has not been observed since the hijack was
   fenced?

## 9. Landed: the live-lease clobber (pigeon-pov, 2026-08-03)

Question 3 above — "should suspicion only stop *new* placements and leave in-flight
sessions alone until their lease lapses naturally?" — turned out to describe a defect
that already existed, independent of the verdict work. It is now fixed, and the answer
to the question is **yes, and that rule is now enforced in `resolveRoute`**.

**What was wrong.** `reassignFromDeadServe` was carefully guarded (skip any session whose
lease on the dead serve is still valid, because only the owning serve can renew and
`renewCAS` is full-token fenced, so an unexpired lease proves the serve is alive-but-busy).
`resolveRoute` was the sole holdout: it gated on serve health *before* reading the lease, so
a stale heartbeat made it return null even with a valid lease, and `ensureRouted`
(`resolveRoute() ?? placeSession()`) then re-placed the session — bumping `owner_generation`
and stealing the lease via the `acquireCAS` take-over ladder. That is the June
"session lease lost mid-run" mode. Reached mid-turn in production by `/interrupt`,
`/compact`, follow-up prompts and swarm arbiter delivery.

**Fix.** `resolveRoute` now checks lease-token validity first, then gates the serve on
exists + `!draining` + current epoch. `healthState` and heartbeat freshness no longer block
an active route when a valid lease exists. Drain still sheds sessions; both epoch fences stay.

**Two findings worth carrying into the verdict work:**

1. **The bug was structurally unobservable, and the "evidence of absence" was a null
   instrument.** The original bead cited a journald grep for "lease lost" returning zero
   hits. That grep could never have matched: the string exists only in *code comments*, the
   units are system-scope (a `--user` query returns "No entries" regardless), and journald
   retention does not even reach June. There is no health-state-change log (`pigeon-f02`),
   and five days of daemon journal contained zero `[router]` lines. Before trusting any
   "we checked and saw nothing" claim in this arc, confirm the instrument could have fired.
   The fix ships two `[router]` logs — lease-honored, and a live-lease-displacement
   tripwire — which are the first instruments that would show this class of event.

2. **The fix is partial, deliberately.** The lease is renewed by the **serve itself, out of
   process** — the patched opencode serve holds the pigeon SQLite file open and refreshes its
   own `session_lease` row on a ~`leaseTtlMs/3` fiber. Nothing in the *daemon* renews
   (`renewCAS`'s only TS caller is `touch()`, which has no callers), and I initially inferred
   from that that nothing renews at all, which was wrong — see the note below. Because the
   renewal fiber runs inside the serve's own single-threaded event loop, a CPU stall halts
   renewal too, so the lease lapses ~`leaseTtlMs` after the last successful renew and a longer
   stall still ends in a clobber. Tracked as **pigeon-u1a**, which likely wants the
   serviceability signal this document designs rather than a naive renewer — note the
   `touch()` docstring warning first: a daemon-side periodic renewer would extend a dead
   serve's lease forever, because the full-token fence still matches a corpse that has not
   re-registered.

   **Corollary for this arc, learned the hard way:** "no TS caller" does not mean "does not
   happen." The serve is a second writer to this database. Any dead-code or liveness argument
   in this arc has to account for out-of-process writers, and the discriminating evidence is
   cheap — sample `session_lease` twice more than a TTL apart and check whether expiry
   advances, and check `/proc/<pid>/fd` for who holds the `.db` open.

**Constraint this adds to §5.1 A.** The amendment says the verdict must not be ANDed into
`isServeHealthy`. There is now a second reason: `resolveRoute` no longer consults
`isServeHealthy` for sessions holding a valid lease, so a verdict wired in there would not
reach the live-session path at all — it would silently apply only to placement. That is
probably the desired scope, but it should be a decision rather than an accident.

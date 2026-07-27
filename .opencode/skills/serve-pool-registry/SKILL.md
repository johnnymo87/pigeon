---
name: serve-pool-registry
description: Use before spawning any `opencode serve` (directly, from a script, or transitively via a test harness), and when diagnosing a pool slot that points at a dead port, is stuck draining, or 500s every prompt. Covers the serve_instance registry, the port fence, and self-heal.
---

# Serve Pool Registry

## When To Use

- **BEFORE running anything that can start an `opencode serve`** — including `bun test`
  in an opencode checkout, any script, or a tool that shells out. Read the hazard below.
- A pool slot points at a port nothing is listening on.
- A slot is `draining=1` while its real process is alive and heartbeating.
- Every prompt on one serve returns HTTP 500 in ~15ms.

## THE HAZARD (read this first)

**Your bash environment carries a live pool identity.** Every OpenCode session runs
inside one of the pool's serve processes, so its env is inherited by everything you
spawn:

```bash
echo $OPENCODE_SERVE_ID            # e.g. serve-2  -- a LIVE pool slot
echo $OPENCODE_ROUTING_DB          # the LIVE routing DB
echo $OPENCODE_SERVE_EXPECTED_PORT # e.g. 4098     -- the fence (see below)
```

`registerSelf` upserts `ON CONFLICT(serve_id) DO UPDATE SET instance_uuid=...,
endpoint=...`, so **any** process that inherits `OPENCODE_SERVE_ID` +
`OPENCODE_ROUTING_DB` and starts a serve claims that slot and repoints it at whatever
port it bound.

`--port` **defaults to 0**, and the port-0 path *catches* a collision with 4096 and
falls back to a fresh ephemeral port. So an accidental spawn does **not** fail loudly —
it silently takes a random port and claims the slot.

### This is not theoretical: three hijacks in 24h, 2026-07-25/26

| Slot | Mechanism |
|---|---|
| `serve-1` → `:47037`, `:47611` | frontdoor `pkgs/opencode-frontdoor/test.sh` (76 sessions 502'd for hours) |
| `serve-2` → `:44407` | opencode's own `bun test` harness — `test/lib/cli-process.ts` spread `{...process.env}` into children (~83 sessions evicted) |
| `serve-1` → `:33183` | **backticks in a `bd note`** performing shell command substitution on prose, executing a bare `opencode serve` (75 sessions stranded) |

Three mechanisms, no shared code path, all by competent operators who knew about the
bug. The third is not enumerable — no audit of "spawn sites" would ever contain
"backticks in an issue-tracker note".

### Safe spawn

```bash
env -u OPENCODE_SERVE_ID -u OPENCODE_ROUTING_DB -u OPENCODE_DB \
    -u OPENCODE_SERVE_EXPECTED_PORT -u OPENCODE_SESSION_ID \
    -u OPENCODE_WORKSPACE_ID -u OPENCODE_EXPERIMENTAL_WORKSPACES \
    -u OPENCODE_HEARTBEAT_INTERVAL_MS -u OPENCODE_DISABLE_CHANNEL_DB \
  opencode serve --port <high-port> --hostname 127.0.0.1
```

Stop it with **SIGTERM, never `kill -9`** — the finalizer must run. A `-9`'d rogue
leaves `draining=0` and a live heartbeat pinning a dead endpoint healthy forever
(the original 76-session blackhole). A SIGTERM'd one leaves `draining=1`, which is
capacity loss but visible.

For a test that needs a routing DB, point `OPENCODE_ROUTING_DB` at a **scratch copy
under `/tmp`**. **WAL gotcha:** copying `pigeon-daemon.db` alone gives stale state —
copy `-wal`/`-shm` too, or read through SQLite.

## The three protections (all live on cloudbox since 2026-07-26)

1. **Port fence** (`opencode-patched patches/registry-port-fence.patch`,
   `checkServePortFence`). The serve compares its **actually bound** port against
   `OPENCODE_SERVE_EXPECTED_PORT` and, on mismatch, **exits 20 before `registerSelf`
   and before `setSelfIdentity`**. Only one process can hold a TCP port, so the kernel
   is the arbiter and it does not care how the process was spawned.

   Hard exit, *not* log-and-skip: skipping registration leaves a null identity, and
   `withSessionLease` **fails OPEN** on null identity — "skip" would silently disable
   the session lease for every session on that serve.

   **Armed only when the var is present** (deploy-ordering: binary and units ship from
   different repos). Dropping it from a unit silently disarms the fence — see
   `pigeon-r2e` for the flip to fail-closed.

2. **Serve self-heal** (~30s, main thread). The serve repairs its OWN row:
   `instance_uuid`, `endpoint`, and a *foreign* `draining`. Uses a dedicated UPDATE,
   not `registerSelf`, because `registerSelf` re-reads `binary_epoch` and would let a
   stale binary rejoin the pool. It is a **no-op unless the row's `instance_uuid` OR
   `endpoint` disagrees with the serve's own** — so a merely-wedged serve never
   triggers it.

   Respects a `draining=1` whose identity is intact — the operator's eviction lever.
   **But that guarantee breaks under config skew** (`pigeon-amr`): the reconciler is a
   foreign writer of `endpoint`, so a skewed slot looks hijacked, self-heal fires, and
   clearing `draining` is one of its side effects. During skew the drain lever does
   not hold.

3. **Pigeon endpoint reconciler** (5s, `packages/daemon/src/routing/endpoint-reconciler.ts`).
   Makes `PIGEON_SERVE_ENDPOINTS` authoritative for `endpoint`, **that column only**.
   Alerts via Telegram. It must never write `instance_uuid`.

Also: `markDead` is identity-fenced, so a departing rogue cannot drain a slot it no
longer owns.

## Diagnosing

```bash
# Registry truth (read-only; never write the live DB by hand)
node -e 'const D=require("better-sqlite3");
const db=new D("/home/dev/projects/pigeon/packages/daemon/data/pigeon-daemon.db",{readonly:true});
const n=Date.now();
for(const r of db.prepare("SELECT serve_id,endpoint,instance_uuid,health_state,draining,heartbeat_at FROM serve_instance ORDER BY serve_id").all())
  console.log(r.serve_id,r.endpoint,r.instance_uuid.slice(0,8),r.health_state,"draining="+r.draining,"hb="+((n-r.heartbeat_at)/1000).toFixed(1)+"s");'

# Is the fence actually armed? (absence of a warning proves NOTHING -- an
# unfenced binary is silent too. Check positively:)
for p in $(pgrep -f "opencode serve --port"); do
  tr '\0' '\n' < /proc/$p/environ | grep '^OPENCODE_SERVE_EXPECTED_PORT='; done
readlink -f ~/.nix-profile/bin/opencode | grep -o 'patched-[0-9.]*'   # need >= 1.17.13.6
```

| Symptom | Cause | Fix |
|---|---|---|
| Slot points at a dead port | endpoint hijack | reconciler repairs in ≤5s; if not, check pigeon is running the merged code |
| Every prompt 500s in ~15ms | `instance_uuid` clobbered — pigeon stamps leases from a uuid the serve rejects, its CAS matches 0 rows and fails closed | self-heal ≤30s, else `systemctl restart opencode-serve@<port>` |
| Live serve excluded from pool, `draining=1`, heartbeat fresh | a rogue's `markDead` | self-heal ≤30s, else restart that unit |
| ALL slots drifted at once | **config skew**, not a hijack — port list renumbered without a pool restart (units set `restartIfChanged = false`) | `systemctl restart opencode-serve-pool.target` |

## Gotchas that have cost real time

- **`bin/opencode` in the nix store is a 647-byte `makeWrapper` script.** Grepping it
  for anything finds nothing. The real binary is `bin/.opencode-wrapped` (~168 MB).
  Always grep with a *control* string you know is present.
- **`pgrep -f "serve --port"` matches its own shell.** Phantom strays. Use `ss -tlnp`
  or an `awk` filter on the exact cmdline.
- **A rebuild does NOT restart the serves** (`restartIfChanged = false`). The fence and
  self-heal only take effect on the next explicit
  `systemctl restart opencode-serve-pool.target`, which kills live sessions.
- **Never `home-manager switch` from inside an OpenCode session** — it swaps the binary
  and kills the session mid-switch (`users/dev/home.base.nix:271`).

## Why liveness ≠ health

The serve heartbeat (5s) writes `health_state='healthy'` **unconditionally**, and it
runs on a **worker thread** so it survives main-loop starvation. It attests *"a worker
can write SQLite"*, not *"the serve can serve"*. That is the whole of `pigeon-886`, and
it is why a wedged serve stays routable. Note the consequences:

- Nothing else asserting health matters much by comparison — any other writer is
  slower and gets overwritten within 5s.
- **Do not "fix" this by having pigeon write `health_state='unhealthy'`.** Pigeon's
  `setHealth` touches the same two columns (`health_state`, `heartbeat_at`) at the same
  5s cadence, so the two writers just fight and the slot flaps. Flapping also poisons
  evacuation, because `reassignFromDeadServe` → `placeSession` picks from the healthy
  set *at that instant*.

## Related

**Start here if you're picking up serviceability work:** `bd show pigeon-u1u` — the
epic is the spine document for the whole arc (order of work, five settled decisions,
what's already been falsified, verification receipts). The design doc is
`docs/plans/2026-07-27-serve-serviceability-design.md`, whose **§5.1 holds five
binding amendments** — do not implement from §1–5 alone.

| Bead | |
|---|---|
| `pigeon-u1u` | **EPIC** — serve serviceability arc. Read first. |
| `pigeon-f2a` | increment 1 — flap alerting + shadow-mode sensor. The only ready child. |
| `pigeon-886` | increment 2 — the liveness/serviceability decoupling itself. |
| `pigeon-u1u.1` | increment 2.5 — frontdoor outcome hints. |
| `pigeon-u1u.2` | increment 3 — real readiness endpoint. Deliberately last. |
| `pigeon-amr` | self-heal clears the operator's drain lever under config skew. Independent. |
| `pigeon-r2e` | fail-closed flip + the **still-outstanding devbox/darwin deploy**. |
| `pigeon-13p` | closed — the original hijack bug. |
| `pigeon-h21` | closed — `sendPrompt` timeout. Its timeouts must **not** feed a health verdict. |
| `pigeon-ntk` | closed — verification receipts for the 886 design. |
| `pigeon-zjv` | closed as **FALSIFIED**. Read its correction note before re-proposing a self-probe in self-heal. |
- workstation `.opencode/skills/monitoring-serve-pool` — the canary that restarts a
  wedged instance (1-min timer, 7-failure threshold).

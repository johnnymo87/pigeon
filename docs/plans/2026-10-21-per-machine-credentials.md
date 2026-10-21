# Per-machine worker credentials (pigeon-k0qn.8) and incomplete swarm ids (pigeon-k0qn.14)

Spec: `docs/plans/2026-10-20-cross-machine-swarm-design.md` §6. Decision `pigeon-k0qn.4`:
build Phase 2, and give each machine its own credential before any machine receives (option a).

## Problem

Every daemon authenticates to the worker with one shared `CCR_API_KEY`, and the worker takes
the machine id from the URL (`/machines/:id/next`) or the body (`/sessions/register`). So
any holder of the key can act as any machine. Phase 2's relay (`.5`) makes `from_machine`
decide which sessions may be prompted, so the worker has to establish it from the credential.

## Design

**Principal.** `authenticate(request, env)` returns one of:

- `{ kind: "shared" }`: the bearer equals `CCR_API_KEY` (constant-time compare, no D1 read,
  so today's traffic costs nothing extra);
- `{ kind: "machine", machineId }`: the bearer is a per-machine key whose SHA-256 is in D1
  `machine_credentials` and not revoked;
- `null`: 401.

**Storage: D1, hashed.** `machine_credentials(key_sha256 PRIMARY KEY, machine_id, created_at,
revoked_at, note)`. Keys are 32 random bytes (`pgk_` + base64url), so an unsalted SHA-256 is
enough; there is nothing to brute-force. D1 instead of a wrangler secret: registering,
rotating and revoking are a single `wrangler d1 execute` with no deploy and no hand-edited JSON
blob. Several rows per machine are allowed, so a machine's key can be rotated with overlap.
Lookups are cached per isolate for 60s, positive hits only, so registering a key takes effect
at once and revocation within 60s. A missing table reads as "no per-machine keys" rather than
an error, so deploying the code before the schema changes nothing.

**Enforcement, only for per-machine principals.** The routes that assert a machine identity
refuse a mismatch with `403 {error: "machine_mismatch"}`:

- `GET /machines/:id/next`: `:id` must be the principal's machine. Checked before
  `touchMachine`, so a refused poll does not keep the machine looking online;
- `POST /commands/:id/ack`: the command's `machine_id` must be the principal's machine,
  checked in the `UPDATE` itself;
- `POST /sessions/register`: `body.machineId` must be the principal's machine, AND the
  principal may not take over a session another machine holds (`409
  owned_by_other_machine`) unless that row has been idle for 7 days (the daemon reaper's
  TTL). Without the second check, any key holder could re-point a session at itself and
  collect its relays and Telegram commands;
- `POST /sessions/unregister`: another machine's session is left alone, answered
  `200 {skipped: "not_owner"}` (every caller is janitorial). Otherwise unregister followed by
  register would be a two-step takeover.

Every other route accepts either credential, as today. The shared key keeps exactly today's
behaviour until it is retired.

**For `.5`.** `requireMachinePrincipal()` is exported. The relay routes and the poll's relay
hand-out will refuse the shared key outright, so `from_machine` can never be asserted by a
shared-key holder, whether or not the shared key has been retired.

**Retiring the shared key.** The worker var `SHARED_KEY_REFUSED_MACHINES` (CSV) makes the
shared key fail with 401 on the three machine-scoped routes above for the listed machines.
That stops a shared-key holder impersonating those daemons without breaking the other consumers
(the `CCR_API_KEY` shell export, scripts). `*` refuses the shared key everywhere; use it only
once nothing else uses it. Changing the var needs a deploy and can be reverted the same way.

**Refused polls alert.** A poll answered 401/403 twelve times in a row (about a minute) sends
one Telegram alert through the daemon's direct-to-Telegram alert path, re-armed by a
successful poll. Otherwise a rotated key the worker does not accept would fail every poll with
only a warn line, and an idle machine would silently stop receiving Telegram commands.

**D1 errors are not 401s.** A missing `machine_credentials` table reads as "no per-machine
keys"; any other D1 failure throws and becomes a 500. Only bearers of the exact key shape
reach D1, so a stranger's garbage bearer costs no D1 read.

**Introspection.** `GET /whoami` returns `{credential: "machine", machine_id}` or
`{credential: "shared", machine_id: null}`. The daemon calls it once at startup and logs
`[worker-identity] ...`, warning if the worker identifies it as a different machine than
`CCR_MACHINE_ID` or if it is still on the shared key. This is the "the worker sees this
request as machine X" check in the runbook.

**Daemon config.** None in pigeon. The daemon keeps reading `CCR_API_KEY`. Rotation changes
which secret the daemon's start script exports into it (workstation), and leaves the shell
export on the shared key.

**Minting.** `packages/worker/scripts/machine-key.mjs mint <machine> --out <file>` writes a
new key to a new file with mode 0600 and prints only its SHA-256 and the SQL that registers
it. `hash <file>` prints the hash of an existing key file. Neither command prints a key.

**Runbook.** `docs/runbooks/per-machine-credentials.md`, linked from the `secrets-and-auth`
skill: mint, register, store per machine, switch the daemon, verify, roll back, revoke, retire.

## Incomplete swarm ids (`.14`)

When the locality check says "remote", the worker knows no owner, and the target is a
`ses_` id whose shape is not a full opencode id (`ses_` + 26 alphanumerics, 30 chars), the
arbiter raises `IncompleteTargetIdError` instead of `RemoteTargetError`. The sender is told
the id is probably incomplete and to resend with the full id, not "do not resend". If exactly
one local registered session starts with the given id, the notice names it ("did you mean
...?"). It never delivers to that guess: a misroute is worse than a failure.

## Not in scope

- Other routes that carry an identity stay unenforced: `/topics/named/bind` (a key holder can
  bind a topic to its own session), `/notifications/send` (post into any session's topic) and
  `GET /media/*` (read any media). None of them prompts a session; they are follow-ups.
- Relay routes and hand-out are `.5`, with these rules carried forward: derive `from_machine`
  from the principal; `/swarm/relay/ack` and `/swarm/relay/fail` require `to_machine` to be
  the principal; hand-out and the accept-set write require a machine principal.

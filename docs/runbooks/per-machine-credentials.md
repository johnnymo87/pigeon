# Runbook: per-machine worker credentials

Moves each pigeon daemon (cloudbox, devbox, macbook) from the shared `CCR_API_KEY` to a
worker key of its own, so the worker, not the caller, decides which machine a request comes
from (pigeon-k0qn.8). Cross-machine swarm delivery (Phase 2) depends on this. Design:
`docs/plans/2026-10-21-per-machine-credentials.md`.

## How it works

- A key is `pgk_` + 43 base64url characters. The worker stores only its SHA-256, in D1
  `machine_credentials`, with the machine it belongs to.
- Every worker route accepts either the shared key or a machine key. With a machine key, the
  routes that assert a machine refuse any other one: poll (`403 machine_mismatch`), command
  ack (403), session register (403 for another machine id, `409 owned_by_other_machine` for
  a live session another machine holds), and session unregister (another machine's session
  is left alone, `200 {skipped: "not_owner"}`).
- The shared key keeps today's behaviour until it is retired through the worker var
  `SHARED_KEY_REFUSED_MACHINES`.
- `GET /whoami` says which principal a key resolves to. The daemon logs that once at startup
  as `[worker-identity] ...`.
- If the worker refuses 12 polls in a row (about a minute) with 401 or 403, the daemon sends
  a Telegram alert straight to Telegram, bypassing the worker.

Revocation takes up to 60s (the worker caches each resolved key per isolate). Registration
takes effect at once.

## Where things live

| What | cloudbox | devbox | macbook |
|---|---|---|---|
| Shared key (unchanged) | sops `ccr_api_key` → `/run/secrets/ccr_api_key` | same | Keychain `pigeon-ccr-api-key` |
| Machine key (new) | sops `pigeon_worker_key` → `/run/secrets/pigeon_worker_key` | same | Keychain `pigeon-worker-key` |
| Where the daemon reads it | `CCR_API_KEY` exported by the daemon start script in `hosts/cloudbox/configuration.nix` (~line 948) | `hosts/devbox/configuration.nix` (~line 389) | `users/dev/home.darwin.nix` (~line 496) |

All three are in the workstation repo. Only the **daemon's** start script switches to the
machine key. The interactive-shell `CCR_API_KEY` export and any scripts keep the shared key.

The worker side needs `wrangler` with Cloudflare credentials, which today means cloudbox
(`packages/worker`, `CLOUDFLARE_API_TOKEN`).

## Prerequisites

1. The pigeon PR for pigeon-k0qn.8 is merged and the worker is deployed:
   `curl -s -o /dev/null -w '%{http_code}\n' https://ccr-router.jonathan-mohrbacher.workers.dev/whoami`
   prints `401` (not `404`).
2. The schema is applied (idempotent), from `packages/worker` on cloudbox:
   `npx wrangler d1 execute pigeon-router --remote --file=src/d1-schema.sql`
3. Each daemon runs a pigeon checkout that includes this PR, so it has the startup
   identity log and the refused-poll alert. Pull and restart it first, per
   `cross-device-deployment`.

## Per machine (devbox, then macbook, then cloudbox)

`<m>` is the machine id: `devbox`, `macbook` or `cloudbox`, exactly as in `CCR_MACHINE_ID`.

### 1. Mint, on the machine that will hold the key

```bash
cd <pigeon checkout>
node packages/worker/scripts/machine-key.mjs mint <m> --out ~/pigeon-worker-key.<m>
```

It writes the key to a new file with mode 0600 (it refuses to overwrite one or to write
inside a git work tree) and prints only the SHA-256 and a `wrangler d1 execute ... --remote`
command. **Never print, paste or commit the key itself.**

### 2. Register, on cloudbox

Run the printed command from `packages/worker`. The hash is not secret. Do not drop
`--remote`: without it wrangler writes to a local D1 and every request with the key gets 401.

### 3. Check the key before the daemon uses it

```bash
curl -s -H "Authorization: Bearer $(cat ~/pigeon-worker-key.<m>)" \
  https://ccr-router.jonathan-mohrbacher.workers.dev/whoami
```

Expect `{"credential":"machine","machine_id":"<m>"}`. Anything else: stop here. Nothing has
changed for the daemon yet.

### 4. Store it

- **devbox / cloudbox:** from the workstation worktree on that host, add the key to
  `secrets/<host>.yaml` straight from the file, so it is never typed or echoed (the same
  pattern as the MCP-token skills). The age key is `/var/lib/sops-age-key.txt` on cloudbox
  and `/persist/sops-age-key.txt` on devbox (`secrets/README.md`):

  ```bash
  /run/wrappers/bin/sudo nix-shell -p sops -p jq --run 'k=$(jq -R . ~dev/pigeon-worker-key.<m>); SOPS_AGE_KEY_FILE=<age key> sops set secrets/<host>.yaml "[\"pigeon_worker_key\"]" "$k"; unset k'
  ```

  `jq -R .` reads the first line only, so the trailing newline is not stored. Check the
  value is the right length (`sops -d --extract '["pigeon_worker_key"]' secrets/<host>.yaml | wc -c`
  prints 47, or 48 with a trailing newline): an empty substitution is accepted silently. Then declare `pigeon_worker_key` next to
  `ccr_api_key` in `hosts/<host>/configuration.nix`, with the same owner and mode.
- **macbook:** `security add-generic-password -s pigeon-worker-key -a "$USER" -w "$(cat ~/pigeon-worker-key.macbook)"`.
  The key only appears in that command's argv, briefly. Do not run it with `set -x`.

Then change **only the daemon start script** to prefer the machine key, keeping an instant
rollback switch that needs no rebuild. On the Linux hosts:

```sh
if [ -s /run/secrets/pigeon_worker_key ] && [ ! -e "$HOME/.config/pigeon/use-shared-worker-key" ]; then
  export CCR_API_KEY="$(cat /run/secrets/pigeon_worker_key)"
else
  export CCR_API_KEY="$(cat /run/secrets/ccr_api_key)"
fi
```

On the Mac, in the daemon wrapper in `users/dev/home.darwin.nix` (keep its existing `$SEC`
variable):

```sh
k="$($SEC find-generic-password -s pigeon-worker-key -w 2>/dev/null || true)"
if [ -n "$k" ] && [ ! -e "$HOME/.config/pigeon/use-shared-worker-key" ]; then
  export CCR_API_KEY="$k"
else
  export CCR_API_KEY="$($SEC find-generic-password -s pigeon-ccr-api-key -w)"
fi
unset k
```

The emptiness check matters: with an empty `CCR_API_KEY` the daemon starts no poller at all,
so there is neither a `[worker-identity]` line nor a refused-poll alert. Workstation changes go through a branch and PR. Apply with
`sudo nixos-rebuild switch --flake .#<host>` or `darwin-rebuild switch --flake .#<mac>`, then
delete `~/pigeon-worker-key.<m>`.

### 5. Restart the daemon and verify

- Linux: `sudo systemctl restart pigeon-daemon.service`, then
  `journalctl --namespace=pigeon -u pigeon-daemon.service -n 80 --no-pager | grep -E 'worker-identity|Poll failed'`.
- Mac: `launchctl stop org.nix-community.home.pigeon-daemon && launchctl start org.nix-community.home.pigeon-daemon`,
  then `grep -hE 'worker-identity|Poll failed' ~/Library/Logs/pigeon-daemon.out.log ~/Library/Logs/pigeon-daemon.err.log | tail`.
  The success line goes to `out.log` and warnings to `err.log`, so read both.

Expect `[worker-identity] credential=machine machine=<m>` and no `Poll failed: 401/403`.
Then send a Telegram message to a session on that machine and confirm it arrives. Only then
move on to the next machine.

## Rollback (one machine)

1. `mkdir -p ~/.config/pigeon && touch ~/.config/pigeon/use-shared-worker-key`
2. Restart the daemon (as above) and check for `[worker-identity] credential=shared`.

This works only while the shared key is not retired for that machine. If it is listed in
`SHARED_KEY_REFUSED_MACHINES`, first set the var to the list **without** that machine (or to
`""`) and redeploy the worker. Never delete the line instead: `wrangler.toml` has
`keep_vars = true`, so a var missing from the file keeps its deployed value and the machine
stays retired. Confirm the deployed value (Cloudflare dashboard, or `npx wrangler versions view`
on the new version) before restarting the daemon on the shared key.

**Worker rollback.** Rolling the worker back to a version before per-machine keys makes every
machine key fail with 401 everywhere. Before such a rollback, put every machine-keyed daemon
on the shared key with the marker file above.

## Revoking or rotating a machine key

Find the key's hash with `node packages/worker/scripts/machine-key.mjs hash <file>`, or list
the rows with `SELECT key_sha256, machine_id, created_at, revoked_at, note FROM machine_credentials`.
Revoke:

```bash
npx wrangler d1 execute pigeon-router --remote --command \
  "UPDATE machine_credentials SET revoked_at = $(date +%s000) WHERE key_sha256 = '<hash>'"
```

Takes effect within 60s. To rotate, mint and register the new key, switch and verify the daemon,
then revoke the old one. Never `UPDATE machine_id` on a row: revoke it and mint a new key.

## Retiring the shared key

**Retirement is what makes the keys protect anything.** Until machine M is listed in
`SHARED_KEY_REFUSED_MACHINES`, a shared-key holder (any machine, any shell) can still
re-register M's sessions to itself and then collect them with its own key. So Phase 2
*receive* must not be enabled on M before M is retired (spec §6).

Ask the human first. Do it after all three daemons have been verified on their own keys and
stable for a while, because rollback via the marker file stops working for a retired machine.

1. In `packages/worker/wrangler.toml` `[vars]`, set
   `SHARED_KEY_REFUSED_MACHINES = "cloudbox,devbox,macbook"` and deploy the worker. The
   shared key can then no longer poll, ack, register or unregister as those machines. It
   still works for everything else, so the shell export and scripts keep working.
2. `*` refuses the shared key on every route. Use it only once nothing else uses the shared
   key; find the consumers first (grep the workstation repo and `~/projects` for
   `CCR_API_KEY`, `ccr_api_key` and `pigeon-ccr-api-key`).

Relay routes (Phase 2, pigeon-k0qn.5) never accept the shared key, whether or not it has been
retired.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/whoami` 401 with the new key | not registered, registered without `--remote`, revoked, or the file holds something else (`machine-key.mjs hash` checks the format) |
| `machine_mismatch` (403) on poll | the key is registered to a different machine than `CCR_MACHINE_ID` |
| `owned_by_other_machine` (409) on register | another machine holds that session and has been active within 7 days; it must unregister it first. Fixed ids registered from more than one machine (pull lanes, `ses_stallwatch_*`) hit this once both machines use their own keys |
| no `[worker-identity]` line at all | `CCR_API_KEY` is empty, so no poller started: the start script's secret read failed |
| `[worker-identity] credential=shared` after switching | the start script did not pick up the machine key: the secret is missing or the rollback marker exists |
| Telegram alert "the worker has refused its last 12 polls" | any of the above, the machine was retired from the shared key while still using it, or the worker was rolled back |

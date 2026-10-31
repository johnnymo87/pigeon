---
name: cross-device-deployment
description: Use when deploying pigeon code changes across all machines after merging to main
---

# Cross-Device Deployment

## When To Use

After merging code changes to main, deploy across all machines.

- Worker changes: single Cloudflare deploy (see worker-deployment skill)
- Daemon/plugin changes: pull + restart on each machine

## Worker (Global)

One deploy covers all devices. See **worker-deployment** skill for full details.

```bash
cd ~/projects/pigeon
npm run --workspace @pigeon/worker deploy
```

## Per-Machine Daemon Deploy

On each machine, pull latest code, install with **the daemon's own node**, and restart the
daemon. One command does all of it, on every host:

```bash
<project-path>/pigeon/scripts/deploy-daemon.sh --dry-run   # resolve + preflight, changes nothing
<project-path>/pigeon/scripts/deploy-daemon.sh             # pull, install, check, restart, poll /health
```

**First rollout of the script:** a production checkout older than the commit that added it has no
`scripts/deploy-daemon.sh` yet. Run it from any up-to-date worktree instead (it finds the
production checkout from the service, not from its own location), or `git pull --ff-only` the
checkout once by hand first.

It reads the running service definition (launchd plist on macOS, the systemd unit and its
`ExecStart` wrapper on Linux) to find the node binary the daemon execs and the checkout it runs,
so it works from a worktree and from a non-interactive shell with no `npm` on PATH. It refuses —
and never stashes, resets or cleans — when the checkout is not on `main`, has tracked edits, or
has commits on no remote. After `npm install` it checks that `tsx` is present and `better-sqlite3`
loads under the service's node (running `npm rebuild better-sqlite3` once if not: `npm install`
leaves a wrong-ABI binary in place) and **does not restart** if that still fails. That does not
make a failure harmless: the checkout is already pulled, and the next restart of the daemon,
including the unattended nightly one on devbox/cloudbox, runs it. The script says so on exit; fix
`node_modules` and re-run rather than leaving it. Override with
`PIGEON_DAEMON_NODE_DIR` / `PIGEON_DAEMON_REPO` only if resolution fails on an unusual host.

### Why the node matters

`packages/daemon` depends on `better-sqlite3`, a **native** module. `npm install` builds or
fetches its binary for whichever `node` is first on PATH (its install scripts call `node`, so
naming the `npm` binary alone is not enough). If that is a different Node major than the one the
service runs, the daemon dies at the next restart with a `NODE_MODULE_VERSION` mismatch and takes
the host's Telegram and swarm relay with it. Every host's service runs a pinned nix node:

| Machine | Daemon's node comes from |
|---------|--------------------------|
| devbox / cloudbox | `pkgs.nodejs` in `systemd.services.pigeon-daemon` (`hosts/<host>/configuration.nix` in workstation): the `exec …/bin/node` line of the `pigeon-daemon-start` wrapper, also first on the unit's `PATH` |
| macbook | `pkgs.nodejs` in `users/dev/home.darwin.nix`: the `exec …/bin/node` in the plist's `ProgramArguments`, also first in its `EnvironmentVariables.PATH` |

The `npm` an interactive or opencode shell finds (devenv, home-manager, nothing at all) is not
guaranteed to be that node. On macOS an opencode bash call has **no `npm` at all** (direnv/devenv
is not loaded), so a bare `npm install` fails with `npm: command not found`, which is the benign
form of the same bug.

### Manual fallback

If the script cannot run, do the same by hand: find the daemon's node, then put its directory
first on PATH for the install.

```bash
# macOS
plutil -extract ProgramArguments.2 raw -o - ~/Library/LaunchAgents/org.nix-community.home.pigeon-daemon.plist | grep -o '/nix/store/[^ ]*/bin/node'
# devbox/cloudbox (system unit; chromebook: systemctl --user)
grep -o '/nix/store/[^ ]*/bin/node' "$(systemctl show pigeon-daemon.service -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
```

```bash
cd <project-path>/pigeon && git pull --ff-only
cd <project-path>/pigeon && PATH=<node-dir>:$PATH <node-dir>/npm install
```

Then restart (below) and verify (see Verify).

### Restart commands

The script runs these; they are listed for the manual path.

| Machine | Command |
|---------|---------|
| **devbox** | `sudo systemctl restart pigeon-daemon.service` |
| **cloudbox** | `sudo systemctl restart pigeon-daemon.service` |
| **macbook** | `launchctl kickstart -k gui/$(id -u)/org.nix-community.home.pigeon-daemon` |
| **chromebook** | `systemctl --user restart pigeon-daemon.service` |

> **Daemon before serve, always.** The plugin (in the serve process) and the daemon share the
> stop idempotency key (`pigeon-mavq`): the plugin sends `notification_id` on `POST /stop` and
> the daemon uses it as the outbox key, which is what makes a retry a no-op instead of a second
> Telegram message. A **new plugin against an old daemon** is the one skew that could duplicate,
> since the old daemon ignores the field. The plugin defends itself — an ambiguous timeout stays
> terminal until it has seen a daemon echo a key back — so the worst case is a dropped stop
> rather than a duplicate in every topic. Restarting the daemon first removes even that.
>
> **Rolling the daemon BACK is the mirror case**, and the plugin handles it the same way: a
> response carrying a `notificationId` that is not the one we sent is positive evidence of a
> daemon that mints its own, and it revokes the flag. No pool restart is required after a
> rollback, but a restart is still the fastest way to a known state.

### Restart opencode-serve (only when you actually need it — see below)

> **⚠️ `opencode-serve.service` no longer exists on devbox or cloudbox.** Both now run a
> **pool** of instances (`opencode-serve@4096..4099.service`) governed by
> `opencode-serve-pool.target`, and the instances are `PartOf=` that target, so restarting the
> target propagates. The old single-unit command fails outright
> (`Unit opencode-serve.service could not be found`). Note the two hosts differ in **scope**:
> cloudbox's pool is a *system* target, devbox's is a *user* target — so devbox takes **no sudo**.

| Machine | Command |
|---------|---------|
| **devbox** | `systemctl --user restart opencode-serve-pool.target` — **user unit, no sudo** |
| **cloudbox** | `sudo systemctl restart opencode-serve-pool.target` |
| **macbook** | Verify the label first: `launchctl list \| grep opencode` |
| **chromebook** | Verify the label first: `systemctl --user list-units '*opencode*'` |

**Restarting opencode-serve is usually NOT required to deploy pigeon.** The daemon and worker
carry the routing/notification logic; opencode-serve only needs cycling when the **plugin**
changed and you want that change live immediately. It is not free:

- It **kills in-flight headless runs and drops attached sessions** on the pool.
- It only covers **pool-hosted** sessions. A tmux TUI is a *separate* opencode process holding
  its own copy of the plugin, and keeps the old plugin until that TUI is restarted. On devbox the
  nightly workspace reset cycles those, so expect full plugin coverage only after the next cycle.

So prefer: deploy worker + daemons, and schedule the pool restart deliberately rather than
reflexively as a deploy step.

Verify the pool afterwards by instance, not just the one port:
`systemctl --user list-units 'opencode-serve@*'` (devbox) /
`systemctl list-units 'opencode-serve@*'` (cloudbox).

If any command fails because a name doesn't match, discover the real one with
`systemctl list-units '*opencode*'` / `systemctl --user list-units '*opencode*'` (Linux) or
`launchctl list | grep opencode` (macOS) before improvising.

### Verify

```bash
curl -s http://127.0.0.1:4731/health          # pigeon-daemon
curl -s http://127.0.0.1:4096/global/health   # opencode-serve (ONE pool instance only)
```

Both should return JSON with `"ok":true` / `"healthy":true`. `/health` is anonymous by design.

Any **other** daemon route needs `Authorization: Bearer <token>` only where the host sets
`PIGEON_DAEMON_AUTH_TOKEN` (devbox and cloudbox, from `/run/secrets/pigeon_daemon_auth_token`).
Daemon auth is off where it is unset (macbook today: the plist has no such variable), and the
header is then omitted, not sent empty. Check before copying a curl from another host:
`plutil -p ~/Library/LaunchAgents/org.nix-community.home.pigeon-daemon.plist | grep AUTH_TOKEN` /
`grep AUTH_TOKEN "$(systemctl show pigeon-daemon.service -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"`
(no output: off). On NixOS it is exported by the start wrapper, so `systemctl show -p Environment`
does not show it.

On the pool hosts (devbox, cloudbox) the `:4096` curl proves only that **one of four** instances
is up. Check them all — a single wedged instance silently degrades a quarter of sessions:

```bash
for p in 4096 4097 4098 4099; do
  printf '%s: ' "$p"; curl -s --max-time 3 "http://127.0.0.1:$p/global/health" || echo DOWN
  echo
done
```

## Remote Upgrade (via `swarm_launch`)

Where remote launch is enabled (off by default, on between cloudbox, devbox and macbook since `pigeon-k0qn.18`; see "Remote launch" in `AGENTS.md`), an
agent on machine A can deploy pigeon on machine B by starting a fresh session there with
`swarm_launch`. That session does the per-machine steps above and reports back. The worker
deploy is still done once, from anywhere, as above.

### Example

The prompt below is for **devbox**. For another host, change the machine and the project path
(`~/Code/pigeon` on macbook); the script finds the service itself.

```ts
swarm_launch({
  machine: "devbox",
  directory: "~/projects/pigeon",
  prompt: `Deploy pigeon main on this machine, then report to me with swarm_send.
1. ~/projects/pigeon/scripts/deploy-daemon.sh --dry-run, then without --dry-run. It pulls,
   installs with the daemon's own node, restarts, and polls /health. If it refuses, do NOT
   stash, reset or clean anything: report its message.
2. swarm_send me: the new HEAD sha, the health output, and anything that failed. If the
   plugin changed, say that it is NOT verified yet: you are running on the old plugin.
3. Do NOT restart the serve pool unless I asked for it in this prompt.`
})
```

Before ending your own turn on A, schedule a wake (`swarm_schedule`, about 20 minutes) that
checks B shows `available` in `swarm_list remote: true` and that its report arrived. A daemon
that fails to come back up cannot send that report, and takes B's Telegram and relay down with
it, so silence is the failure signal and nothing else will raise it.

If the plugin changed and Jonathan wants it live before the nightly reset, the prompt's last
step (after the report) can be a delayed pool restart:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemd-run --user --unit="pigeon-pool-restart-$RANDOM" --on-active=60 --collect \
  --setenv=PATH="$PATH" systemctl --user restart opencode-serve-pool.target
```

### Rules

1. **The pool-restart trap.** The launched session lives on B's serve pool. Restarting the pool
   ("Restart opencode-serve" above) kills it mid-turn, and also every other session there,
   including a human's. So the restart is not a default step: it needs a plugin change and an
   explicit ask, comes last, after the report, and runs from a delayed transient unit rather
   than inline. `XDG_RUNTIME_DIR` and
   `PATH` are passed because opencode bash calls lack the first and transient units get a
   minimal second (see the user-level "Backgrounding Long-Running Processes" notes).
2. **A plugin change cannot be verified by the session that deployed it.** It is running on the
   old plugin and is killed by the restart that loads the new one. Verify from A afterwards,
   for example with a second short `swarm_launch` that reports its own behaviour.
3. **Never a bare `npm install`.** Use the script, or the manual fallback with the daemon's node
   first on PATH, for the reason in "Why the node matters" above.
4. **macOS service changes still need Jonathan.** `darwin-switch` needs a sudo
   password, which an unattended session cannot supply. A code-only macbook deploy (pull,
   install, `launchctl` restart) works remotely.

## Nix Service Changes

If service definitions changed (not just application code), rebuild instead of restarting:

| Machine | Command |
|---------|---------|
| **devbox** | `sudo nixos-rebuild switch --flake .#devbox` |
| **cloudbox** | `sudo nixos-rebuild switch --flake .#cloudbox` |
| **macbook** | `home-switch` (user agents, including `pigeon-daemon`), then `darwin-switch` (system; needs sudo). Both are workstation helpers; `darwin-rebuild` is no longer run directly |
| **chromebook** | `home-manager switch --flake .#livia` |

Service definitions live in `~/projects/workstation`.

## Machine Reference

| Machine | OS | Project path | Service manager | CCR_MACHINE_ID |
|---------|-----|-------------|-----------------|----------------|
| devbox | NixOS | `~/projects/pigeon` | systemd (system) | `devbox` |
| cloudbox | NixOS | `~/projects/pigeon` | systemd (system) | `cloudbox` |
| macbook | macOS | `~/Code/pigeon` | launchd (user agent) | `macbook` |
| chromebook | Crostini | `~/projects/pigeon` | systemd (user) | `chromebook` |

All four machines run both `pigeon-daemon` and `opencode-serve` under their service manager.

## Daemon Logs

| Machine | Command |
|---------|---------|
| **devbox/cloudbox** | `journalctl --namespace=pigeon -u pigeon-daemon.service -n 50 --no-pager` |
| **macbook** | `cat ~/Library/Logs/pigeon-daemon.err.log` |
| **chromebook** | `journalctl --user -u pigeon-daemon.service -n 50 --no-pager` |

**`--namespace=pigeon` is required on devbox/cloudbox and must NOT be used on
chromebook.** Those two are NixOS hosts where pigeon-daemon is a *system* unit
carrying `LogNamespace = "pigeon"` (workstation-9f7a), which gives it a private
journal with 90-day retention instead of the ~6 days the shared journal manages.
Chromebook runs pigeon as a *user* service with no namespace, so the flag would
find nothing there.

Omitting the flag where it is needed does not error — it prints systemd's own
`Started`/`Stopped` lines (PID 1 is not namespaced) and **none of the daemon's
output**. That looks exactly like a daemon that is running but logging nothing,
which is more believable than an empty result and therefore more misleading. If a
devbox/cloudbox log query shows lifecycle lines and nothing else, check the flag
before concluding anything.

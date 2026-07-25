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

On each machine, pull latest code and restart the daemon.

### 1. Pull and Install

```bash
cd <project-path>/pigeon
git pull
npm install
```

### 2. Restart Daemon

| Machine | Command |
|---------|---------|
| **devbox** | `sudo systemctl restart pigeon-daemon.service` |
| **cloudbox** | `sudo systemctl restart pigeon-daemon.service` |
| **macbook** | `launchctl stop org.nix-community.home.pigeon-daemon && launchctl start org.nix-community.home.pigeon-daemon` |
| **chromebook** | `systemctl --user restart pigeon-daemon.service` |

### 3. Restart opencode-serve (only when you actually need it — see below)

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

### 4. Verify

```bash
curl -s http://127.0.0.1:4731/health          # pigeon-daemon
curl -s http://127.0.0.1:4096/global/health   # opencode-serve (ONE pool instance only)
```

Both should return JSON with `"ok":true` / `"healthy":true`.

On the pool hosts (devbox, cloudbox) the `:4096` curl proves only that **one of four** instances
is up. Check them all — a single wedged instance silently degrades a quarter of sessions:

```bash
for p in 4096 4097 4098 4099; do
  printf '%s: ' "$p"; curl -s --max-time 3 "http://127.0.0.1:$p/global/health" || echo DOWN
  echo
done
```

## Nix Service Changes

If service definitions changed (not just application code), rebuild instead of restarting:

| Machine | Command |
|---------|---------|
| **devbox** | `sudo nixos-rebuild switch --flake .#devbox` |
| **cloudbox** | `sudo nixos-rebuild switch --flake .#cloudbox` |
| **macbook** | `darwin-rebuild switch --flake .#Y0FMQX93RR-2` |
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
| **devbox/cloudbox** | `journalctl -u pigeon-daemon.service -n 50 --no-pager` |
| **macbook** | `cat ~/Library/Logs/pigeon-daemon.err.log` |
| **chromebook** | `journalctl --user -u pigeon-daemon.service -n 50 --no-pager` |

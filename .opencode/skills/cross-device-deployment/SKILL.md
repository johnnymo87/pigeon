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
bun run --filter '@pigeon/worker' deploy
```

## Per-Machine Daemon Deploy

On each machine, pull latest code and restart the daemon.

### 1. Pull and Install

```bash
cd <project-path>/pigeon
git pull
bun install
```

### 2. Restart Daemon

| Machine | Command |
|---------|---------|
| **devbox** | `sudo systemctl restart pigeon-daemon.service` |
| **cloudbox** | `sudo systemctl restart pigeon-daemon.service` |
| **macbook** | `launchctl stop org.nix-community.home.pigeon-daemon && launchctl start org.nix-community.home.pigeon-daemon` |
| **chromebook** | `systemctl --user restart pigeon-daemon.service` |

### 3. Restart opencode-serve (devbox only)

```bash
sudo systemctl restart opencode-serve.service
```

No other machine runs opencode-serve.

### 4. Verify

```bash
curl -s http://127.0.0.1:4731/health
# devbox only:
curl -s http://127.0.0.1:4096/global/health
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

| Machine | OS | Project path | Daemon service | CCR_MACHINE_ID |
|---------|-----|-------------|----------------|----------------|
| devbox | NixOS | `~/projects/pigeon` | systemd (system) | `devbox` |
| cloudbox | NixOS | `~/projects/pigeon` | systemd (system) | `cloudbox` |
| macbook | macOS | `~/Code/pigeon` | launchd (user agent) | `macbook` |
| chromebook | Crostini | `~/projects/pigeon` | systemd (user) | `chromebook` |

## Daemon Logs

| Machine | Command |
|---------|---------|
| **devbox/cloudbox** | `journalctl -u pigeon-daemon.service -n 50 --no-pager` |
| **macbook** | `cat ~/Library/Logs/pigeon-daemon.err.log` |
| **chromebook** | `journalctl --user -u pigeon-daemon.service -n 50 --no-pager` |

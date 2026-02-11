---
name: daemon-cutover-burnin
description: Use when cutting over daemon service to a new build, running burn-in checks, or preparing rollback
---

# Daemon Cutover And Burn-In

## When To Use

Use this skill for service migration or release stabilization windows.

## Cutover Source Of Truth

- Service definition lives in `~/projects/workstation/hosts/devbox/configuration.nix`
- Apply with:

```bash
cd ~/projects/workstation
sudo nixos-rebuild switch --flake .#devbox
```

## Post-Cutover Checklist

1. `systemctl status ccr-webhooks.service`
2. local health endpoint
3. session lifecycle smoke test
4. worker registration/unregister evidence in logs
5. parity harness run

## Burn-In Signals

- no crash loops
- stable worker connectivity
- stop notifications continue working
- reply and callback commands still inject locally

## Rollback Approach

1. revert workstation service config to known-good commit
2. `sudo nixos-rebuild switch --flake .#devbox`
3. verify health/routes
4. document incident + regression cause

## Verify

```bash
systemctl status ccr-webhooks.service --no-pager
curl -s http://127.0.0.1:4731/health
```

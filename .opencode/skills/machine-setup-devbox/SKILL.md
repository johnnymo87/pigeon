---
name: machine-setup-devbox
description: Use when onboarding or repairing devbox and workstation configuration for Pigeon daemon, hooks, and worker connectivity
---

# Machine Setup (Devbox)

## When To Use

Use this for new machine onboarding or broken environment recovery.

## Baseline Setup

1. Ensure workstation config is current:
   - `cd ~/projects/workstation`
   - `sudo nixos-rebuild switch --flake .#devbox`
2. Ensure pigeon repo dependencies:
   - `cd ~/projects/pigeon`
    - `npm install`

## Service Checks

```bash
systemctl status pigeon-daemon.service --no-pager
curl -s http://127.0.0.1:4731/health
systemctl status opencode-serve.service --no-pager
curl -s http://127.0.0.1:4096/global/health
```

## Secret Checks

```bash
test -r /run/secrets/ccr_api_key && echo ok
```

## Worker Connectivity Check

```bash
curl -s -o /tmp/sessions.json -w "%{http_code}" -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

## Verify

Expected:

- pigeon-daemon service running, health returns ok
- opencode-serve service running, health returns `{"healthy":true,...}`
- authenticated worker call returns 200

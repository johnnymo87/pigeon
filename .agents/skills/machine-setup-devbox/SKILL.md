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
   - `bun install`

## Service Checks

```bash
systemctl status ccr-webhooks.service --no-pager
curl -s http://127.0.0.1:4731/health
```

## Secret Checks

```bash
test -r /run/secrets/op_service_account_token && echo ok
cd ~/projects/claude-code-remote
op run --env-file=.env.1password -- sh -c 'echo ${CCR_API_KEY:+ok}'
```

## Worker Connectivity Check

```bash
cd ~/projects/claude-code-remote
op run --env-file=.env.1password -- sh -c 'curl -s -o /tmp/sessions.json -w "%{http_code}" -H "Authorization: Bearer $CCR_API_KEY" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"'
```

## Verify

Expected:

- daemon service running
- local health endpoint returns ok
- authenticated worker call returns 200

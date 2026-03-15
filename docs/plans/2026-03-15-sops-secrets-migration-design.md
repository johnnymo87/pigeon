# Migrate Pigeon Secrets from 1Password to sops

**Goal:** Remove the 1Password runtime dependency from the pigeon daemon. All five pigeon secrets become sops-managed, decrypted to `/run/secrets/` at boot, and read by the daemon as plain files -- the same pattern `ccr_worker_url` already uses.

## Context

Pigeon secrets currently use a two-layer injection scheme on Linux:

1. **sops-nix** decrypts `op_service_account_token` and `ccr_worker_url` to `/run/secrets/` at boot.
2. **1Password CLI** (`op run --env-file=.env.1password`) uses the service account token at daemon startup to fetch `CCR_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_WEBHOOK_PATH_SECRET`.

This adds an unnecessary runtime dependency on 1Password. If the 1Password service is down or the service account token expires, the daemon fails to start even though sops-nix can manage these secrets directly.

On macOS, a separate `pigeon-setup-secrets` script reads from 1Password and populates macOS Keychain. The launchd agent reads from Keychain at runtime.

## Secrets Being Migrated

| Secret | Current source | New source |
|--------|---------------|------------|
| `CCR_API_KEY` | 1Password `op://Automation/ccr-secrets/CCR_API_KEY` | sops -> `/run/secrets/ccr_api_key` |
| `TELEGRAM_BOT_TOKEN` | 1Password `op://Automation/ccr-secrets/TELEGRAM_BOT_TOKEN` | sops -> `/run/secrets/telegram_bot_token` |
| `TELEGRAM_CHAT_ID` | 1Password `op://Automation/ccr-secrets/TELEGRAM_CHAT_ID` | sops -> `/run/secrets/telegram_chat_id` |
| `TELEGRAM_WEBHOOK_SECRET` | 1Password `op://Automation/ccr-secrets/TELEGRAM_WEBHOOK_SECRET` | sops -> `/run/secrets/telegram_webhook_secret` |
| `TELEGRAM_WEBHOOK_PATH_SECRET` | 1Password `op://Automation/ccr-secrets/TELEGRAM_WEBHOOK_PATH_SECRET` | sops -> `/run/secrets/telegram_webhook_path_secret` |

## What Gets Removed

- `.env.1password` in pigeon repo (no longer needed)
- `op run` wrapper in all daemon ExecStart scripts
- `op_service_account_token` from sops YAML files (no other consumer)
- `pkgs._1password-cli` from `devenv.nix` and system packages where pigeon was the only reason
- 1Password references in pigeon skill docs and AGENTS.md

## Changes by Machine

### Linux (devbox, cloudbox, chromebook)

Each machine's sops YAML file (`secrets/{devbox,cloudbox,chromebook}.yaml`) gets five new entries with the plaintext secret values, then re-encrypts with `sops`.

Each machine's NixOS/home-manager config declares five new `sops.secrets` entries:

```nix
ccr_api_key = { owner = "dev"; group = "dev"; mode = "0400"; };
telegram_bot_token = { owner = "dev"; group = "dev"; mode = "0400"; };
telegram_chat_id = { owner = "dev"; group = "dev"; mode = "0400"; };
telegram_webhook_secret = { owner = "dev"; group = "dev"; mode = "0400"; };
telegram_webhook_path_secret = { owner = "dev"; group = "dev"; mode = "0400"; };
```

The daemon ExecStart script drops the `op run` wrapper and reads directly:

```bash
set -euo pipefail
export CCR_WORKER_URL="$(cat /run/secrets/ccr_worker_url)"
export CCR_API_KEY="$(cat /run/secrets/ccr_api_key)"
export TELEGRAM_BOT_TOKEN="$(cat /run/secrets/telegram_bot_token)"
export TELEGRAM_CHAT_ID="$(cat /run/secrets/telegram_chat_id)"
export TELEGRAM_WEBHOOK_SECRET="$(cat /run/secrets/telegram_webhook_secret)"
export TELEGRAM_WEBHOOK_PATH_SECRET="$(cat /run/secrets/telegram_webhook_path_secret)"
export OPENCODE_URL="http://127.0.0.1:4096"
exec node .../tsx/dist/cli.mjs .../daemon/src/index.ts
```

### macOS

sops-nix does not support Darwin. The launchd agent continues reading from macOS Keychain. The `pigeon-setup-secrets` script is rewritten to accept secret values directly (stdin or arguments) instead of reading from 1Password with `op read`. This is a manual one-time operation when setting up a new Mac.

## Local Development

On devbox, `/run/secrets/` is populated by sops-nix at boot. The `dev-daemon` script in `devenv.nix` reads from the same files:

```bash
for f in ccr_worker_url ccr_api_key telegram_bot_token telegram_chat_id telegram_webhook_secret telegram_webhook_path_secret; do
  upper=$(echo "$f" | tr '[:lower:]' '[:upper:]')
  export "$upper"="$(cat /run/secrets/$f)"
done
npm run --workspace @pigeon/daemon dev -- "$@"
```

The `devenv.nix` no longer needs `pkgs._1password-cli` and the enterShell block drops the 1Password connectivity check.

## Verification

After deploying to each machine:

1. Restart the daemon (`sudo systemctl restart pigeon-daemon` or equivalent)
2. `curl http://127.0.0.1:4731/health` confirms the daemon is running
3. Send a Telegram message and verify it is received and processed
4. Check logs for errors (`journalctl -u pigeon-daemon -f`)

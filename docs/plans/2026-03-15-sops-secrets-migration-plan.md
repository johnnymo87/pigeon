# Sops Secrets Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate five pigeon secrets from 1Password to sops, eliminating the 1Password runtime dependency.

**Architecture:** Add the five pigeon secrets (CCR_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_WEBHOOK_PATH_SECRET) to each machine's sops YAML file. Update NixOS/home-manager configs to declare them as sops.secrets and read them from /run/secrets/ in the daemon ExecStart script. Remove the 1Password op run wrapper, op_service_account_token, and .env.1password.

**Tech Stack:** sops, age, NixOS (sops-nix module), home-manager, bash

**Design doc:** `docs/plans/2026-03-15-sops-secrets-migration-design.md`

---

### Task 1: Add secrets to devbox sops YAML

**Files:**
- Modify: `~/projects/workstation/secrets/devbox.yaml`

**Step 1: Decrypt the sops file for editing**

```bash
cd ~/projects/workstation
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops secrets/devbox.yaml
```

This opens the file in your editor with decrypted values. Add these five keys (after the existing `ccr_worker_url` entry):

```yaml
ccr_api_key: <your CCR API key>
telegram_bot_token: <your Telegram bot token>
telegram_chat_id: <your Telegram chat ID>
telegram_webhook_secret: <your Telegram webhook secret>
telegram_webhook_path_secret: <your Telegram webhook path secret>
```

Remove the `op_service_account_token` entry.

Save and close -- sops re-encrypts automatically.

**Step 2: Verify the secrets were added**

```bash
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops -d secrets/devbox.yaml | grep -E "ccr_api_key|telegram_bot_token|telegram_chat_id|telegram_webhook_secret|telegram_webhook_path_secret"
```

Expected: all five secrets appear with correct plaintext values.

---

### Task 2: Add secrets to cloudbox sops YAML

**Files:**
- Modify: `~/projects/workstation/secrets/cloudbox.yaml`

**Step 1: Decrypt and edit**

The cloudbox sops file is encrypted with the cloudbox age key, not devbox. You cannot edit it from devbox. Instead, use `sops updatekeys` after adding the devbox key to the cloudbox creation rule, or edit it on cloudbox itself.

Alternative: Since the secrets are the same across machines, and the `.sops.yaml` creation rules already specify which age key encrypts each file, you can add the plaintext values by editing on the appropriate machine.

If you have a way to edit cloudbox.yaml from devbox (e.g., shared key), add the same five keys and remove `op_service_account_token`. Otherwise, this task must be done on cloudbox.

---

### Task 3: Add secrets to chromebook sops YAML

**Files:**
- Modify: `~/projects/workstation/secrets/chromebook.yaml`

Same as Task 2 but for chromebook. The chromebook.yaml is encrypted with both devbox and chromebook keys, so it CAN be edited from devbox:

```bash
cd ~/projects/workstation
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops secrets/chromebook.yaml
```

Add the same five keys, remove `op_service_account_token`. Save and close.

---

### Task 4: Update devbox NixOS config -- sops.secrets declarations

**Files:**
- Modify: `~/projects/workstation/hosts/devbox/configuration.nix`

**Step 1: Add five new sops.secrets entries**

In the `sops.secrets` block (after `ccr_worker_url` at line ~85-89), add:

```nix
      ccr_api_key = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
      telegram_bot_token = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
      telegram_chat_id = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
      telegram_webhook_secret = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
      telegram_webhook_path_secret = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
```

**Step 2: Remove op_service_account_token declaration**

Delete lines 33-38:
```nix
      # 1Password service account token (bootstrap for CCR and other app secrets)
      op_service_account_token = {
        owner = "dev";
        group = "dev";
        mode = "0400";
      };
```

**Step 3: Rewrite pigeon-daemon ExecStart**

Replace the ExecStart script (lines 190-197) with:

```nix
      ExecStart = "${pkgs.writeShellScript "pigeon-daemon-start" ''
        set -euo pipefail
        export CCR_WORKER_URL="$(cat /run/secrets/ccr_worker_url)"
        export CCR_API_KEY="$(cat /run/secrets/ccr_api_key)"
        export TELEGRAM_BOT_TOKEN="$(cat /run/secrets/telegram_bot_token)"
        export TELEGRAM_CHAT_ID="$(cat /run/secrets/telegram_chat_id)"
        export TELEGRAM_WEBHOOK_SECRET="$(cat /run/secrets/telegram_webhook_secret)"
        export TELEGRAM_WEBHOOK_PATH_SECRET="$(cat /run/secrets/telegram_webhook_path_secret)"
        export OPENCODE_URL="http://127.0.0.1:4096"
        exec ${pkgs.nodejs}/bin/node /home/dev/projects/pigeon/node_modules/tsx/dist/cli.mjs /home/dev/projects/pigeon/packages/daemon/src/index.ts
      ''}";
```

Note: `${pkgs._1password-cli}` is no longer referenced. If `allowUnfree` (line 5-6) was only needed for `_1password-cli`, update the comment. Keep `allowUnfree = true` if other unfree packages may be needed later, or remove if no other unfree packages are used.

**Step 4: Commit**

```bash
cd ~/projects/workstation
git add hosts/devbox/configuration.nix
git commit -m "devbox: migrate pigeon secrets from 1Password to sops"
```

---

### Task 5: Update cloudbox NixOS config

**Files:**
- Modify: `~/projects/workstation/hosts/cloudbox/configuration.nix`

Apply the same three changes as Task 4:

1. Add five `sops.secrets` entries (after existing `ccr_worker_url` declaration, around line ~100)
2. Remove `op_service_account_token` (lines 42-47)
3. Rewrite `pigeon-daemon` ExecStart (lines 254-261) -- same pattern as devbox but with `CCR_MACHINE_ID=cloudbox` already in Environment

```bash
cd ~/projects/workstation
git add hosts/cloudbox/configuration.nix
git commit -m "cloudbox: migrate pigeon secrets from 1Password to sops"
```

---

### Task 6: Update chromebook home-manager config

**Files:**
- Modify: `~/projects/workstation/users/dev/home.crostini.nix`

**Step 1: Add sops.secrets entries**

In the `sops.secrets` block (lines 23-28), add the five new entries. For home-manager sops, the syntax is simpler:

```nix
      ccr_api_key = {};
      telegram_bot_token = {};
      telegram_chat_id = {};
      telegram_webhook_secret = {};
      telegram_webhook_path_secret = {};
```

Remove:
```nix
      op_service_account_token = {};
```

**Step 2: Rewrite pigeon-daemon ExecStart**

Replace lines 97-107 with:

```nix
      ExecStart = "${pkgs.writeShellScript "pigeon-daemon-start" ''
        set -euo pipefail
        export CCR_WORKER_URL="$(cat ${config.sops.secrets.ccr_worker_url.path})"
        export CCR_API_KEY="$(cat ${config.sops.secrets.ccr_api_key.path})"
        export TELEGRAM_BOT_TOKEN="$(cat ${config.sops.secrets.telegram_bot_token.path})"
        export TELEGRAM_CHAT_ID="$(cat ${config.sops.secrets.telegram_chat_id.path})"
        export TELEGRAM_WEBHOOK_SECRET="$(cat ${config.sops.secrets.telegram_webhook_secret.path})"
        export TELEGRAM_WEBHOOK_PATH_SECRET="$(cat ${config.sops.secrets.telegram_webhook_path_secret.path})"
        export OPENCODE_URL="http://127.0.0.1:4096"
        exec ${pkgs.nodejs}/bin/node \
          ${config.home.homeDirectory}/projects/pigeon/node_modules/tsx/dist/cli.mjs \
          ${config.home.homeDirectory}/projects/pigeon/packages/daemon/src/index.ts
      ''}";
```

**Step 3: Remove _1password-cli from home.packages**

Remove `pkgs._1password-cli` from line 15 (unless it's used for other purposes on chromebook).

**Step 4: Commit**

```bash
cd ~/projects/workstation
git add users/dev/home.crostini.nix
git commit -m "chromebook: migrate pigeon secrets from 1Password to sops"
```

---

### Task 7: Update macOS home-manager config

**Files:**
- Modify: `~/projects/workstation/users/dev/home.darwin.nix`

**Step 1: Rewrite pigeon-setup-secrets script**

Replace the script (lines 72-99) so it no longer uses `op read`. Instead, accept values from stdin or a local file:

```nix
    (pkgs.writeShellApplication {
      name = "pigeon-setup-secrets";
      text = ''
        echo "Populating macOS Keychain with pigeon secrets."
        echo "Enter each secret value when prompted."
        echo ""

        secrets=(
          "pigeon-ccr-api-key"
          "pigeon-telegram-bot-token"
          "pigeon-telegram-chat-id"
          "pigeon-telegram-webhook-secret"
          "pigeon-telegram-webhook-path-secret"
        )

        for name in "''${secrets[@]}"; do
          printf "  %s: " "$name"
          read -r value
          # Delete existing entry if present (ignore errors)
          security delete-generic-password -s "$name" 2>/dev/null || true
          security add-generic-password -a "$USER" -s "$name" -w "$value"
          echo "  Stored $name in Keychain"
        done

        echo ""
        echo "Done. You can now start the pigeon daemon:"
        echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/org.nix-community.home.pigeon-daemon.plist"
      '';
    })
```

This removes the `runtimeInputs = [ pkgs._1password-cli ]` and uses interactive input instead.

**Step 2: Commit**

```bash
cd ~/projects/workstation
git add users/dev/home.darwin.nix
git commit -m "macOS: rewrite pigeon-setup-secrets to accept manual input (no 1Password)"
```

---

### Task 8: Update pigeon repo -- remove .env.1password and update devenv.nix

**Files:**
- Delete: `~/projects/pigeon/.env.1password`
- Modify: `~/projects/pigeon/devenv.nix`

**Step 1: Delete .env.1password**

```bash
cd ~/projects/pigeon
git rm .env.1password
```

**Step 2: Update devenv.nix**

Replace the entire file content with:

```nix
{ pkgs, ... }:
{
  packages = [
    pkgs.nodejs_22
  ];

  # Load secrets from .env for local development
  dotenv.enable = true;

  scripts.dev-daemon.exec = ''
    for f in ccr_worker_url ccr_api_key telegram_bot_token telegram_chat_id telegram_webhook_secret telegram_webhook_path_secret; do
      upper=$(echo "$f" | tr '[:lower:]' '[:upper:]')
      export "$upper"="$(cat /run/secrets/$f)"
    done
    npm run --workspace @pigeon/daemon dev -- "$@"
  '';

  scripts.dev-worker.exec = ''
    npm run --workspace @pigeon/worker dev -- "$@"
  '';

  enterShell = ''
    echo ""
    echo "Pigeon dev environment"
    echo "  Node: $(node --version)"
    echo ""
    echo "Commands:"
    echo "  npm install       - Install dependencies"
    echo "  npm run test      - Run all tests"
    echo "  npm run typecheck - Run typechecks"
    echo "  dev-daemon        - Start daemon (secrets from /run/secrets/)"
    echo "  dev-worker        - Start worker dev server"
    echo ""
  '';
}
```

Changes: removed `pkgs._1password-cli`, rewrote `dev-daemon` to read from `/run/secrets/`, removed 1Password check from `enterShell`.

**Step 3: Commit**

```bash
cd ~/projects/pigeon
git add -A
git commit -m "Remove 1Password dependency: delete .env.1password, update devenv.nix"
```

---

### Task 9: Update pigeon skill docs

**Files:**
- Modify: `~/projects/pigeon/.opencode/skills/secrets-and-auth/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/worker-deployment/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/machine-setup-devbox/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/worker-parity-checks/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/daemon-troubleshooting/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/worker-troubleshooting/SKILL.md`
- Modify: `~/projects/pigeon/.opencode/skills/worker-operations/SKILL.md`
- Modify: `~/projects/pigeon/AGENTS.md` (if it references 1Password)

**Step 1: Update secrets-and-auth/SKILL.md**

Replace the "Secret Model" section. Change:
- "1Password is source-of-truth" -> "sops-nix is source-of-truth"
- Remove `op run --env-file` references
- Update quick checks to use `cat /run/secrets/ccr_api_key` instead of `op run`

**Step 2: Update all `op run --env-file=.env.1password` commands**

In every skill file listed above, replace patterns like:
```bash
op run --env-file=.env.1password -- sh -c 'echo ${CCR_API_KEY:+ok}'
```
with:
```bash
CCR_API_KEY="$(cat /run/secrets/ccr_api_key)" sh -c 'echo ${CCR_API_KEY:+ok}'
```

And patterns like:
```bash
op run --env-file=.env.1password -- sh -c 'curl ... -H "Authorization: Bearer $CCR_API_KEY" ...'
```
with:
```bash
curl ... -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" ...
```

**Step 3: Commit**

```bash
cd ~/projects/pigeon
git add -A
git commit -m "Update skill docs: replace 1Password references with sops /run/secrets/"
```

---

### Task 10: Update workstation skill docs

**Files:**
- Modify: `~/projects/workstation/.opencode/skills/managing-secrets/SKILL.md`
- Modify: `~/projects/workstation/.opencode/skills/setting-up-cloudbox/SKILL.md`

**Step 1: Update managing-secrets/SKILL.md**

Remove `op_service_account_token` from the secret inventory table. Add the five new pigeon secrets.

**Step 2: Update setting-up-cloudbox/SKILL.md**

Remove references to `op_service_account_token` for pigeon.

**Step 3: Commit**

```bash
cd ~/projects/workstation
git add -A
git commit -m "Update skill docs: remove 1Password references for pigeon"
```

---

### Task 11: Remove op_service_account_token from sops YAML files

**Files:**
- Modify: `~/projects/workstation/secrets/devbox.yaml`
- Modify: `~/projects/workstation/secrets/cloudbox.yaml`
- Modify: `~/projects/workstation/secrets/chromebook.yaml`

This was partially covered in Tasks 1-3. Verify the key is removed from all three files:

```bash
cd ~/projects/workstation
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops -d secrets/devbox.yaml | grep op_service_account
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops -d secrets/chromebook.yaml | grep op_service_account
```

Expected: no output (key removed).

For cloudbox.yaml, verify on cloudbox or after adding cross-machine edit capability.

---

### Task 12: Deploy and verify on devbox

**Step 1: Apply NixOS config**

```bash
cd ~/projects/workstation
sudo nixos-rebuild switch --flake .#devbox
```

**Step 2: Verify secrets exist in /run/secrets/**

```bash
ls -la /run/secrets/ccr_api_key /run/secrets/telegram_bot_token /run/secrets/telegram_chat_id /run/secrets/telegram_webhook_secret /run/secrets/telegram_webhook_path_secret
```

Expected: all five files present, owned by dev, mode 0400.

**Step 3: Restart pigeon daemon**

```bash
sudo systemctl restart pigeon-daemon
```

**Step 4: Verify daemon is healthy**

```bash
curl http://127.0.0.1:4731/health
journalctl -u pigeon-daemon --since "1 minute ago" --no-pager
```

Expected: health returns 200, no errors in logs.

**Step 5: End-to-end test**

Send a Telegram message to the bot. Verify it appears in daemon logs and is processed.

---

### Task 13: Deploy and verify on cloudbox and chromebook

Repeat Task 12 on cloudbox and chromebook (adjusting commands for home-manager on chromebook: `home-manager switch --flake .#dev@chromebook` and `systemctl --user restart pigeon-daemon`).

---

### Task 14: Deploy and verify on macOS

**Step 1: Apply home-manager config**

```bash
cd ~/Code/workstation  # macOS path
home-manager switch --flake .#dev@macbook
```

**Step 2: Re-run pigeon-setup-secrets**

```bash
pigeon-setup-secrets
```

Enter the five secret values when prompted.

**Step 3: Restart pigeon daemon**

```bash
launchctl kickstart -k gui/$(id -u)/org.nix-community.home.pigeon-daemon
```

**Step 4: Verify**

```bash
curl http://127.0.0.1:4731/health
tail -20 ~/Library/Logs/pigeon-daemon.out.log
```

---

### Task 15: Clean up -- remove allowUnfree comment if appropriate

**Files:**
- Modify: `~/projects/workstation/hosts/devbox/configuration.nix` (line 5)
- Modify: `~/projects/workstation/hosts/cloudbox/configuration.nix` (line 14)

The comment says "Allow unfree packages (1password-cli for pigeon)". Since `_1password-cli` is no longer used, update or remove the comment. If `allowUnfree` is still needed for other packages, just fix the comment. If it's truly only for 1password-cli, consider removing `allowUnfree = true` entirely (check for other unfree packages first).

```bash
cd ~/projects/workstation
git add -A
git commit -m "Clean up: update allowUnfree comment after 1Password removal"
```

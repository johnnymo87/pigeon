# Sops Secrets Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate three pigeon daemon secrets from 1Password to sops, eliminating the 1Password runtime dependency.

**Architecture:** Add the three daemon secrets (CCR_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) to each machine's sops YAML file. Update NixOS/home-manager configs to declare them as sops.secrets, add sops-nix.service dependency, and read them from /run/secrets/ in the daemon ExecStart script. Remove the 1Password op run wrapper and .env.1password. TELEGRAM_WEBHOOK_SECRET and TELEGRAM_WEBHOOK_PATH_SECRET are worker-only (Cloudflare secrets) and not part of this migration.

**Status:** Chromebook is already done (branch `chromebook-pigeon-sops`). Remaining: devbox, cloudbox, macOS, pigeon repo cleanup.

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

This opens the file in your editor with decrypted values. Add these three keys (after the existing `ccr_worker_url` entry):

```yaml
ccr_api_key: <your CCR API key>
telegram_bot_token: <your Telegram bot token>
telegram_chat_id: <your Telegram chat ID>
```

Save and close -- sops re-encrypts automatically.

**Step 2: Verify the secrets were added**

```bash
SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops -d secrets/devbox.yaml | grep -E "ccr_api_key|telegram_bot_token|telegram_chat_id"
```

Expected: all three secrets appear with correct plaintext values.

---

### Task 2: Add secrets to cloudbox sops YAML

**Files:**
- Modify: `~/projects/workstation/secrets/cloudbox.yaml`

**Step 1: Decrypt and edit**

The cloudbox sops file is encrypted with the cloudbox age key, not devbox. You cannot edit it from devbox. Instead, use `sops updatekeys` after adding the devbox key to the cloudbox creation rule, or edit it on cloudbox itself.

Alternative: Since the secrets are the same across machines, and the `.sops.yaml` creation rules already specify which age key encrypts each file, you can add the plaintext values by editing on the appropriate machine.

If you have a way to edit cloudbox.yaml from devbox (e.g., shared key), add the same three keys. Otherwise, this task must be done on cloudbox.

---

### Task 3: Add secrets to chromebook sops YAML

**DONE** -- completed on branch `chromebook-pigeon-sops`.

---

### Task 4: Update devbox NixOS config -- sops.secrets declarations

**Files:**
- Modify: `~/projects/workstation/hosts/devbox/configuration.nix`

**Step 1: Add three new sops.secrets entries**

In the `sops.secrets` block (after `ccr_worker_url` at line ~85-89), add:

```nix
      # Pigeon daemon secrets (replaces op run)
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
```

**Step 2: Add sops-nix.service dependency and rewrite pigeon-daemon ExecStart**

Add `"sops-nix.service"` to `after` and `requires` so secrets are decrypted before the daemon starts. Replace the ExecStart script (lines 190-197):

```nix
    after = [ "network-online.target" "sops-nix.service" "cloudflared-tunnel.service" ];
    requires = [ "sops-nix.service" "cloudflared-tunnel.service" ];
```

```nix
      ExecStart = "${pkgs.writeShellScript "pigeon-daemon-start" ''
        set -euo pipefail
        export CCR_WORKER_URL="$(cat /run/secrets/ccr_worker_url)"
        export CCR_API_KEY="$(cat /run/secrets/ccr_api_key)"
        export TELEGRAM_BOT_TOKEN="$(cat /run/secrets/telegram_bot_token)"
        export TELEGRAM_CHAT_ID="$(cat /run/secrets/telegram_chat_id)"
        export OPENCODE_URL="http://127.0.0.1:4096"
        exec ${pkgs.nodejs}/bin/node /home/dev/projects/pigeon/node_modules/tsx/dist/cli.mjs /home/dev/projects/pigeon/packages/daemon/src/index.ts
      ''}";
```

Note: `${pkgs._1password-cli}` is no longer referenced. If `allowUnfree` (line 5-6) was only needed for `_1password-cli`, update the comment.

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

Apply the same changes as Task 4:

1. Add three `sops.secrets` entries (after existing `ccr_worker_url` declaration, around line ~100)
2. Add `sops-nix.service` to `after` and `requires`
3. Rewrite `pigeon-daemon` ExecStart (lines 254-261) -- same pattern as devbox but with `CCR_MACHINE_ID=cloudbox` already in Environment

```bash
cd ~/projects/workstation
git add hosts/cloudbox/configuration.nix
git commit -m "cloudbox: migrate pigeon secrets from 1Password to sops"
```

---

### Task 6: Update chromebook home-manager config

**DONE** -- completed on branch `chromebook-pigeon-sops`.

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
    for f in ccr_worker_url ccr_api_key telegram_bot_token telegram_chat_id; do
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

Remove `op_service_account_token` from the secret inventory table. Add the three new pigeon daemon secrets.

**Step 2: Update setting-up-cloudbox/SKILL.md**

Remove references to `op_service_account_token` for pigeon.

**Step 3: Commit**

```bash
cd ~/projects/workstation
git add -A
git commit -m "Update skill docs: remove 1Password references for pigeon"
```

---

### Task 11: (Follow-up) Migrate webhook secrets and remove op_service_account_token

**Not part of this migration.** Once all machines are converted:

1. Add `telegram_webhook_secret` and `telegram_webhook_path_secret` to sops (used by parity harness and deployment verification scripts)
2. Remove `op_service_account_token` from all sops YAML files and NixOS/HM configs (no remaining consumers)
3. Remove `.env.1password` references from parity/deployment skill docs

---

### Task 12: Deploy and verify on devbox

**Step 1: Apply NixOS config**

```bash
cd ~/projects/workstation
sudo nixos-rebuild switch --flake .#devbox
```

**Step 2: Verify secrets exist in /run/secrets/**

```bash
ls -la /run/secrets/ccr_api_key /run/secrets/telegram_bot_token /run/secrets/telegram_chat_id
```

Expected: all three files present, owned by dev, mode 0400.

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

Enter the three secret values when prompted.

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

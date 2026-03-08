# OpenCode Plugin Deployment

## Overview

The OpenCode plugin (`packages/opencode-plugin/`) integrates Pigeon with OpenCode sessions via the direct command channel. OpenCode auto-discovers plugin files from `~/.config/opencode/plugins/` (both `.ts` and `.js`).

## Architecture

- **Source**: `packages/opencode-plugin/src/index.ts` (entry point)
- **Dependencies**: `@opencode-ai/plugin`, `@opencode-ai/sdk` (external, provided by OpenCode runtime)
- **Cross-package import**: `../../daemon/src/opencode-direct/contracts` (protocol types, constants, validators)
- **Local modules**: `daemon-client`, `env-detect`, `direct-channel`, `message-tail`, `session-state`, `utils`

## Deployment Methods

### Dev Symlink (for active development)

Symlink the repo source directly into the plugins directory. The module bundler resolves relative imports from the symlink **target** path, so the cross-package import into `daemon/src/opencode-direct/contracts` resolves correctly.

```bash
# Remove any existing plugin file/symlink
rm -f ~/.config/opencode/plugins/opencode-pigeon.ts

# Symlink to repo source
ln -s /home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts \
  ~/.config/opencode/plugins/opencode-pigeon.ts

# Restart OpenCode to load the updated plugin
```

**Pros**: Zero build step, always up-to-date with repo changes.
**Cons**: Requires repo to be present at the expected path. Not suitable for Nix-managed machines without the repo checked out.

### Bundled Build (for stable deployment / Nix)

Bundle all modules into a single file using `npx esbuild`:

```bash
npx esbuild packages/opencode-plugin/src/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile=dist/opencode-pigeon.js \
  --external:@opencode-ai/plugin \
  --external:@opencode-ai/sdk
```

This produces a single `.js` file (~28KB) with all local modules and the contracts inlined. Deploy it to `~/.config/opencode/plugins/opencode-pigeon.js`.

**For Nix**: Create a derivation that runs the bundle command and wire the output into home-manager via `xdg.configFile."opencode/plugins/opencode-pigeon.js"`. See beads issue `ccr-f2i` for tracking.

## Verifying Deployment

After deploying and restarting OpenCode:

```bash
# Check daemon sessions for backend_kind
curl -s http://127.0.0.1:4731/sessions | jq '.sessions[] | {session_id, backend_kind, backend_endpoint}'

# Expect to see:
# {
#   "session_id": "ses-...",
#   "backend_kind": "opencode-plugin-direct",
#   "backend_endpoint": "http://127.0.0.1:<port>/pigeon/direct/execute"
# }
```

If `backend_kind` is null, the plugin is not loaded or is using the old version without direct-channel support.

## Plugin Loading

OpenCode discovers plugins from two sources:
1. **File-based**: All `.ts` and `.js` files in `~/.config/opencode/plugins/` are auto-loaded
2. **Config-based**: Listed in `~/.config/opencode/config.json` under `plugins` key (npm packages)

The Pigeon plugin uses the file-based approach. Other Nix-managed plugins (e.g., `compaction-context.ts`, `non-interactive-env.ts`) are symlinked from the Nix store by home-manager.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `backend_kind: null` in sessions | Old plugin or plugin not loaded | Verify symlink target, restart OpenCode |
| Import errors on startup | Cross-package path broken | Check symlink resolves to repo source, verify `packages/daemon/src/opencode-direct/contracts.ts` exists |
| Plugin loads but commands fail | Direct channel server not starting | Check OpenCode logs for `startDirectChannelServer` errors |
| Nix rebuild overwrites symlink | home-manager manages the plugins dir | Remove the Nix-managed symlink for this plugin, or add the Nix derivation (ccr-f2i) |

## Related

- Plugin source: `packages/opencode-plugin/src/`
- Direct channel contracts: `packages/daemon/src/opencode-direct/contracts.ts`
- Adapter (daemon side): `packages/daemon/src/opencode-direct/adapter.ts`
- Parity harness (direct mode): `packages/daemon/scripts/parity-harness.ts` with `PARITY_MODE=direct`
- Nix derivation tracking: beads `ccr-f2i`

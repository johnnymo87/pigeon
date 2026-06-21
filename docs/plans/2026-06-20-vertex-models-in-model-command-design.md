# Vertex Anthropic + Vertex Gemini Models in `/model`

## Problem

The `/model` command lists available models from an allowlist of providers. The
allowlist lives in `packages/daemon/src/worker/model-ingest.ts`:

```ts
const ALLOWED_PROVIDERS = new Set(["anthropic", "openai", "google", "vertex"]);
```

Two problems:

1. **Vertex models never appear.** OpenCode exposes Vertex-hosted models under
   provider IDs `google-vertex` (Gemini) and `google-vertex-anthropic` (Claude
   on Vertex). The allowlist has no entry for either, so they are filtered out.
2. **Dead entries.** There is no provider with id `google` or `vertex` in
   OpenCode's catalog (verified via `GET /provider`). Those two strings match
   nothing and are no-ops — only `anthropic` and `openai` ever surface today.

Only some machines (macbook, cloudbox) have Vertex credentials connected.
Listing Vertex providers on a machine without creds would surface models that
error when selected, so the allowlist must be configurable per device.

## Approach

Approach 1 (configuration override via environment variable): keep a sane code
default and allow a per-device override via `PIGEON_ALLOWED_PROVIDERS`.

- **Default** (machines that don't set the env var): `["anthropic", "openai"]`.
  This drops the dead `google`/`vertex` strings and preserves the real,
  working behavior for all current machines.
- **Per-device opt-in:** macbook and cloudbox set
  `PIGEON_ALLOWED_PROVIDERS=anthropic,openai,google-vertex,google-vertex-anthropic`.

The env var is a comma-separated list of OpenCode provider IDs. When set and
non-empty, it fully replaces the default (not merged), giving exact per-device
control.

## Changes

### 1. `packages/daemon/src/config.ts`

- Add `allowedProviders?: string[]` to `DaemonConfig`.
- In `loadConfig`, parse `env.PIGEON_ALLOWED_PROVIDERS` with the existing
  `parseList` helper. Set `allowedProviders` to the parsed list when non-empty,
  otherwise `undefined` (so the ingest layer applies its default).

### 2. `packages/daemon/src/worker/model-ingest.ts`

- Replace the module-level `ALLOWED_PROVIDERS` constant with:
  ```ts
  const DEFAULT_ALLOWED_PROVIDERS = ["anthropic", "openai"];
  ```
- Add `allowedProviders?: string[]` to both `ModelListCommandInput` and
  `ModelSetCommandInput`.
- In `ingestModelListCommand` and `ingestModelSetCommand`, build the set from
  the input:
  ```ts
  const allowedSet = new Set(input.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS);
  ```
  - List: `result.all.filter((p) => allowedSet.has(p.id))`.
  - Set: the existing provider/model existence check is unaffected (it validates
    against `result.all`, not the allowlist), so no behavior change there. The
    allowlist only governs what `model_list` displays.

### 3. `packages/daemon/src/index.ts`

- Pass `allowedProviders: config.allowedProviders` into both the
  `ingestModelListCommand` and `ingestModelSetCommand` invocations
  (`onModelList` / `onModelSet`).

### 4. Tests — `packages/daemon/test/model-ingest.test.ts`

- Update the "filters out non-allowed providers" expectation: `openai` and
  `anthropic` remain allowed by default; add a case asserting `google-vertex` /
  `google-vertex-anthropic` are filtered out by default.
- Add a case passing `allowedProviders: ["anthropic","openai","google-vertex","google-vertex-anthropic"]`
  and asserting the vertex providers/models now appear.

## Deployment (out of scope for this repo)

Setting `PIGEON_ALLOWED_PROVIDERS` on macbook and cloudbox happens in the
workstation repo's systemd service definition for the pigeon daemon, not here.
Value for those two machines:

```
PIGEON_ALLOWED_PROVIDERS=anthropic,openai,google-vertex,google-vertex-anthropic
```

## Testing

- `npm run --workspace @pigeon/daemon test` (model-ingest + config suites).
- `npm run typecheck`.
- Manual: on cloudbox with the env var set, `/model` should list
  `google-vertex/*` and `google-vertex-anthropic/*` entries; `/model
  google-vertex-anthropic/claude-...` should set the override.

## Out of Scope

- Worker-side validation of provider names (worker passes the model code through
  unchanged; the daemon validates against `result.all`).
- Filtering `model_list` by `connected` rather than `all` (separate concern).

# Vertex Models in `/model` Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `/model` command list Vertex-hosted model families (`google-vertex`, `google-vertex-anthropic`) on machines that opt in via a per-device `PIGEON_ALLOWED_PROVIDERS` env var, while dropping the dead `google`/`vertex` allowlist entries.

**Architecture:** Move the hardcoded provider allowlist in `model-ingest.ts` to a configurable input. The daemon reads `PIGEON_ALLOWED_PROVIDERS` (comma-separated provider IDs) into `DaemonConfig.allowedProviders` and threads it into the model-list/model-set ingest functions. When unset, ingest falls back to a default of `["anthropic", "openai"]`.

**Tech Stack:** TypeScript, Node, Vitest. Packages: `@pigeon/daemon`.

---

### Task 1: Add `allowedProviders` to daemon config

**Files:**
- Modify: `packages/daemon/src/config.ts`
- Test: `packages/daemon/test/config.test.ts`

**Step 1: Write the failing test**

Add to the `describe("loadConfig", ...)` block in `packages/daemon/test/config.test.ts`:

```ts
  it("parses PIGEON_ALLOWED_PROVIDERS into a list", () => {
    const config = loadConfig({
      PIGEON_ALLOWED_PROVIDERS: "anthropic, openai ,google-vertex,google-vertex-anthropic",
    });
    expect(config.allowedProviders).toEqual([
      "anthropic",
      "openai",
      "google-vertex",
      "google-vertex-anthropic",
    ]);
  });

  it("leaves allowedProviders undefined when PIGEON_ALLOWED_PROVIDERS is unset or empty", () => {
    expect(loadConfig({}).allowedProviders).toBeUndefined();
    expect(loadConfig({ PIGEON_ALLOWED_PROVIDERS: "" }).allowedProviders).toBeUndefined();
    expect(loadConfig({ PIGEON_ALLOWED_PROVIDERS: "  " }).allowedProviders).toBeUndefined();
  });
```

**Step 2: Run test to verify it fails**

Run: `npm run --workspace @pigeon/daemon test -- config`
Expected: FAIL — `allowedProviders` is not a property on the config object.

**Step 3: Write minimal implementation**

In `packages/daemon/src/config.ts`, add the field to the `DaemonConfig` interface (after `serveLiveness`):

```ts
  serveLiveness: "self" | "http";
  allowedProviders?: string[];
```

In `loadConfig`, before the `return`, add:

```ts
  const allowedProviders = parseList(env.PIGEON_ALLOWED_PROVIDERS);
```

And in the returned object (after `serveLiveness`):

```ts
    serveLiveness: env.PIGEON_SERVE_LIVENESS === "self" ? "self" : "http",
    allowedProviders: allowedProviders.length > 0 ? allowedProviders : undefined,
```

(`parseList` already trims each item and drops empties.)

**Step 4: Run test to verify it passes**

Run: `npm run --workspace @pigeon/daemon test -- config`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/config.ts packages/daemon/test/config.test.ts
git commit -m "feat(daemon): parse PIGEON_ALLOWED_PROVIDERS into config.allowedProviders"
```

---

### Task 2: Make `model-ingest` use a configurable allowlist

**Files:**
- Modify: `packages/daemon/src/worker/model-ingest.ts`
- Test: `packages/daemon/test/model-ingest.test.ts`

**Step 1: Write/adjust failing tests**

In `packages/daemon/test/model-ingest.test.ts`:

(a) Update the existing `"filters out non-allowed providers"` test so the mocked
`all` includes vertex providers and asserts they are filtered out **by default**
(default is now `["anthropic", "openai"]`). Replace that test body with:

```ts
  it("filters out non-allowed providers by default (anthropic/openai only)", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            { id: "anthropic", models: { "claude-opus-4-6": {} } },
            { id: "openai", models: { "gpt-5.4": {} } },
            { id: "google-vertex", models: { "gemini-3-pro": {} } },
            { id: "google-vertex-anthropic", models: { "claude-sonnet-4-6": {} } },
            { id: "mistral", models: { "mistral-7b": {} } },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
    });

    await ingestModelListCommand(input);

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("anthropic");
    expect(text).toContain("openai");
    expect(text).not.toContain("google-vertex");
    expect(text).not.toContain("mistral");
  });
```

(b) Add a new test asserting that when `allowedProviders` includes the vertex
families, they appear:

```ts
  it("includes vertex providers when allowedProviders opts in", async () => {
    const input = makeInput({
      allowedProviders: ["anthropic", "openai", "google-vertex", "google-vertex-anthropic"],
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            { id: "anthropic", models: { "claude-opus-4-6": {} } },
            { id: "google-vertex", models: { "gemini-3-pro": {} } },
            { id: "google-vertex-anthropic", models: { "claude-sonnet-4-6": {} } },
            { id: "mistral", models: { "mistral-7b": {} } },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic", "google-vertex", "google-vertex-anthropic"],
        }),
      },
    });

    await ingestModelListCommand(input);

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("google-vertex");
    expect(text).toContain("google-vertex/gemini-3-pro");
    expect(text).toContain("google-vertex-anthropic/claude-sonnet-4-6");
    expect(text).not.toContain("mistral");
  });
```

Note: `makeInput` currently spreads `...overrides` onto the returned object, so
passing `allowedProviders` through `overrides` works once the field exists on
the input type.

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- model-ingest`
Expected: FAIL — `allowedProviders` not on input type; default still includes the
old `google`/`vertex` no-ops and excludes the real vertex IDs.

**Step 3: Write minimal implementation**

In `packages/daemon/src/worker/model-ingest.ts`:

Replace line 4:

```ts
const ALLOWED_PROVIDERS = new Set(["anthropic", "openai", "google", "vertex"]);
```

with:

```ts
const DEFAULT_ALLOWED_PROVIDERS = ["anthropic", "openai"];
```

Add `allowedProviders?: string[]` to both `ModelListCommandInput` and
`ModelSetCommandInput` interfaces.

In `ingestModelListCommand`, replace:

```ts
    const allowedProviders = result.all.filter((p) => ALLOWED_PROVIDERS.has(p.id));
```

with:

```ts
    const allowedSet = new Set(input.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS);
    const allowedProviders = result.all.filter((p) => allowedSet.has(p.id));
```

(`ingestModelSetCommand` validates against `result.all` directly and does not use
the allowlist, so it needs no logic change — only the interface field is added
so `index.ts` can pass it uniformly.)

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/daemon test -- model-ingest`
Expected: PASS (all model-ingest tests green)

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/model-ingest.ts packages/daemon/test/model-ingest.test.ts
git commit -m "feat(daemon): configurable model allowlist with anthropic/openai default"
```

---

### Task 3: Thread `config.allowedProviders` through the daemon wiring

**Files:**
- Modify: `packages/daemon/src/index.ts` (around lines 215-231)

**Step 1: Update the invocations**

In `onModelList`, add `allowedProviders` to the `ingestModelListCommand` call:

```ts
          await ingestModelListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            machineId: config.machineId, opencodeClient: client, sendTelegramReply: sendTelegramMessage,
            allowedProviders: config.allowedProviders,
          });
```

In `onModelSet`, add `allowedProviders` to the `ingestModelSetCommand` call:

```ts
          await ingestModelSetCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            model: msg.model, machineId: config.machineId, opencodeClient: client,
            storage, sendTelegramReply: sendTelegramMessage,
            allowedProviders: config.allowedProviders,
          });
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors)

**Step 3: Run full daemon test suite**

Run: `npm run --workspace @pigeon/daemon test`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): pass allowedProviders into model ingest handlers"
```

---

### Task 4: Update docs

**Files:**
- Modify: `packages/daemon/.opencode/skills/.../` references and `.opencode/skills/worker-architecture/SKILL.md` (line ~135 mentions the allowlist)
- Modify: `AGENTS.md` if it documents the provider allowlist (it does not currently — verify with grep before editing)

**Step 1: Find references to the old allowlist wording**

Run: `rg -n "anthropic, openai, google, vertex" .opencode AGENTS.md docs`
Expected: surfaces `.opencode/skills/worker-architecture/SKILL.md:135`.

**Step 2: Update the wording**

In `.opencode/skills/worker-architecture/SKILL.md` line ~135, change the
parenthetical from `(anthropic, openai, google, vertex)` to describe the new
behavior:

```
- `/model <session-id>`: lists available models from the configured allowlist (default `anthropic`, `openai`; extendable per-device via `PIGEON_ALLOWED_PROVIDERS`, e.g. to add `google-vertex` and `google-vertex-anthropic`) with the current default.
```

**Step 3: Commit**

```bash
git add .opencode/skills/worker-architecture/SKILL.md
git commit -m "docs: document configurable model provider allowlist"
```

---

### Task 5: Final verification

**Step 1: Full typecheck + test**

Run: `npm run typecheck && npm run test`
Expected: PASS

**Step 2: Manual smoke (optional, on a vertex-enabled machine)**

With `PIGEON_ALLOWED_PROVIDERS=anthropic,openai,google-vertex,google-vertex-anthropic`
set for the daemon, reply `/model` to a session notification and confirm
`google-vertex/*` and `google-vertex-anthropic/*` entries appear. Then
`/model google-vertex-anthropic/claude-sonnet-4-6@default` sets the override.

---

## Deployment note (workstation repo, not this repo)

After merge + cross-device deploy, set the env var on **macbook** and
**cloudbox** in the workstation systemd service for the pigeon daemon:

```
PIGEON_ALLOWED_PROVIDERS=anthropic,openai,google-vertex,google-vertex-anthropic
```

Other machines need no change (default `anthropic,openai` preserves current behavior).

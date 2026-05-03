# Revive-on-Reply Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the daemon's plugin-direct delivery to a session fails with a connection error (e.g. opencode-serve was restarted and the old plugin is dead), fall back to delivering the prompt directly to opencode-serve via `prompt_async`. This makes Telegram replies to post-reset sessions "just work" instead of vanishing silently.

**Architecture:** Adds a single fallback branch to `command-ingest.ts`'s existing `isConnectionError` block. The fallback uses `OpencodeClient.sendPrompt` (the same plugin-free path the swarm arbiter uses) and recovers the session's working directory via a new `OpencodeClient.getSession(sessionId)` method. On success, the daemon clears the dead `backendEndpoint` from its session row (so the next reply doesn't re-try the dead port) but keeps the row alive — the plugin will re-register a fresh `backendEndpoint` via `lateDiscoverSession` on the next `message.updated` event triggered by this very prompt. From the second reply onward, full plugin features (model overrides, media, question buttons) are restored automatically.

**Tech Stack:** TypeScript, Node.js, vitest, better-sqlite3. No new dependencies. All work lives in `packages/daemon`.

**Design doc:** `docs/plans/2026-05-03-revive-on-reply-design.md`

---

## Pre-flight

**Read the design doc first.** Especially the "Degraded mode on the first revival reply" and "Slash commands" sections — they explain why this fix only touches `command-ingest.ts` and why three plugin features (model override, media, question buttons) are deliberately not preserved on the very first revival reply.

**Required skills before starting any task:**
- `superpowers:test-driven-development` — every code task is test-first.
- `superpowers:verification-before-completion` — run the verification commands before claiming a task is done.
- `daemon-development` — workspace test/typecheck commands and adapter conventions.

**Key file references** (read these once at the start; they ground every task):

| File | Lines | What it does |
|------|-------|--------------|
| `packages/daemon/src/worker/command-ingest.ts` | 349-401 | The `isConnectionError` block where the fallback inserts. |
| `packages/daemon/src/opencode-client.ts` | 1-149 | Where `getSession` will be added. |
| `packages/daemon/src/swarm/registry.ts` | 27-52 | Reference implementation for `GET /session/:id` parsing. |
| `packages/daemon/src/storage/repos.ts` | 77-196 | `SessionRepository` — where `clearBackendEndpoint` will be added. |
| `packages/daemon/src/index.ts` | 64-69 | The single call site for `ingestWorkerCommand` — where new dependencies are wired. |
| `packages/daemon/src/worker/launch-ingest.ts` | 59-77 | Reference pattern for the fire-and-forget `oc-auto-attach` spawn. |
| `packages/daemon/test/command-ingest.test.ts` | 603-630 | Existing dead-session test that this work modifies. |

**Workspace commands** (from `AGENTS.md` quickstart):

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon typecheck
npm run test         # all packages
npm run typecheck    # all packages
```

**Worktree:** This work should run in a dedicated git worktree off `main`. If not already in one, use the `superpowers:using-git-worktrees` skill to set one up before starting Task 1.

---

## Task 1: Add `OpencodeClient.getSession`

**Why:** The fallback needs to recover the session's working directory (`directory` field) from opencode-serve. The swarm `SessionDirectoryRegistry` already does this, but it's a stateful cache designed for the arbiter's high-throughput workload. For the fallback path we want a simpler, stateless one-shot fetch that surfaces the 404-vs-other-error distinction (so the caller can tell "session genuinely gone" from "opencode-serve unreachable").

**Files:**
- Modify: `packages/daemon/src/opencode-client.ts`
- Modify: `packages/daemon/test/opencode-client.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/test/opencode-client.test.ts`:

```ts
describe("getSession", () => {
  it("returns session when opencode-serve responds 200 with a directory", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "ses_abc", directory: "/home/dev/projects/pigeon" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock });

    const result = await client.getSession("ses_abc");

    expect(result).toEqual({ id: "ses_abc", directory: "/home/dev/projects/pigeon" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4096/session/ses_abc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null when opencode-serve responds 404", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock });

    expect(await client.getSession("ses_gone")).toBeNull();
  });

  it("throws on other non-OK statuses (so caller can distinguish from 404)", async () => {
    const fetchMock = vi.fn(async () => new Response("oops", { status: 500 }));
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock });

    await expect(client.getSession("ses_x")).rejects.toThrow(/getSession failed.*500/);
  });

  it("throws on network error (so caller can distinguish from 404)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock });

    await expect(client.getSession("ses_x")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("returns the directory even when other fields are missing", async () => {
    // Defensive: opencode-serve's response shape isn't formally pinned by us;
    // we only depend on { id, directory } being present.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "ses_x", directory: "/tmp", extra: "stuff" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock });

    expect((await client.getSession("ses_x"))?.directory).toBe("/tmp");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run --workspace @pigeon/daemon test -- opencode-client
```

Expected: FAIL with "client.getSession is not a function" (or similar).

**Step 3: Implement `getSession`**

Add to `packages/daemon/src/opencode-client.ts`:

```ts
  /**
   * Look up a session by id. Returns null on 404 (session truly gone),
   * throws on other failures (network error, 5xx). The 404 vs throw split
   * lets callers distinguish "session deleted from opencode-serve" from
   * "opencode-serve is unreachable."
   */
  async getSession(sessionId: string): Promise<{ id: string; directory: string } | null> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`getSession failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { id?: string; directory?: string };
    if (!body.id || !body.directory) {
      throw new Error(`getSession response missing id or directory: ${JSON.stringify(body)}`);
    }
    return { id: body.id, directory: body.directory };
  }
```

**Step 4: Run test to verify it passes**

```bash
npm run --workspace @pigeon/daemon test -- opencode-client
npm run --workspace @pigeon/daemon typecheck
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add packages/daemon/src/opencode-client.ts packages/daemon/test/opencode-client.test.ts
git commit -m "feat(daemon): add OpencodeClient.getSession with 404-vs-error split"
```

---

## Task 2: Add `SessionRepository.clearBackendEndpoint`

**Why:** After a successful fallback delivery, the dead `backendEndpoint`/`backendAuthToken` columns on the session row are stale. We clear them so the next reply doesn't re-try the dead plugin endpoint and force another fallback. The plugin's `lateDiscoverSession` (triggered by the fallback prompt itself) will repopulate them on the next `message.updated` event. The columns are already nullable.

**Files:**
- Modify: `packages/daemon/src/storage/repos.ts`
- Modify: `packages/daemon/test/storage.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/test/storage.test.ts` (find the `SessionRepository` describe block):

```ts
  it("clearBackendEndpoint nulls backend_endpoint and backend_auth_token, leaves other fields alone", () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-clear",
      cwd: "/tmp",
      label: "demo",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const updated = storage.sessions.clearBackendEndpoint("sess-clear");
    expect(updated).toBe(true);

    const row = storage.sessions.get("sess-clear");
    expect(row).not.toBeNull();
    expect(row!.backendEndpoint).toBeNull();
    expect(row!.backendAuthToken).toBeNull();
    // backendKind is preserved so a future late-discovery upsert keeps semantics
    expect(row!.backendKind).toBe("opencode-plugin-direct");
    // Other fields untouched
    expect(row!.cwd).toBe("/tmp");
    expect(row!.label).toBe("demo");
    expect(row!.notify).toBe(true);

    storage.db.close();
  });

  it("clearBackendEndpoint returns false for unknown session", () => {
    const storage = openStorageDb(":memory:");
    expect(storage.sessions.clearBackendEndpoint("nope")).toBe(false);
    storage.db.close();
  });
```

**Step 2: Run test to verify it fails**

```bash
npm run --workspace @pigeon/daemon test -- storage
```

Expected: FAIL with "clearBackendEndpoint is not a function".

**Step 3: Implement `clearBackendEndpoint`**

Add to `SessionRepository` in `packages/daemon/src/storage/repos.ts` (alongside `setNotify`, `setModelOverride`, etc.):

```ts
  clearBackendEndpoint(sessionId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE sessions SET backend_endpoint = NULL, backend_auth_token = NULL, updated_at = ? WHERE session_id = ?",
      )
      .run(Date.now(), sessionId);
    return result.changes > 0;
  }
```

**Step 4: Run test to verify it passes**

```bash
npm run --workspace @pigeon/daemon test -- storage
npm run --workspace @pigeon/daemon typecheck
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add packages/daemon/src/storage/repos.ts packages/daemon/test/storage.test.ts
git commit -m "feat(daemon): add SessionRepository.clearBackendEndpoint helper"
```

---

## Task 3: Build the `reviveAndDeliver` helper

**Why:** Encapsulate the fallback flow (verify session exists → recover directory → send prompt → clear endpoint → fire-and-forget oc-auto-attach) in a single testable unit, separate from `command-ingest.ts`. Keeps the failure-branch change in Task 4 small.

**Files:**
- Create: `packages/daemon/src/worker/revive-and-deliver.ts`
- Create: `packages/daemon/test/revive-and-deliver.test.ts`

**Step 1: Write the failing test**

Create `packages/daemon/test/revive-and-deliver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { reviveAndDeliver, type ReviveAndDeliverDeps } from "../src/worker/revive-and-deliver";

function makeDeps(overrides: Partial<ReviveAndDeliverDeps> = {}): ReviveAndDeliverDeps {
  return {
    opencodeClient: {
      async getSession() { return { id: "sess-1", directory: "/tmp/proj" }; },
      async sendPrompt() { /* ok */ },
    },
    spawn: vi.fn(() => ({
      on: vi.fn(),
      unref: vi.fn(),
    })) as unknown as ReviveAndDeliverDeps["spawn"],
    ...overrides,
  };
}

describe("reviveAndDeliver", () => {
  it("delivers via opencode-serve, clears backendEndpoint, and spawns oc-auto-attach on success", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) as unknown as ReviveAndDeliverDeps["spawn"];

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "fix the bug",
      makeDeps({
        opencodeClient: {
          async getSession() { return { id: "sess-1", directory: "/tmp/proj" }; },
          async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
        },
        spawn,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(sendPromptCalls).toEqual([{ sid: "sess-1", dir: "/tmp/proj", prompt: "fix the bug" }]);

    const row = storage.sessions.get("sess-1");
    expect(row?.backendEndpoint).toBeNull();
    expect(row?.backendAuthToken).toBeNull();
    // Session row itself NOT deleted
    expect(row).not.toBeNull();

    expect(spawn).toHaveBeenCalledWith("oc-auto-attach", ["sess-1"], expect.any(Object));

    storage.db.close();
  });

  it("returns sessionGone when opencode-serve says 404 and does NOT clear endpoint", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-gone",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-gone",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { return null; },
          async sendPrompt() { throw new Error("should not be called"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "sessionGone" });
    // Endpoint NOT cleared (caller will delete the whole row)
    const row = storage.sessions.get("sess-gone");
    expect(row?.backendEndpoint).toBe("http://127.0.0.1:7777/dead");

    storage.db.close();
  });

  it("returns deliveryFailed with the error message when sendPrompt throws", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { return { id: "sess-1", directory: "/tmp" }; },
          async sendPrompt() { throw new Error("opencode-serve borked"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "deliveryFailed", error: "opencode-serve borked" });
    // Endpoint NOT cleared on failure (we want to preserve state for diagnosis)
    expect(storage.sessions.get("sess-1")?.backendEndpoint).toBe("http://127.0.0.1:7777/dead");
  });

  it("returns serveUnreachable when getSession throws (not a 404)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { throw new Error("ECONNREFUSED"); },
          async sendPrompt() { throw new Error("should not be called"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "serveUnreachable", error: "ECONNREFUSED" });
  });

  it("swallows oc-auto-attach ENOENT (host without the script installed)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const spawn = vi.fn(() => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as unknown as ReviveAndDeliverDeps["spawn"];

    // Should still return ok despite the spawn failure
    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({ spawn }),
    );

    expect(result).toEqual({ ok: true });
  });

  it("returns sessionMissing if local session row doesn't exist (defensive)", async () => {
    const storage = openStorageDb(":memory:");

    const result = await reviveAndDeliver(
      storage,
      "sess-nope",
      "hello",
      makeDeps(),
    );

    expect(result).toEqual({ ok: false, reason: "sessionMissing" });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run --workspace @pigeon/daemon test -- revive-and-deliver
```

Expected: FAIL — module doesn't exist.

**Step 3: Implement `reviveAndDeliver`**

Create `packages/daemon/src/worker/revive-and-deliver.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { StorageDb } from "../storage/database";
import type { OpencodeClient } from "../opencode-client";

/**
 * Result of a fallback delivery attempt.
 *
 * Reasons:
 *   sessionMissing    — local daemon row doesn't exist (caller skipped the
 *                       initial lookup or it was deleted out from under us).
 *   sessionGone       — opencode-serve returned 404; session truly deleted.
 *                       Caller should delete the local row and notify the user.
 *   serveUnreachable  — getSession threw (network error, 5xx). Caller should
 *                       leave the session row alone and notify the user.
 *   deliveryFailed    — sendPrompt threw. Caller should leave row alone and
 *                       notify the user with the error message.
 */
export type ReviveResult =
  | { ok: true }
  | { ok: false; reason: "sessionMissing" }
  | { ok: false; reason: "sessionGone" }
  | { ok: false; reason: "serveUnreachable"; error: string }
  | { ok: false; reason: "deliveryFailed"; error: string };

export interface ReviveAndDeliverDeps {
  /** Subset of OpencodeClient we actually need. Narrow type for easy mocking. */
  opencodeClient: Pick<OpencodeClient, "getSession" | "sendPrompt">;
  /** Injected for tests; defaults to node child_process.spawn. */
  spawn?: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: { stdio?: "ignore" | "inherit" | "pipe"; detached?: boolean },
  ) => ChildProcess;
}

/**
 * Deliver a prompt to opencode-serve, bypassing the (dead) plugin endpoint.
 *
 * The first reply after a serve restart loses model overrides, media, and
 * question-button capability for that one prompt — see the design doc
 * "Degraded mode on the first revival reply" section. Subsequent replies
 * heal automatically via the plugin's lateDiscoverSession path.
 *
 * On success: clears the dead backendEndpoint/backendAuthToken on the
 * session row (so the next reply doesn't re-try the dead port until the
 * plugin re-registers) and fires `oc-auto-attach <sid>` best-effort to open
 * the session in the user's tmux+nvim.
 *
 * On any failure: leaves the session row alone for the caller to handle.
 */
export async function reviveAndDeliver(
  storage: StorageDb,
  sessionId: string,
  prompt: string,
  deps: ReviveAndDeliverDeps,
): Promise<ReviveResult> {
  const local = storage.sessions.get(sessionId);
  if (!local) {
    return { ok: false, reason: "sessionMissing" };
  }

  let serveSession: { id: string; directory: string } | null;
  try {
    serveSession = await deps.opencodeClient.getSession(sessionId);
  } catch (err) {
    return {
      ok: false,
      reason: "serveUnreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!serveSession) {
    return { ok: false, reason: "sessionGone" };
  }

  try {
    await deps.opencodeClient.sendPrompt(serveSession.id, serveSession.directory, prompt);
  } catch (err) {
    return {
      ok: false,
      reason: "deliveryFailed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  storage.sessions.clearBackendEndpoint(sessionId);

  spawnAutoAttach(sessionId, deps.spawn ?? nodeSpawn);

  return { ok: true };
}

/**
 * Fire-and-forget oc-auto-attach. Mirrors launch-ingest.ts:59-77 — must
 * tolerate ENOENT (cloudbox without the script) and async error events.
 *
 * OC_AUTO_ATTACH_BIN is honored for systemd-managed deployments where the
 * daemon's PATH is locked down (see launch-ingest.ts comment at lines 54-58).
 */
function spawnAutoAttach(
  sessionId: string,
  spawnFn: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: { stdio?: "ignore" | "inherit" | "pipe"; detached?: boolean },
  ) => ChildProcess,
): void {
  try {
    const bin = process.env.OC_AUTO_ATTACH_BIN ?? "oc-auto-attach";
    const child = spawnFn(bin, [sessionId], { stdio: "ignore", detached: true });
    child.on?.("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        console.warn(`[revive-and-deliver] auto-attach spawn failed (async):`, err);
      }
    });
    child.unref?.();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[revive-and-deliver] auto-attach spawn failed (sync):`, err);
    }
  }
}
```

**Step 4: Run tests to verify pass**

```bash
npm run --workspace @pigeon/daemon test -- revive-and-deliver
npm run --workspace @pigeon/daemon typecheck
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/revive-and-deliver.ts packages/daemon/test/revive-and-deliver.test.ts
git commit -m "feat(daemon): add reviveAndDeliver fallback helper"
```

---

## Task 4: Wire the fallback into `command-ingest.ts`'s connection-error branch

**Why:** This is the heart of the change. When `deliverViaAdapter` hits `isConnectionError`, instead of immediately deleting the session and acking, attempt revival. On success: keep the session row, ack the command. On `sessionGone`: keep the existing behavior (delete row, ack, notify user). On other failures: notify user, ack.

**Files:**
- Modify: `packages/daemon/src/worker/command-ingest.ts`
- Modify: `packages/daemon/test/command-ingest.test.ts`

### Step 1: Update existing dead-session test to reflect the new behavior

The test at `packages/daemon/test/command-ingest.test.ts:603` currently asserts that the session is deleted on connection error. With this change, the new default (when revival succeeds) is that the session is *kept* and the endpoint is cleared. We need to update the existing test and add new tests for each branch.

Replace the existing `"cleans up dead sessions when delivery fails with a connection error"` test with the following four tests:

```ts
  describe("connection-error fallback (revive-on-reply)", () => {
    it("revives via opencode-serve, keeps session row, clears backendEndpoint, acks", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-revive",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-revive", sessionId: "sess-revive", command: "fix the bug", chatId: "5" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-revive", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          // No-op spawn so oc-auto-attach doesn't try to spawn anything in the test.
          spawn: () => ({ on: () => {}, unref: () => {} }) as unknown as ReturnType<typeof require("child_process").spawn>,
        },
      );

      // Session kept, endpoint cleared
      const row = storage.sessions.get("sess-revive");
      expect(row).not.toBeNull();
      expect(row!.backendEndpoint).toBeNull();
      expect(row!.backendAuthToken).toBeNull();

      // Fallback delivery happened
      expect(sendPromptCalls).toEqual([{ sid: "sess-revive", dir: "/tmp/proj", prompt: "fix the bug" }]);

      // Command acked (no unfinished inbox entries)
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("deletes session and notifies user when opencode-serve says 404", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-gone",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-gone", sessionId: "sess-gone", command: "hello", chatId: "9" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return null; },
            async sendPrompt() { throw new Error("should not be called"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: () => ({ on: () => {}, unref: () => {} }) as unknown as ReturnType<typeof require("child_process").spawn>,
        },
      );

      // Session deleted (matches old behavior for the truly-gone case)
      expect(storage.sessions.get("sess-gone")).toBeNull();

      // User notified
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.chatId).toBe("9");
      expect(tgCalls[0]!.text).toMatch(/no longer exists|gone/i);

      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("notifies user and keeps session when opencode-serve is unreachable", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-unreach",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-unreach", sessionId: "sess-unreach", command: "hi", chatId: "10" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { throw new Error("ECONNREFUSED"); },
            async sendPrompt() { throw new Error("should not be called"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: () => ({ on: () => {}, unref: () => {} }) as unknown as ReturnType<typeof require("child_process").spawn>,
        },
      );

      // Session kept (we don't know if it's gone or just unreachable)
      const row = storage.sessions.get("sess-unreach");
      expect(row).not.toBeNull();
      // Endpoint preserved for diagnosis
      expect(row!.backendEndpoint).toBe("http://127.0.0.1:7777/pigeon/direct/execute");

      // User notified
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.text).toMatch(/unreachable|opencode-serve/i);

      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("notifies user and keeps session when sendPrompt itself fails", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-deliv-fail",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-deliv-fail", sessionId: "sess-deliv-fail", command: "hi", chatId: "11" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-deliv-fail", directory: "/tmp" }; },
            async sendPrompt() { throw new Error("opencode-serve 500"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: () => ({ on: () => {}, unref: () => {} }) as unknown as ReturnType<typeof require("child_process").spawn>,
        },
      );

      // Session kept
      expect(storage.sessions.get("sess-deliv-fail")).not.toBeNull();
      // User notified with error
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.text).toMatch(/opencode-serve 500|delivery failed/i);
      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);
      storage.db.close();
    });

    it("does not attempt revival when opencodeClient is not provided (graceful degradation to old behavior)", async () => {
      // If the daemon is configured without OPENCODE_URL, opencodeClient is
      // undefined. Fall back to the original behavior: delete the dead session.
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-no-client",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-no-client", sessionId: "sess-no-client", command: "hi", chatId: "12" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          // No opencodeClient — simulates daemon without OPENCODE_URL
        },
      );

      // Old behavior preserved: session deleted
      expect(storage.sessions.get("sess-no-client")).toBeNull();
      storage.db.close();
    });
  });

  // Keep this existing test as-is — non-connection errors still don't trigger revival.
  it("does not clean up sessions on business logic errors", async () => { /* unchanged */ });
```

(Leave the `"does not clean up sessions on business logic errors"` test from line 632 untouched — it still applies and proves the connection-error guard is real.)

### Step 2: Run tests to verify they fail

```bash
npm run --workspace @pigeon/daemon test -- command-ingest
```

Expected: the new tests FAIL because the new options (`opencodeClient`, `sendTelegramReply`, `spawn`) and the fallback branch don't exist yet.

### Step 3: Extend `WorkerCommandIngestOptions` and `deliverViaAdapter`

In `packages/daemon/src/worker/command-ingest.ts`:

**3a.** Add the new options to the interface (after the existing fields, around line 39):

```ts
  /** OpenCode client for plugin-free fallback delivery on plugin death. */
  opencodeClient?: Pick<OpencodeClient, "getSession" | "sendPrompt">;
  /** Send a reply to Telegram (used for revive-on-reply error notifications). */
  sendTelegramReply?: (chatId: string, text: string) => Promise<void>;
  /** Injected spawn for testing (passed through to reviveAndDeliver). */
  spawn?: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: { stdio?: "ignore" | "inherit" | "pipe"; detached?: boolean },
  ) => import("child_process").ChildProcess;
```

Add the import at the top of the file:

```ts
import type { OpencodeClient } from "../opencode-client";
import { reviveAndDeliver } from "./revive-and-deliver";
```

**3b.** Thread the new options through `deliverViaAdapter`. Change its signature (line 363) to accept an `IngestOptions` parameter, and pass `options` from each call site (lines 304 and 344):

```ts
async function deliverViaAdapter(
  adapter: CommandDeliveryAdapter,
  session: SessionRecord,
  msg: ExecuteMessage,
  commandId: string,
  storage: StorageDb,
  options: WorkerCommandIngestOptions,
  media?: CommandDeliveryContext["media"],
): Promise<void> {
```

Update the two callers (search for `deliverViaAdapter(`) to pass `options` as the new sixth argument.

**3c.** Replace the `if (isConnectionError(result.error))` block (lines 392-398) with the fallback logic:

```ts
  if (isConnectionError(result.error)) {
    // Plugin endpoint is dead. If we have an opencodeClient, try the
    // plugin-free fallback (revive-on-reply). Otherwise fall back to the
    // original behavior of deleting the session.
    if (options.opencodeClient) {
      const revived = await reviveAndDeliver(
        storage,
        msg.sessionId,
        msg.command,
        {
          opencodeClient: options.opencodeClient,
          ...(options.spawn ? { spawn: options.spawn } : {}),
        },
      );

      if (revived.ok) {
        console.log(`[command-ingest] revived sessionId=${msg.sessionId} commandId=${commandId} (plugin-free fallback)`);
        storage.inbox.markDone(commandId);
        return;
      }

      if (revived.reason === "sessionGone") {
        console.warn(`[command-ingest] session gone in opencode-serve sessionId=${msg.sessionId}`);
        storage.sessions.delete(msg.sessionId);
        await options.sendTelegramReply?.(
          msg.chatId,
          `Session no longer exists. The opencode session was deleted from this machine.`,
        );
        storage.inbox.markDone(commandId);
        return;
      }

      if (revived.reason === "serveUnreachable") {
        console.warn(`[command-ingest] opencode-serve unreachable for revival sessionId=${msg.sessionId}: ${revived.error}`);
        await options.sendTelegramReply?.(
          msg.chatId,
          `opencode-serve is unreachable. Try again in a moment.`,
        );
        storage.inbox.markDone(commandId);
        return;
      }

      if (revived.reason === "deliveryFailed") {
        console.warn(`[command-ingest] revival delivery failed sessionId=${msg.sessionId}: ${revived.error}`);
        await options.sendTelegramReply?.(
          msg.chatId,
          `Delivery failed: ${revived.error}`,
        );
        storage.inbox.markDone(commandId);
        return;
      }

      // sessionMissing: storage row vanished between the lookup at line 91
      // and now. Treat as a no-op — the worker will see no session and
      // future commands will fail with "session not found".
      console.warn(`[command-ingest] revive-and-deliver: session row missing sessionId=${msg.sessionId}`);
      storage.inbox.markDone(commandId);
      return;
    }

    // No opencodeClient — preserve the original "delete dead session" behavior.
    console.warn(`[command-ingest] removing dead session sessionId=${msg.sessionId} (no opencodeClient for revival)`);
    storage.sessions.delete(msg.sessionId);
    return;
  }
```

### Step 4: Run tests to verify they pass

```bash
npm run --workspace @pigeon/daemon test -- command-ingest
npm run --workspace @pigeon/daemon test -- revive-and-deliver
npm run --workspace @pigeon/daemon typecheck
```

Expected: all PASS.

### Step 5: Commit

```bash
git add packages/daemon/src/worker/command-ingest.ts packages/daemon/test/command-ingest.test.ts
git commit -m "feat(daemon): wire revive-on-reply fallback into command-ingest"
```

---

## Task 5: Wire `opencodeClient`, `sendTelegramReply`, and `spawn` from `index.ts`

**Why:** The fallback is plumbed into `command-ingest.ts` but won't activate until the daemon's main entrypoint passes `opencodeClient` and `sendTelegramReply` into the `ingestWorkerCommand` options. This is a one-line change in `packages/daemon/src/index.ts`.

**Files:**
- Modify: `packages/daemon/src/index.ts`

### Step 1: Update the `onCommand` callback

In `packages/daemon/src/index.ts`, find the `onCommand: async (msg) => { ... }` block (lines 63-70) and add the new options:

```ts
        onCommand: async (msg) => {
          await ingestWorkerCommand(storage, msg, {
            workerUrl: config.workerUrl,
            apiKey: config.workerApiKey,
            editNotification: (nid, text, rm, entities) => poller!.editNotification(nid, text, rm as { inline_keyboard?: unknown[] }, entities as unknown[] | undefined),
            machineId: config.machineId,
            // revive-on-reply: fallback delivery via opencode-serve when the
            // plugin endpoint is dead (e.g. after opencode-serve restart).
            ...(opencodeClient ? { opencodeClient } : {}),
            sendTelegramReply: sendTelegramMessage,
          });
        },
```

(Leave `spawn` unset in production — `reviveAndDeliver` defaults to `node:child_process.spawn`.)

### Step 2: Verify the daemon still builds and passes its existing tests

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon typecheck
```

Expected: all PASS. No new tests added in this task — Task 4's command-ingest tests already cover the wiring contract via dependency injection.

### Step 3: Commit

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): pass opencodeClient + sendTelegramReply to command-ingest"
```

---

## Task 6: Workspace-wide verification

**Why:** Catch any regressions in adjacent packages (worker, opencode-plugin) that depend on the daemon's contract.

### Step 1: Run all tests across all packages

```bash
npm run test
```

Expected: all PASS. If anything fails outside `packages/daemon`, investigate — the changes in this plan are daemon-only and additive (new options have defaults, new helpers, schema unchanged).

### Step 2: Run all typechecks

```bash
npm run typecheck
```

Expected: all PASS.

### Step 3: Manual smoke test plan (NOT executed in implementation, document only)

Add a new section to the design doc OR leave inline in this plan as the manual verification checklist that the user (or a follow-up session) will run on cloudbox after merge:

```
1. Identify a recent /launch session whose Telegram notification you can reply to.
   Note its session id (visible in the notification footer).

2. SSH to cloudbox and confirm opencode-serve is running:
     curl -s http://localhost:4096/global/health | jq
     systemctl status opencode-serve.service

3. Restart opencode-serve to kill all plugin processes:
     sudo systemctl restart opencode-serve.service
     sleep 2
     curl -s http://localhost:4096/global/health | jq

4. Confirm the session still exists in opencode-serve's on-disk DB:
     curl -s "http://localhost:4096/session/<SID>" | jq '{id, directory}'

5. In Telegram, reply to one of the session's old notifications with a plain
   text message like "what was the last thing you did?".

6. Expected: within ~10 seconds, the session responds in Telegram with a
   stop notification. The reply succeeded via the plugin-free fallback.

7. Reply again with another plain text message. Expected: also succeeds, this
   time via the standard plugin path (the plugin late-discovered the session
   on the previous reply and re-registered the backendEndpoint).

8. Verify the daemon log shows the revival happened:
     journalctl -u pigeon-daemon.service --since "5 minutes ago" \
       | grep -E 'revived|revive-and-deliver|backendEndpoint'

9. (Optional) Verify oc-auto-attach was triggered: a new tmux+nvim window
   should have appeared in the project's pane.

Negative test:
10. Pick a session id that doesn't exist:
      curl -s "http://localhost:4096/session/ses_nonexistent" | head
    (should return 404 from opencode-serve)

11. Manually inject that session into the daemon's storage with a fake dead
    endpoint:
      sudo -u dev sqlite3 ~/.local/share/pigeon-daemon/state.db \
        "INSERT INTO sessions (session_id, notify, state, backend_kind, backend_endpoint, backend_auth_token, created_at, updated_at, last_seen, expires_at) \
         VALUES ('ses_fakeghost', 1, 'running', 'opencode-plugin-direct', 'http://127.0.0.1:9999/dead', 'tok', strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000 + 86400000);"

12. (Skip — no Telegram routing to a fake session id without a worker
    messages-table entry. Just observation that the negative paths are
    covered by unit tests in Task 4.)
```

### Step 4: Commit (no code changes; only the manual checklist if you added it as a doc)

If the smoke-test checklist was added to the design doc:

```bash
git add docs/plans/2026-05-03-revive-on-reply-design.md
git commit -m "docs(revive-on-reply): add post-merge manual verification checklist"
```

If you left it inline in the plan, no commit needed.

---

## Task 7: Pull request

**Why:** Hand the work off for review and merge.

### Step 1: Push the branch

```bash
git push -u origin <branch-name>
```

### Step 2: Open a PR

Use the `superpowers:requesting-code-review` skill, or invoke `creating-pull-requests` if available. The PR description should include:

- Link to `docs/plans/2026-05-03-revive-on-reply-design.md`
- Summary of the user-visible behavior change ("Replies to sessions whose plugin process died now succeed instead of silently vanishing")
- Note the deliberately-degraded first-revival reply (no model override, no media, no question buttons on that one prompt) — link to design doc section
- Ask the reviewer to focus on `packages/daemon/src/worker/command-ingest.ts` (the failure-branch rewrite) and `packages/daemon/src/worker/revive-and-deliver.ts` (new helper)
- Confirm `npm run test` and `npm run typecheck` both pass

### Step 3: Post-merge cross-device deployment

Per `AGENTS.md`, after merging to main: pull and restart the daemon on each affected machine (cloudbox first, since that's where the bug is most acute). Use the `cross-device-deployment` skill.

---

## Done criteria

- [ ] `npm run test` passes (all packages, including new tests)
- [ ] `npm run typecheck` passes (all packages)
- [ ] `OpencodeClient.getSession` exists and handles 200/404/error/network-error correctly
- [ ] `SessionRepository.clearBackendEndpoint` exists and only clears the two intended columns
- [ ] `reviveAndDeliver` helper exists with full unit test coverage of all five `ReviveResult` shapes
- [ ] `command-ingest.ts`'s `isConnectionError` branch attempts revival when `opencodeClient` is provided, falls back to old delete-session behavior otherwise
- [ ] Design doc's "Open question: oc-auto-attach on cloudbox" section is either resolved (link to the fix) or still flagged as a known issue (the fix is independent of this work)
- [ ] PR opened and ready for review

## Notes for the implementer

- **Don't refactor adjacent code.** The fallback is intentionally a small, additive change to one branch. Resist the urge to clean up the `executeDirect` legacy adapter shim, the metadata-fallback question-reply path, or the wizard logic in `command-ingest.ts`. Those are separate concerns.
- **Don't add a "/attach" command.** That's noted as future work in the design doc and shouldn't be built here.
- **Don't change the worker.** All changes are daemon-side. The worker's D1 tables and webhook routes are untouched.
- **Don't change the schema.** `clearBackendEndpoint` uses the existing nullable columns.
- **The `oc-auto-attach` spawn in `reviveAndDeliver` is fire-and-forget by design.** Don't await it; don't check whether it succeeded. Cloudbox may not have it installed (see the open question in the design doc), and that's fine — ENOENT is silently swallowed.
- **The "Don't await `sendTelegramReply` failures" call is intentional.** The function is called with `await` but its own implementation in `index.ts` swallows fetch errors. A failed Telegram notification shouldn't prevent us from acking the command and moving on.

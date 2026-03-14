# D1 + HTTP Polling Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Durable Object + WebSocket relay with D1 + HTTP short polling, eliminating connection-lifecycle failures.

**Architecture:** Worker writes commands to D1 and serves a poll endpoint. Daemon short-polls every 5 seconds. All existing HTTP endpoints (sessions, notifications, media) are preserved with D1 as the backing store instead of DO SQLite.

**Tech Stack:** Cloudflare Workers, D1 (serverless SQLite), Vitest with `@cloudflare/vitest-pool-workers`, Node.js daemon with `better-sqlite3` (local), `tsx` for dev.

**Design doc:** `docs/plans/2026-03-14-d1-polling-architecture-design.md`

---

## Task 1: Create D1 Database and Schema Migration

**Files:**
- Create: `packages/worker/src/d1-schema.sql`
- Modify: `packages/worker/wrangler.toml`
- Modify: `packages/worker/src/types.ts`

**Step 1: Create D1 database via wrangler**

```bash
npx wrangler d1 create pigeon-router
```

Record the output `database_id` for the next step.

**Step 2: Update `wrangler.toml`**

Remove the Durable Object binding and migration. Add D1 binding. Keep R2 and cron.

```toml
name = "ccr-router"
main = "src/index.ts"
compatibility_date = "2024-01-01"
keep_vars = true

[[d1_databases]]
binding = "DB"
database_name = "pigeon-router"
database_id = "<ID_FROM_STEP_1>"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "pigeon-media"

[triggers]
crons = ["0 * * * *"]

[vars]
ALLOWED_CHAT_IDS = "8248645256"
```

**Step 3: Write schema migration SQL**

Create `packages/worker/src/d1-schema.sql`:

```sql
-- Commands: the central delivery table (replaces DO command_queue)
CREATE TABLE IF NOT EXISTS commands (
  command_id    TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  session_id    TEXT,
  command_type  TEXT NOT NULL DEFAULT 'execute',
  command       TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  directory     TEXT,
  media_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  leased_at     INTEGER,
  acked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_commands_poll
  ON commands (machine_id, status, created_at);

-- Sessions: session-to-machine registry (replaces DO sessions)
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Messages: Telegram reply routing (replaces DO messages)
CREATE TABLE IF NOT EXISTS messages (
  chat_id       TEXT NOT NULL,
  message_id    INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  token         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- Seen updates: Telegram deduplication (replaces DO seen_updates)
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id     INTEGER PRIMARY KEY,
  created_at    INTEGER NOT NULL
);

-- Machines: track daemon last-poll time for online detection
CREATE TABLE IF NOT EXISTS machines (
  machine_id    TEXT PRIMARY KEY,
  last_poll_at  INTEGER NOT NULL
);
```

**Step 4: Apply migration to remote D1**

```bash
npx wrangler d1 execute pigeon-router --remote --file=packages/worker/src/d1-schema.sql
```

**Step 5: Update `Env` interface in `types.ts`**

Replace the `ROUTER` DO binding with `DB`:

```typescript
declare global {
  interface Env {
    DB: D1Database;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    CCR_API_KEY: string;
    ALLOWED_CHAT_IDS: string;
    ALLOWED_USER_IDS?: string;
    MEDIA: R2Bucket;
  }
}

export {};
```

**Step 6: Commit**

```bash
git add packages/worker/src/d1-schema.sql packages/worker/wrangler.toml packages/worker/src/types.ts
git commit -m "feat(worker): add D1 database, schema, and binding for polling migration"
```

---

## Task 2: Write D1 Query Operations Module

Replace `command-queue.ts` (DO-specific, WebSocket-coupled) with a D1 operations module that uses plain SQL against `D1Database`.

**Files:**
- Create: `packages/worker/src/d1-ops.ts`

**Step 1: Write the failing tests**

Add a new `describe("d1-ops")` block in `packages/worker/test/worker.test.ts` (or a new test file if the pool-workers limitation permits -- try a new file first, fall back to the monolith if D1 binding isn't available in separate files).

Test cases:
- `queueCommand` inserts a row with status `pending`
- `pollNextCommand` returns null when no commands
- `pollNextCommand` returns oldest pending command and sets status to `leased`
- `pollNextCommand` reclaims commands with expired leases
- `pollNextCommand` only returns commands for the requested machine
- `ackCommand` sets status to `done` and `acked_at`
- `ackCommand` returns false for non-existent command
- `touchMachine` upserts `machines` row with current time
- `isMachineRecent` returns true if polled within threshold
- `cleanupCommands` deletes old acked and stuck commands
- `cleanupSeenUpdates` deletes old dedup rows

```typescript
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  queueCommand,
  pollNextCommand,
  ackCommand,
  touchMachine,
  isMachineRecent,
  cleanupCommands,
  cleanupSeenUpdates,
  generateCommandId,
} from "../src/d1-ops";

// Schema must be applied before tests -- do in beforeEach or global setup
```

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/worker test
```

Expected: FAIL (module not found)

**Step 3: Implement `d1-ops.ts`**

```typescript
const LEASE_TIMEOUT_MS = 60_000;       // 60s lease expiry
const MAX_QUEUE_PER_MACHINE = 100;

export function generateCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function queueCommand(
  db: D1Database,
  opts: {
    machineId: string;
    sessionId: string | null;
    command: string;
    chatId: string;
    commandType?: string;
    directory?: string | null;
    mediaJson?: string | null;
  },
): Promise<string | null> {
  // Check queue limit
  const countRow = await db
    .prepare("SELECT COUNT(*) as count FROM commands WHERE machine_id = ? AND status IN ('pending','leased')")
    .bind(opts.machineId)
    .first<{ count: number }>();
  if (countRow && countRow.count >= MAX_QUEUE_PER_MACHINE) return null;

  const commandId = generateCommandId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, directory, media_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      commandId,
      opts.machineId,
      opts.sessionId,
      opts.commandType ?? "execute",
      opts.command,
      opts.chatId,
      opts.directory ?? null,
      opts.mediaJson ?? null,
      now,
    )
    .run();
  return commandId;
}

export interface PollResult {
  commandId: string;
  sessionId: string | null;
  command: string;
  chatId: string;
  commandType: string;
  directory: string | null;
  mediaJson: string | null;
}

export async function pollNextCommand(
  db: D1Database,
  machineId: string,
  now: number = Date.now(),
): Promise<PollResult | null> {
  const leaseExpiry = now - LEASE_TIMEOUT_MS;

  // Find oldest pending, or oldest leased-but-expired
  const row = await db
    .prepare(
      `SELECT command_id, session_id, command, chat_id, command_type, directory, media_json
       FROM commands
       WHERE machine_id = ?
         AND (status = 'pending' OR (status = 'leased' AND leased_at < ?))
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(machineId, leaseExpiry)
    .first<{
      command_id: string;
      session_id: string | null;
      command: string;
      chat_id: string;
      command_type: string;
      directory: string | null;
      media_json: string | null;
    }>();

  if (!row) return null;

  // Atomically lease it
  await db
    .prepare("UPDATE commands SET status = 'leased', leased_at = ? WHERE command_id = ? AND status IN ('pending','leased')")
    .bind(now, row.command_id)
    .run();

  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    command: row.command,
    chatId: row.chat_id,
    commandType: row.command_type,
    directory: row.directory,
    mediaJson: row.media_json,
  };
}

export async function ackCommand(
  db: D1Database,
  commandId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE commands SET status = 'done', acked_at = ? WHERE command_id = ?")
    .bind(now, commandId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function touchMachine(
  db: D1Database,
  machineId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO machines (machine_id, last_poll_at) VALUES (?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET last_poll_at = excluded.last_poll_at`,
    )
    .bind(machineId, now)
    .run();
}

export async function isMachineRecent(
  db: D1Database,
  machineId: string,
  thresholdMs: number = 30_000,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
    .bind(machineId)
    .first<{ last_poll_at: number }>();
  if (!row) return false;
  return now - row.last_poll_at < thresholdMs;
}

export async function cleanupCommands(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ ackedDeleted: number; stuckDeleted: number }> {
  const ackedCutoff = now - 60 * 60 * 1000;       // 1 hour
  const stuckCutoff = now - 24 * 60 * 60 * 1000;  // 24 hours

  const acked = await db
    .prepare("DELETE FROM commands WHERE status = 'done' AND acked_at < ?")
    .bind(ackedCutoff)
    .run();
  const stuck = await db
    .prepare("DELETE FROM commands WHERE status != 'done' AND created_at < ?")
    .bind(stuckCutoff)
    .run();

  return {
    ackedDeleted: acked.meta?.changes ?? 0,
    stuckDeleted: stuck.meta?.changes ?? 0,
  };
}

export async function cleanupSeenUpdates(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - 24 * 60 * 60 * 1000; // 24 hours
  const result = await db
    .prepare("DELETE FROM seen_updates WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/worker test
```

**Step 5: Commit**

```bash
git add packages/worker/src/d1-ops.ts packages/worker/test/
git commit -m "feat(worker): add D1 query operations module with tests"
```

---

## Task 3: Worker Poll and Ack Endpoints

New HTTP endpoints that the daemon will call.

**Files:**
- Create: `packages/worker/src/poll.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Test cases:
- `GET /machines/:id/next` returns 401 without auth
- `GET /machines/:id/next` returns 204 when no commands pending
- `GET /machines/:id/next` returns command JSON and leases it
- `GET /machines/:id/next` does not return commands for other machines
- `GET /machines/:id/next` reclaims expired leases
- `GET /machines/:id/next` updates machine `last_poll_at`
- `POST /commands/:id/ack` returns 401 without auth
- `POST /commands/:id/ack` returns 200 and marks done
- `POST /commands/:id/ack` returns 404 for unknown command

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/worker test
```

**Step 3: Implement `poll.ts`**

```typescript
import { verifyApiKey, unauthorized } from "./auth";
import { pollNextCommand, ackCommand, touchMachine } from "./d1-ops";

export async function handlePollNext(
  db: D1Database,
  env: Env,
  request: Request,
  machineId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  await touchMachine(db, machineId);
  const command = await pollNextCommand(db, machineId);

  if (!command) {
    return new Response(null, { status: 204 });
  }

  const body: Record<string, unknown> = {
    commandId: command.commandId,
    commandType: command.commandType,
    chatId: command.chatId,
  };

  if (command.commandType === "launch") {
    body.directory = command.directory;
    body.prompt = command.command;
  } else if (command.commandType === "kill") {
    body.sessionId = command.sessionId;
  } else {
    // execute
    body.sessionId = command.sessionId;
    body.command = command.command;
    if (command.mediaJson) {
      body.media = JSON.parse(command.mediaJson);
    }
  }

  return Response.json(body);
}

export async function handleAckCommand(
  db: D1Database,
  env: Env,
  request: Request,
  commandId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const found = await ackCommand(db, commandId);
  if (!found) {
    return Response.json({ error: "Command not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/worker test
```

**Step 5: Commit**

```bash
git add packages/worker/src/poll.ts packages/worker/test/
git commit -m "feat(worker): add poll and ack HTTP endpoints for daemon polling"
```

---

## Task 4: Migrate Sessions Module to D1

Change `sessions.ts` to accept `D1Database` instead of `SqlStorage`.

**Files:**
- Modify: `packages/worker/src/sessions.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Update tests to use D1 binding**

Change test helpers from `runInDurableObject` + `sql.exec` to direct D1 calls via `env.DB`.

**Step 2: Run tests to verify they fail**

(They will fail because `sessions.ts` still expects `SqlStorage`.)

**Step 3: Migrate `sessions.ts`**

Replace every function signature:
- `sql: SqlStorage` → `db: D1Database`

Replace every query pattern:
- `sql.exec<T>("...").toArray()` → `await db.prepare("...").all<T>().then(r => r.results)`
- `sql.exec("...", ...args)` → `await db.prepare("...").bind(...args).run()`
- `sql.exec<T>("...", arg).toArray()[0]` → `await db.prepare("...").bind(arg).first<T>()`

Key: All D1 queries are `async` (unlike `SqlStorage` which is sync). All callers must `await`.

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/worker test
```

**Step 5: Commit**

```bash
git add packages/worker/src/sessions.ts packages/worker/test/
git commit -m "refactor(worker): migrate sessions module from DO SqlStorage to D1"
```

---

## Task 5: Migrate Notifications Module to D1

**Files:**
- Modify: `packages/worker/src/notifications.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1-5:** Same pattern as Task 4. Replace `sql: SqlStorage` with `db: D1Database` in `handleSendNotification`, `lookupMessage`, `lookupMessageByToken`. Convert all sync `sql.exec` calls to async `db.prepare().bind().run/first/all` calls.

Key change: `handleSendNotification` reads sessions and writes messages. Both now go through D1.

**Commit message:** `refactor(worker): migrate notifications module from DO SqlStorage to D1`

---

## Task 6: Migrate Webhook Module to D1

This is the largest migration. The webhook handler currently receives `sql: SqlStorage` and two closures (`deliverNow`, `isMachineConnected`) from the DO.

**Files:**
- Modify: `packages/worker/src/webhook.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Change the function signature**

Before:
```typescript
export async function handleTelegramWebhook(
  sql: SqlStorage, env: Env, request: Request,
  deliverNow?: (machineId: string) => void,
  isMachineConnected?: (machineId: string) => boolean,
): Promise<Response>
```

After:
```typescript
export async function handleTelegramWebhook(
  db: D1Database, env: Env, request: Request,
): Promise<Response>
```

**Step 2: Replace `deliverNow` and `isMachineConnected`**

- Remove all `deliverNow(machineId)` calls. Commands go into D1 and the daemon picks them up on next poll. No immediate flush needed.
- Replace `isMachineConnected(machineId)` with `await isMachineRecent(db, machineId)` from `d1-ops.ts`. This checks if the daemon polled within the last 30 seconds. The error message changes from "not connected" to "not recently seen" or similar.

**Step 3: Replace `queueCommand` internals**

The local `queueCommand()` function currently does `INSERT INTO command_queue ...` via `sql.exec`. Replace with a call to `d1-ops.queueCommand()`.

**Step 4: Replace dedup and session lookups**

- `deduplicateUpdate(sql, updateId)` → async D1 version
- `lookupMessage(sql, ...)` → already migrated in Task 5
- Session lookups → already migrated in Task 4

**Step 5: Update tests**

Remove all `deliverNow`/`isMachineConnected` test setup. Tests now verify commands appear in D1 instead of checking WebSocket message sends.

**Step 6: Run tests**

```bash
npm run --workspace @pigeon/worker test
```

**Step 7: Commit**

```bash
git commit -m "refactor(worker): migrate webhook handler from DO SqlStorage to D1, remove WS delivery"
```

---

## Task 7: Rewrite Worker Entry Point (Remove DO)

**Files:**
- Modify: `packages/worker/src/index.ts`
- Delete: `packages/worker/src/router-do.ts`
- Delete: `packages/worker/src/command-queue.ts`

**Step 1: Rewrite `index.ts`**

The entry point must now handle all routing directly (previously delegated to the DO's `fetch()`). No DO export.

```typescript
import { handleSessionRequest } from "./sessions";
import { handleSendNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";
import { handleMediaUpload, handleMediaGet, cleanupExpiredMedia } from "./media";
import { handlePollNext, handleAckCommand } from "./poll";
import { cleanupCommands, cleanupSeenUpdates } from "./d1-ops";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    // Health
    if (path === "/health") {
      return new Response("ok");
    }

    // Poll endpoints (new)
    const pollMatch = path.match(/^\/machines\/([^/]+)\/next$/);
    if (pollMatch && request.method === "GET") {
      return handlePollNext(db, env, request, pollMatch[1]!);
    }

    const ackMatch = path.match(/^\/commands\/([^/]+)\/ack$/);
    if (ackMatch && request.method === "POST") {
      return handleAckCommand(db, env, request, ackMatch[1]!);
    }

    // Sessions
    if (path === "/sessions" && request.method === "GET") {
      return handleSessionRequest(db, env, request, "list");
    }
    if (path === "/sessions/register" && request.method === "POST") {
      return handleSessionRequest(db, env, request, "register");
    }
    if (path === "/sessions/unregister" && request.method === "POST") {
      return handleSessionRequest(db, env, request, "unregister");
    }

    // Media
    if (path === "/media/upload" && request.method === "POST") {
      return handleMediaUpload(env, request);
    }
    if (path.startsWith("/media/") && request.method === "GET") {
      const key = path.slice("/media/".length);
      return handleMediaGet(env, request, key);
    }

    // Notifications
    if (path === "/notifications/send" && request.method === "POST") {
      return handleSendNotification(db, env, request);
    }

    // Telegram webhook
    if (path.startsWith("/webhook/telegram") && request.method === "POST") {
      return handleTelegramWebhook(db, env, request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupExpiredMedia(env);
    await cleanupCommands(env.DB);
    await cleanupSeenUpdates(env.DB);
  },
} satisfies ExportedHandler<Env>;
```

**Step 2: Delete `router-do.ts` and `command-queue.ts`**

```bash
rm packages/worker/src/router-do.ts packages/worker/src/command-queue.ts
```

**Step 3: Update tests**

Remove all `runInDurableObject`, `runDurableObjectAlarm` helpers. Tests now call `SELF.fetch(...)` which hits `index.ts` directly. D1 state is inspected via `env.DB.prepare(...)`.

Remove the `websocket machine agent`, `websocket hibernation auto-response`, and `command queue lifecycle` describe blocks entirely (these test DO/WS behavior that no longer exists).

**Step 4: Run tests and typecheck**

```bash
npm run --workspace @pigeon/worker test
npm run --workspace @pigeon/worker typecheck
```

**Step 5: Commit**

```bash
git commit -m "feat(worker): replace DO routing with direct D1-backed handler, delete DO and command queue"
```

---

## Task 8: Update Vitest Config for D1

**Files:**
- Modify: `packages/worker/vitest.config.ts`

The test config currently depends on the DO via `wrangler.toml`. With the DO removed and D1 added, the config needs to ensure D1 is available in tests.

**Step 1: Update config**

The `@cloudflare/vitest-pool-workers` pool reads D1 config from `wrangler.toml` automatically when `wrangler.configPath` is set. Since we already updated `wrangler.toml` in Task 1, the D1 binding should be available.

However, tests need the schema applied. Add a global setup that runs the schema SQL:

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            CCR_API_KEY: "test-api-key",
            TELEGRAM_BOT_TOKEN: "test-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            ALLOWED_CHAT_IDS: "8248645256",
          },
        },
      },
    },
  },
});
```

If D1 schema isn't auto-applied, add a `beforeAll` in the test file that runs the schema SQL via `env.DB.exec(...)`.

**Step 2: Verify all tests pass**

```bash
npm run --workspace @pigeon/worker test
npm run --workspace @pigeon/worker typecheck
```

**Step 3: Commit**

```bash
git commit -m "chore(worker): update vitest config for D1 test binding"
```

---

## Task 9: Daemon -- Create HTTP Poller

Replace the WebSocket lifecycle in `MachineAgent` with an HTTP polling loop.

**Files:**
- Create: `packages/daemon/src/worker/poller.ts`
- Create: `packages/daemon/test/poller.test.ts`

**Step 1: Write failing tests**

Test cases:
- `poll()` calls `GET /machines/:id/next` with Bearer auth
- `poll()` returns null on 204
- `poll()` returns parsed command on 200
- `ack()` calls `POST /commands/:id/ack` with Bearer auth
- `sendResult()` calls `POST /commands/:id/result` with Bearer auth
- `start()` begins polling at configured interval
- `stop()` clears the interval
- `start()` dispatches execute commands to `onCommand` callback
- `start()` dispatches launch commands to `onLaunch` callback
- `start()` dispatches kill commands to `onKill` callback
- `start()` acks after successful command dispatch

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/daemon test
```

**Step 3: Implement `poller.ts`**

```typescript
const POLL_INTERVAL_MS = 5_000;

export interface PollerConfig {
  workerUrl: string;
  apiKey: string;
  machineId: string;
  pollIntervalMs?: number;
}

export interface PollerCallbacks {
  onCommand: (msg: WorkerCommandMessage) => Promise<void>;
  onLaunch: (msg: WorkerLaunchMessage) => Promise<void>;
  onKill: (msg: WorkerKillMessage) => Promise<void>;
}

export interface WorkerCommandMessage {
  commandId: string;
  commandType: "execute";
  sessionId: string;
  command: string;
  chatId: string;
  media?: { key: string; mime: string; filename: string; size: number };
}

export interface WorkerLaunchMessage {
  commandId: string;
  commandType: "launch";
  directory: string;
  prompt: string;
  chatId: string;
}

export interface WorkerKillMessage {
  commandId: string;
  commandType: "kill";
  sessionId: string;
  chatId: string;
}

export type WorkerMessage = WorkerCommandMessage | WorkerLaunchMessage | WorkerKillMessage;

export interface PollerDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly config: Required<Pick<PollerConfig, "workerUrl" | "apiKey" | "machineId" | "pollIntervalMs">>;
  private readonly callbacks: PollerCallbacks;
  private readonly fetchFn: typeof fetch;

  constructor(config: PollerConfig, callbacks: PollerCallbacks, deps: PollerDeps = {}) {
    this.config = {
      ...config,
      pollIntervalMs: config.pollIntervalMs ?? POLL_INTERVAL_MS,
    };
    this.callbacks = callbacks;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    // Also poll immediately on start
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // Guard against overlapping polls
    if (this.polling) return;
    this.polling = true;
    try {
      const msg = await this.poll();
      if (!msg) return;
      await this.dispatch(msg);
      await this.ack(msg.commandId);
    } catch (err) {
      console.error("[poller] tick error:", err);
      // Don't ack on error -- lease expires and command retries
    } finally {
      this.polling = false;
    }
  }

  async poll(): Promise<WorkerMessage | null> {
    const url = `${this.config.workerUrl}/machines/${this.config.machineId}/next`;
    const resp = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (resp.status === 204) return null;
    if (!resp.ok) {
      console.error(`[poller] poll failed: ${resp.status} ${resp.statusText}`);
      return null;
    }
    return (await resp.json()) as WorkerMessage;
  }

  async ack(commandId: string): Promise<void> {
    const url = `${this.config.workerUrl}/commands/${commandId}/ack`;
    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!resp.ok) {
      console.error(`[poller] ack failed for ${commandId}: ${resp.status}`);
    }
  }

  private async dispatch(msg: WorkerMessage): Promise<void> {
    switch (msg.commandType) {
      case "execute":
        return this.callbacks.onCommand(msg as WorkerCommandMessage);
      case "launch":
        return this.callbacks.onLaunch(msg as WorkerLaunchMessage);
      case "kill":
        return this.callbacks.onKill(msg as WorkerKillMessage);
    }
  }

  // --- HTTP methods preserved from MachineAgent (already HTTP, unchanged) ---

  async registerSession(sessionId: string, label?: string): Promise<void> {
    await this.fetchFn(`${this.config.workerUrl}/sessions/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        machineId: this.config.machineId,
        label,
      }),
    });
  }

  async unregisterSession(sessionId: string): Promise<void> {
    await this.fetchFn(`${this.config.workerUrl}/sessions/unregister`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
    });
  }

  async sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup?: unknown,
    media?: Array<{ key: string; mime: string; filename: string }>,
  ): Promise<{ ok: boolean }> {
    const resp = await this.fetchFn(`${this.config.workerUrl}/notifications/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId, chatId, text, replyMarkup, media }),
    });
    return (await resp.json()) as { ok: boolean };
  }

  async uploadMedia(
    key: string,
    data: Uint8Array | ArrayBuffer,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; key: string }> {
    const form = new FormData();
    form.append("key", key);
    form.append("mime", mime);
    form.append("filename", filename);
    form.append("file", new Blob([data], { type: mime }), filename);
    const resp = await this.fetchFn(`${this.config.workerUrl}/media/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
    });
    return (await resp.json()) as { ok: boolean; key: string };
  }

  getConfiguredChatId(): string | undefined {
    return undefined; // Chat ID comes from command payloads now, not config
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/daemon test
```

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/poller.ts packages/daemon/test/poller.test.ts
git commit -m "feat(daemon): add HTTP poller to replace WebSocket connection to worker"
```

---

## Task 10: Daemon -- Wire Poller into Startup

Replace `MachineAgent` with `Poller` in the daemon entry point.

**Files:**
- Modify: `packages/daemon/src/index.ts`
- Modify: `packages/daemon/src/worker/command-ingest.ts`

**Step 1: Update `index.ts`**

Replace:
```typescript
const machineAgent = new MachineAgent(config, deps);
machineAgent.connect();
```

With:
```typescript
const poller = new Poller(
  { workerUrl: config.workerUrl, apiKey: config.workerApiKey, machineId: config.machineId },
  {
    onCommand: (msg) => ingestWorkerCommand(msg, storage, poller, config),
    onLaunch: (msg) => ingestLaunchCommand(msg, poller, opencodeClient, config),
    onKill: (msg) => ingestKillCommand(msg, poller, opencodeClient, config),
  },
);
poller.start();
```

Update the `onSessionStart`/`onSessionDelete` callbacks to use `poller.registerSession` and `poller.unregisterSession`.

**Step 2: Update `command-ingest.ts`**

The `ingestWorkerCommand` function currently takes a `callbacks` object with `send(payload)`. Since the poller acks after dispatch, the ingest function no longer needs to send acks itself. Remove the `send` callback. The function now just delivers the command to the plugin and throws on failure (poller catches the error and skips the ack, so the command lease expires and retries).

Remove the `commandResult` sending -- the daemon no longer sends results back over WS. If a result needs to go back (e.g., "session not found"), it can call a Worker endpoint directly or rely on the ack/no-ack mechanism.

**Step 3: Simplify notification service**

In `notification-service.ts`, remove `FallbackNotifier`. The `WorkerNotificationService` becomes the only notifier (it already does HTTP POST to worker). Remove `TelegramNotificationService` or keep it only as a standalone fallback for when worker URL is not configured.

**Step 4: Run all daemon tests**

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon typecheck
```

Fix any test failures from the refactor.

**Step 5: Commit**

```bash
git commit -m "feat(daemon): wire HTTP poller into startup, replace WebSocket lifecycle"
```

---

## Task 11: Daemon -- Clean Up Dead Code

**Files:**
- Delete or gut: `packages/daemon/src/worker/machine-agent.ts`
- Modify: `packages/daemon/test/machine-agent.test.ts`

**Step 1: Delete `machine-agent.ts`**

The entire file is replaced by `poller.ts`. Delete it.

**Step 2: Delete or rewrite `machine-agent.test.ts`**

The existing tests cover WebSocket behavior, boot ID tracking, pending result buffering -- all removed. Delete this file. The new poller tests in `poller.test.ts` cover the replacement behavior.

**Step 3: Remove any remaining imports of `MachineAgent`**

Search for `machine-agent` imports across the daemon package and remove them.

**Step 4: Run tests and typecheck**

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon typecheck
```

**Step 5: Commit**

```bash
git commit -m "refactor(daemon): remove MachineAgent WebSocket client and related tests"
```

---

## Task 12: Worker -- Add Command Result Endpoint (optional)

The daemon currently sends `commandResult` messages back to the worker over WebSocket (e.g., "Session not found", "Command failed"). With polling, the daemon needs an HTTP endpoint for this.

**Files:**
- Modify: `packages/worker/src/poll.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Evaluate necessity**

The `commandResult` was used for two things:
1. Error reporting ("Session not found") -- the worker sends this back to Telegram
2. Success confirmation -- currently unused beyond ack

If the daemon can't deliver a command, it simply doesn't ack. The lease expires and the command retries. If the command fails permanently (e.g., session doesn't exist), the daemon could call a new endpoint:

```
POST /commands/:id/result
{ success: false, error: "Session not found", chatId: "..." }
```

The worker then sends the error to Telegram and marks the command as done (so it doesn't retry).

**Step 2: Implement if needed**

Add `handleCommandResult` to `poll.ts`. It marks the command done and optionally sends a Telegram message with the error.

**Step 3: Commit**

```bash
git commit -m "feat(worker): add command result endpoint for daemon error reporting"
```

---

## Task 13: End-to-End Verification

**Step 1: Run full test suites**

```bash
npm run test          # all packages
npm run typecheck     # all packages
```

**Step 2: Deploy worker**

```bash
npm run --workspace @pigeon/worker deploy
```

**Step 3: Verify health**

```bash
curl https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`

**Step 4: Verify poll endpoint**

```bash
curl -H "Authorization: Bearer $CCR_API_KEY" \
  https://ccr-router.jonathan-mohrbacher.workers.dev/machines/test/next
```

Expected: `204 No Content` (no pending commands)

**Step 5: Restart daemon**

Follow [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md) for each machine.

**Step 6: Send a test message via Telegram**

Send a command to the bot. Verify:
- Command appears in D1 (visible via `wrangler d1 execute pigeon-router --remote --command "SELECT * FROM commands"`)
- Daemon picks it up within 5 seconds
- Command executes in Claude session
- Notification flows back to Telegram
- Reply routing works (reply to the notification reaches the correct session)

**Step 7: Commit any fixes**

```bash
git commit -m "fix: address issues found during end-to-end verification"
```

---

## Task 14: Update Skills and Documentation

**Files:**
- Modify: `.opencode/skills/worker-architecture/SKILL.md` -- update to reflect D1, remove DO references, document new endpoints
- Modify: `.opencode/skills/daemon-architecture/SKILL.md` -- update to reflect poller, remove WS references
- Modify: `AGENTS.md` -- update message flow diagram, remove "Planned" note (now implemented)

**Step 1: Update worker-architecture skill**

Replace DO-centric documentation with D1 architecture. Update endpoint contracts (add poll/ack, remove `/ws`). Update table descriptions. Remove command-queue.ts references.

**Step 2: Update daemon-architecture skill**

Replace WebSocket/MachineAgent documentation with Poller documentation. Remove heartbeat, reconnect, boot ID references. Update integration flow diagrams.

**Step 3: Update AGENTS.md**

Change the "Planned" section to reflect completed migration. Update the message flow:

```
Messages flow: Telegram → Worker (Cloudflare) → D1 ← Daemon (polls) → Claude serve.
```

**Step 4: Commit**

```bash
git commit -m "docs: update skills and AGENTS.md for D1 polling architecture"
```

---

## Summary

| Task | Component | What | Est. Size |
|------|-----------|------|-----------|
| 1 | Worker | D1 database, schema, wrangler config | Small |
| 2 | Worker | D1 query operations module + tests | Medium |
| 3 | Worker | Poll and ack HTTP endpoints + tests | Medium |
| 4 | Worker | Migrate sessions.ts to D1 | Small |
| 5 | Worker | Migrate notifications.ts to D1 | Small |
| 6 | Worker | Migrate webhook.ts to D1, remove WS callbacks | Large |
| 7 | Worker | Rewrite index.ts, delete DO + command-queue | Medium |
| 8 | Worker | Update vitest config for D1 | Small |
| 9 | Daemon | Create HTTP poller + tests | Medium |
| 10 | Daemon | Wire poller into startup, update ingest + notifications | Medium |
| 11 | Daemon | Delete MachineAgent and dead code | Small |
| 12 | Worker | Command result endpoint (optional) | Small |
| 13 | Both | End-to-end verification | Medium |
| 14 | Docs | Update skills and AGENTS.md | Small |

**Dependencies:** Tasks 1-8 are sequential (worker-side). Task 9 can run in parallel with worker tasks. Tasks 10-11 depend on Task 9. Task 12 is optional. Task 13 depends on all prior tasks. Task 14 is last.

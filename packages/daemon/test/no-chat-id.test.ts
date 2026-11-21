/**
 * Telegram is gone (pigeon-4ogz.13): a daemon needs no TELEGRAM_CHAT_ID (or any chat id) to
 * deliver. Before this, the outbox, the alert notifier, the drainer and named topics were built
 * only when TELEGRAM_CHAT_ID was set, so a host without it silently posted nothing.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createAlertNotifier } from "../src/alert-notifier";
import { DirectSlackAlarm } from "../src/direct-slack-alarm";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { OutboxSender } from "../src/worker/outbox-sender";
import { Poller, type PollerCallbacks } from "../src/worker/poller";
import { WorkerMessageClient } from "../src/worker/worker-message-client";

const WORKER = "https://worker.example";
const HOOK = "https://hooks.slack.com/services/T0/B0/xyz";

let storage: StorageDb;
beforeEach(() => {
  storage = openStorageDb(":memory:");
});
afterEach(() => {
  storage.db.close();
});

/** Every JSON body the daemon sent, with its path. Answers like the PR A worker does. */
function fakeWorker() {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path, body });
    if (path === "/topics/named") return Response.json({ chatId: "slack:T1", messageThreadId: 2 ** 40 + 5, created: true });
    if (path === "/topics/named/bind") {
      return Response.json({ chatId: "slack:T1", messageThreadId: 2 ** 40 + 6, created: false, bound: true });
    }
    if (path === "/messages/send") return Response.json({ ok: true, chatId: "slack:T1", messageId: 2 ** 40 + 1 });
    return Response.json({ ok: true, messageId: 2 ** 40 + 2 });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function anyChatId(sent: Array<{ body: Record<string, unknown> }>): unknown[] {
  return sent.flatMap((s) => ("chatId" in s.body ? [s.body.chatId] : []));
}

describe("a daemon with no TELEGRAM_* configuration and no chat id", () => {
  it("delivers a stop through the outbox, and the request carries no chat id", async () => {
    const worker = fakeWorker();
    const poller = new Poller({ workerUrl: WORKER, apiKey: "k", machineId: "devbox" }, {} as PollerCallbacks, {
      fetchFn: worker.fetchFn,
    });
    const app = createApp(storage, { nowFn: () => 1_000, machineId: "devbox" });
    await post(app, "/session-start", { session_id: "sess-1", notify: true, label: "l" });
    expect((await post(app, "/stop", { session_id: "sess-1", event: "Stop", message: "done", notification_id: "s:sess-1:m.0" })).status).toBe(202);

    // index.ts builds the sender exactly like this, with no chat id.
    const sender = new OutboxSender({
      storage,
      sendNotification: (input) => poller.sendNotification(input),
      nowFn: () => 5_000,
    });
    await sender.processOnce();

    expect(storage.outbox.getByNotificationId("s:sess-1:m.0")!.state).toBe("sent");
    const sends = worker.sent.filter((s) => s.path === "/notifications/send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.sessionId).toBe("sess-1");
    expect(anyChatId(sends)).toEqual([]);
  });

  it("delivers an alert through the worker with no chat id, falling back to the Slack webhook", async () => {
    const worker = fakeWorker();
    const hook: string[] = [];
    const direct = new DirectSlackAlarm(HOOK, {
      fetchFn: (async (url: string, init?: RequestInit) => {
        hook.push(`${url} ${String(init?.body)}`);
        return new Response("ok");
      }) as unknown as typeof fetch,
    });
    const notifier = createAlertNotifier({
      worker: new WorkerMessageClient({ workerUrl: WORKER, apiKey: "k", fetchFn: worker.fetchFn }),
      direct,
    })!;
    const app = createApp(storage, { nowFn: () => 1_000, notifier });

    expect((await post(app, "/alert", { text: "hello", severity: "info" })).status).toBe(204);
    expect(worker.sent).toEqual([{ path: "/messages/send", body: { text: "hello" } }]);

    // Worker down: the direct leg still lands in #alerts.
    const down = createAlertNotifier({
      worker: new WorkerMessageClient({ workerUrl: WORKER, apiKey: "k", fetchFn: (async () => new Response("", { status: 503 })) as unknown as typeof fetch }),
      direct,
    })!;
    await down.sendPlainAlert!("worker is down", "error");
    expect(hook).toHaveLength(1);
    expect(hook[0]).toContain(HOOK);
    expect(hook[0]).toContain("worker is down");
  });

  it("resolves and binds a named topic with no chat id, and uses the chat the worker returns", async () => {
    const worker = fakeWorker();
    const poller = new Poller({ workerUrl: WORKER, apiKey: "k", machineId: "devbox" }, {} as PollerCallbacks, {
      fetchFn: worker.fetchFn,
    });
    expect(await poller.resolveNamedTopic({ key: "digest", name: "Digest" })).toEqual({
      messageThreadId: 2 ** 40 + 5,
      created: true,
      chatId: "slack:T1",
    });
    expect(await poller.bindNamedTopic({ sessionId: "ses_1", key: "digest", name: "Digest" })).toEqual({
      messageThreadId: 2 ** 40 + 6,
      chatId: "slack:T1",
    });
    expect(worker.sent.map((s) => s.path)).toEqual(["/topics/named", "/topics/named/bind"]);
    expect(anyChatId(worker.sent)).toEqual([]);

    // And a named-topic alert goes out into the returned Slack address, nothing else.
    const sendWorker = fakeWorker();
    const app = createApp(storage, {
      nowFn: () => 1_000,
      resolveNamedTopic: (req, signal) => poller.resolveNamedTopic(req, signal),
      notifier: createAlertNotifier({
        worker: new WorkerMessageClient({ workerUrl: WORKER, apiKey: "k", fetchFn: sendWorker.fetchFn }),
      })!,
    });
    expect((await post(app, "/alert", { text: "x", topic: { key: "digest", name: "Digest" } })).status).toBe(204);
    expect(sendWorker.sent[0]!.body).toMatchObject({ chatId: "slack:T1", messageThreadId: 2 ** 40 + 5 });
  });
});

describe("startup (src/index.ts) ignores leftover TELEGRAM_* variables", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pigeon-startup-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  /** Runs the real entry point until `ready` matches its output, then stops it. */
  async function boot(env: Record<string, string>, ready: RegExp): Promise<string> {
    const port = await freePort();
    const child = spawn(join(__dirname, "../../../node_modules/.bin/tsx"), ["src/index.ts"], {
      cwd: join(__dirname, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        PIGEON_DAEMON_PORT: String(port),
        PIGEON_DAEMON_DB_PATH: join(dir, "d.db"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    try {
      const deadline = Date.now() + 45_000;
      while (!ready.test(out) && Date.now() < deadline && child.exitCode === null) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("logs the Slack-only line, names the ignored variables, and builds the alert path without TELEGRAM_CHAT_ID", async () => {
    const out = await boot(
      {
        TELEGRAM_BOT_TOKEN: "123:secret-token",
        TELEGRAM_CHAT_ID: "-100123",
        // A worker that is not there: nothing is sent, but the worker leg is still configured.
        CCR_WORKER_URL: "http://127.0.0.1:9",
        CCR_API_KEY: "pgk_unused",
        CCR_MACHINE_ID: "devbox",
        PIGEON_SLACK_ALARM_WEBHOOK_URL: HOOK,
      },
      /alert drainer started/,
    );
    expect(out).toContain("[chat] Slack only (Telegram removed, pigeon-4ogz.13)");
    expect(out).toContain("[chat] ignoring TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (Telegram removed)");
    expect(out).not.toContain("secret-token");
    expect(out).toContain("alert delivery: worker+direct-fallback");
    expect(out).toContain("[alert] direct path: slack=set");
    expect(out).toContain("alert drainer started");
  }, 60_000);

  it("with no TELEGRAM_* variables at all, builds the same path and logs no 'ignoring' line", async () => {
    const out = await boot(
      {
        CCR_WORKER_URL: "http://127.0.0.1:9",
        CCR_API_KEY: "pgk_unused",
        CCR_MACHINE_ID: "devbox",
        PIGEON_SLACK_ALARM_WEBHOOK_URL: HOOK,
      },
      /alert drainer started/,
    );
    expect(out).toContain("[chat] Slack only (Telegram removed, pigeon-4ogz.13)");
    expect(out).not.toContain("[chat] ignoring");
    expect(out).toContain("alert delivery: worker+direct-fallback");
  }, 60_000);

  it("a launch receiver is capable with just the Slack webhook (no chat, no chat id)", async () => {
    const out = await boot(
      {
        CCR_WORKER_URL: "http://127.0.0.1:9",
        CCR_API_KEY: "pgk_unused",
        CCR_MACHINE_ID: "devbox",
        PIGEON_SLACK_ALARM_WEBHOOK_URL: HOOK,
        OPENCODE_URL: "http://127.0.0.1:9",
        PIGEON_REMOTE_LAUNCH_FROM: "cloudbox",
      },
      /receiving is (not )?capable/,
    );
    expect(out).toContain("[remote-launch] receiving is capable");
    expect(out).not.toContain("not capable");
  }, 60_000);
});

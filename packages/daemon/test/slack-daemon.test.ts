/** Daemon Slack support (pigeon-4ogz.5; design docs/plans/2026-11-20-slack-transport-design.md §6-§7). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { Poller, type PollerCallbacks } from "../src/worker/poller";
import { DirectSlackAlarm, parseSlackWebhookUrl, renderSlackAlarmText, SlackWebhookError } from "../src/direct-slack-alarm";
import { launchCapability } from "../src/launch-capability";
import { buildRichMarkdown } from "../src/rich-markdown";
import type { ChatMessage } from "../src/chat-message";

const msg = (text: string, entities: ChatMessage["entities"] = []): ChatMessage => ({ text, entities });
import { classifyDeliveryFailure, getErrorClass } from "../src/worker/delivery-policy";
import { classifyWorkerHealthSample } from "../src/worker/worker-health";
import { WorkerMessageClient } from "../src/worker/worker-message-client";
import { createAlertNotifier } from "../src/alert-notifier";
import { OutboxSender } from "../src/worker/outbox-sender";
import { buildAlertKeyboard } from "../src/alert-links";
import { loadConfig } from "../src/config";
import { ChatSendError } from "../src/notification-service";

const HOOK = "https://hooks.slack.com/services/T0/B0/xyz";
/** Slack conversation handles start here (worker `SLACK_HANDLE_MIN`, 2^40). */
const SLACK_HANDLE_MIN = 2 ** 40;

let storages: StorageDb[] = [];
afterEach(() => {
  for (const s of storages) s.db.close();
  storages = [];
});
function mem(): StorageDb {
  const s = openStorageDb(":memory:");
  storages.push(s);
  return s;
}

describe("whoami.transport", () => {
  const poller = (body: unknown) =>
    new Poller({ workerUrl: "https://w", apiKey: "k", machineId: "devbox" }, {} as PollerCallbacks, {
      fetchFn: (async () => Response.json(body)) as unknown as typeof fetch,
    });

  it("is informational: read when the worker says slack, and its absence never means another chat", async () => {
    expect(await poller({ credential: "machine", machine_id: "devbox", transport: "slack" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox", transport: "slack" });
    expect(await poller({ credential: "machine", machine_id: "devbox" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox" });
    expect(await poller({ credential: "machine", machine_id: "devbox", transport: "carrier-pigeon" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox" });
  });

  it("the daemon keeps no transport state: nothing is persisted from whoami", () => {
    const s = mem();
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("daemon_kv");
  });
});

describe("config", () => {
  it("treats an empty or non-Slack webhook as unset", () => {
    expect(loadConfig({ PIGEON_SLACK_ALARM_WEBHOOK_URL: "" }).slackAlarmWebhookUrl).toBeUndefined();
    expect(loadConfig({ PIGEON_SLACK_ALARM_WEBHOOK_URL: "  " }).slackAlarmWebhookUrl).toBeUndefined();
    expect(parseSlackWebhookUrl("https://evil.example/hook")).toBeUndefined();
    expect(parseSlackWebhookUrl("http://hooks.slack.com/x")).toBeUndefined();
    expect(loadConfig({ PIGEON_SLACK_ALARM_WEBHOOK_URL: ` ${HOOK} ` }).slackAlarmWebhookUrl).toBe(HOOK);
  });

  it("notify owner is off unless exactly 1", () => {
    expect(loadConfig({}).slackNotifyOwner).toBeUndefined();
    expect(loadConfig({ PIGEON_SLACK_NOTIFY_OWNER: "true" }).slackNotifyOwner).toBeUndefined();
    expect(loadConfig({ PIGEON_SLACK_NOTIFY_OWNER: "1" }).slackNotifyOwner).toBe(true);
    expect(loadConfig({ PIGEON_SLACK_OWNER_USER_ID: "U123ABC" }).slackOwnerUserId).toBe("U123ABC");
    expect(loadConfig({ PIGEON_SLACK_OWNER_USER_ID: "bob" }).slackOwnerUserId).toBeUndefined();
  });
});

describe("DirectSlackAlarm", () => {
  function hook(respond: () => Response | Promise<Response> = () => new Response("ok")) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return respond();
    });
    return { fetchFn: fetchFn as unknown as typeof fetch, calls };
  }

  it("posts escaped text, no mention by default, links as lines", async () => {
    const { fetchFn, calls } = hook();
    await new DirectSlackAlarm(HOOK, { ownerUserId: "U1OWNER", fetchFn }).sendPlainAlert(
      "worker <down> & @channel",
      "error",
      { replyMarkup: { inline_keyboard: [[{ text: "sess|1", url: "https://acme.slack.com/archives/C1" }]] }, messageThreadId: 5 },
    );
    expect(calls[0]!.url).toBe(HOOK);
    const text = calls[0]!.body.text as string;
    expect(text).toBe("❌ worker &lt;down&gt; &amp; @\u200dchannel\n<https://acme.slack.com/archives/C1|sess 1>");
    expect(text).not.toContain("<@");
  });

  it("mentions the owner only with PIGEON_SLACK_NOTIFY_OWNER=1, an id, and an error alert", async () => {
    expect(renderSlackAlarmText("x", "info", undefined, "U1")).toBe("<@U1> x");
    const { fetchFn, calls } = hook();
    await new DirectSlackAlarm(HOOK, { notifyOwner: true, fetchFn }).sendPlainAlert("x", "error");
    await new DirectSlackAlarm(HOOK, { notifyOwner: true, ownerUserId: "U1", fetchFn }).sendPlainAlert("y", "warning");
    await new DirectSlackAlarm(HOOK, { notifyOwner: true, ownerUserId: "U1", fetchFn }).sendPlainAlert("z", "error");
    await new DirectSlackAlarm(HOOK, { ownerUserId: "U1", fetchFn }).sendPlainAlert("w", "error");
    expect(calls.map((c) => c.body.text)).toEqual(["❌ x", "⚠️ y", "<@U1> ❌ z", "❌ w"]);
  });

  it("throws SlackWebhookError on a non-2xx, never ChatSendError", async () => {
    const { fetchFn } = hook(() => new Response("invalid_payload", { status: 400 }));
    const err = await new DirectSlackAlarm(HOOK, { fetchFn }).sendPlainAlert("x", "info").catch((e) => e);
    expect(err).toBeInstanceOf(SlackWebhookError);
    expect(err).not.toBeInstanceOf(ChatSendError);
    expect(String(err.message)).toContain("invalid_payload");
    expect(String(err.message)).not.toContain("hooks.slack.com");
  });

  it("is bounded against a fetch that never settles", async () => {
    const { fetchFn } = hook(() => new Promise<Response>(() => {}));
    await expect(new DirectSlackAlarm(HOOK, { fetchFn }).sendPlainAlert("x", "info", { timeoutMs: 20 }))
      .rejects.toThrow(/timed out after 20ms/);
  });
});

describe("launchCapability", () => {
  const base = {
    remoteLaunchFrom: ["cloudbox"],
    opencodeClient: true,
    remoteLaunchClient: true,
    slackAlarmWebhook: true,
  };
  it("needs only the opencode client, the worker client and the Slack webhook: no chat input", () => {
    expect(launchCapability(base)).toEqual({ capable: true, missing: [] });
    expect(launchCapability({ ...base, slackAlarmWebhook: false })).toEqual({
      capable: false,
      missing: ["slackAlarmWebhookUrl"],
    });
    expect(launchCapability({ ...base, opencodeClient: false, remoteLaunchClient: false }).missing).toEqual([
      "opencodeClient",
      "remoteLaunchClient",
    ]);
    expect(launchCapability({ ...base, remoteLaunchFrom: [] })).toEqual({ capable: false, missing: [] });
  });

  it("the poller reads the relay header per poll", async () => {
    let header = "accept=a; failures=1";
    const seen: Array<string | null> = [];
    const p = new Poller(
      { workerUrl: "https://w", apiKey: "k", machineId: "d", relayHeaderFn: () => header },
      {} as PollerCallbacks,
      {
        fetchFn: (async (_u: string, init?: RequestInit) => {
          seen.push(new Headers(init?.headers).get("x-pigeon-swarm-relay"));
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
      },
    );
    await p.pollNext();
    header = "accept=a; launch=cloudbox; failures=1";
    await p.pollNext();
    expect(seen).toEqual(["accept=a; failures=1", "accept=a; launch=cloudbox; failures=1"]);
  });
});

describe("rich dialect", () => {
  async function stopPayload() {
    const s = mem();
    const a = createApp(s, { nowFn: () => 1_000, machineId: "devbox" });
    await a(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-r", notify: true, label: "l" }),
    }));
    await a(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-r", event: "Stop", message: "| a |\n|---|\n| 1 |", notification_id: "s:sess-r:m.0" }),
    }));
    return { s, a, payload: JSON.parse(s.outbox.getByNotificationId("s:sess-r:m.0")!.payload) };
  }

  it("a stop always carries dialect slack, with no transport state at all", async () => {
    const { payload } = await stopPayload();
    expect(payload.rich.dialect).toBe("slack");
    expect(payload.rich.markdown).not.toContain("tg-button");
    // The mention is a question's thing (below); a stop never asks for one.
    expect(payload).not.toHaveProperty("notifyOwner");
  });

  it("a question carries notifyOwner (the worker's SLACK_NOTIFY_OWNER decides)", async () => {
    const { s, a } = await stopPayload();
    const res = await a(new Request("http://localhost/question-asked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-r",
        request_id: "req1",
        questions: [{ question: "Q?", header: "h", options: [{ label: "a", description: "d" }] }],
      }),
    }));
    expect(res.status).toBe(202);
    const payload = JSON.parse(s.outbox.getByNotificationId("q:sess-r:req1")!.payload);
    expect(payload.notifyOwner).toBe(true);
  });
});

describe("errorClass", () => {
  const ctx = { hasLocalSession: true, alreadyReregistered: false, payloadHasEntities: true, attempts: 0 };
  const err = (body: unknown) => ({ ok: false as const, kind: "http_error" as const, status: 502, body });

  it("keys on errorClass; a bare details.error_code no longer means a rejected payload", () => {
    expect(getErrorClass({ errorClass: "rejected_format" })).toBe("rejected_format");
    expect(getErrorClass({ details: { errorClass: "upstream" } })).toBe("upstream");
    expect(classifyDeliveryFailure(err({ errorClass: "rejected_format", details: { error_code: 400 } }), ctx).action)
      .toBe("strip_entities");
    expect(classifyDeliveryFailure(err({ errorClass: "conversation_gone", details: { error_code: 400 } }), ctx).action)
      .toBe("retry");
    expect(classifyDeliveryFailure(err({ details: { error_code: 400 } }), ctx).action).toBe("retry");
  });

  it("worker-health: rejected_format and conversation_gone are neutral, upstream counts", () => {
    expect(classifyWorkerHealthSample(err({ errorClass: "rejected_format" }))).toBe("neutral");
    expect(classifyWorkerHealthSample(err({ errorClass: "conversation_gone" }))).toBe("neutral");
    expect(classifyWorkerHealthSample(err({ errorClass: "upstream", details: { error_code: 400 } }))).toBe("server_error");
    // No class: not a verdict on one message any more, so it counts.
    expect(classifyWorkerHealthSample(err({ details: { error_code: 400 } }))).toBe("server_error");
  });

  it("the worker client carries errorClass on a rejection and in the failure key", async () => {
    const client = (body: unknown, status = 200) =>
      new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn: (async () => Response.json(body, { status })) as unknown as typeof fetch });
    expect(await client({ ok: false, telegram: { status: 400, description: "thread not found: is_archived" }, errorClass: "conversation_gone" })
      .sendMessage({ chatId: "c", text: "t" }, { timeoutMs: 1000 }))
      .toEqual({ kind: "chat_rejected", status: 400, description: "thread not found: is_archived", errorClass: "conversation_gone" });
    const failed = await client({ ok: false, error: "telegram_error", telegram: { status: 502 }, errorClass: "upstream" }, 502)
      .sendMessage({ chatId: "c", text: "t" }, { timeoutMs: 1000 });
    expect(failed).toMatchObject({ kind: "worker_failed", key: "http502:upstream" });
  });
});

describe("alert notifier on Slack", () => {
  function notifier() {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, messageId: 1 });
    }) as unknown as typeof fetch;
    const n = createAlertNotifier({
      worker: new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn }),
    })!;
    return { n, bodies };
  }

  it("asks for notifyOwner on error alerts, sends no chatId of its own, and uses a returned one", async () => {
    const s = notifier();
    await s.n.sendPlainAlert!("boom", "error");
    await s.n.sendPlainAlert!("fyi", "info");
    await s.n.sendPlainAlert!("x", "warning", { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN });
    expect(s.bodies[0]).toEqual({ text: "❌ boom", notifyOwner: true });
    expect(s.bodies[1]).toEqual({ text: "fyi" });
    expect(s.bodies[2]).toMatchObject({ chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN });
    for (const b of s.bodies) expect(JSON.stringify(b)).not.toMatch(/-100|chat-1/);
  });
});

describe("/topics/lookup url", () => {
  it("uses the worker's url, and builds none itself: null, absent or a numeric chat row gets no button", () => {
    const kb = buildAlertKeyboard(
      [
        { label: "slack", sessionId: "a" },
        { label: "none", sessionId: "b" },
        { label: "tg", sessionId: "c" },
        { label: "bad", sessionId: "d" },
      ],
      {
        a: { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN, state: "open", url: "https://acme.slack.com/archives/C1" },
        b: { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN + 1, state: "open", url: null },
        c: { chatId: "-100555", messageThreadId: 7, state: "open" },
        d: { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN + 2, state: "open", url: "javascript:alert(1)" },
      },
    );
    expect(kb?.inline_keyboard).toEqual([[{ text: "slack", url: "https://acme.slack.com/archives/C1" }]]);
  });
});

describe("/alert named topic chatId", () => {
  it("sends into the chat the worker returned, and drops it with the thread", async () => {
    const s = mem();
    const sent: Array<object | undefined> = [];
    const a = createApp(s, {
      notifier: {
        sendPlainAlert: async (_t, _s, o) => {
          sent.push(o);
          if (sent.length === 1) throw new ChatSendError(400, "x", "slack rejected the message: invalid_blocks", "rejected_format");
        },
      },
      resolveNamedTopic: async () => ({ messageThreadId: SLACK_HANDLE_MIN + 9, created: true, chatId: "slack:T1" }),
    });
    const res = await a(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", topic: { key: "k", name: "n" } }),
    }));
    expect(res.status).toBe(204);
    expect(sent[0]).toMatchObject({ chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN + 9 });
    expect(sent[1]).not.toHaveProperty("chatId");
    expect(sent[1]).not.toHaveProperty("messageThreadId");
  });

  it("treats conversation_gone as a deleted topic and re-resolves", async () => {
    const s = mem();
    const sent: Array<object | undefined> = [];
    const resolves: unknown[] = [];
    const a = createApp(s, {
      notifier: {
        sendPlainAlert: async (_t, _s, o) => {
          sent.push(o);
          if (sent.length === 1) throw new ChatSendError(400, "x", "slack: is_archived", "conversation_gone");
        },
      },
      resolveNamedTopic: async (req) => {
        resolves.push(req);
        return { messageThreadId: SLACK_HANDLE_MIN + resolves.length, created: false, chatId: "slack:T1" };
      },
    });
    await a(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", topic: { key: "k", name: "n" } }),
    }));
    expect(resolves[1]).toMatchObject({ staleThreadId: SLACK_HANDLE_MIN + 1 });
    expect(sent[1]).toMatchObject({ chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN + 2 });
  });
});

describe("Slack egress guard", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  it("hooks.slack.com appears in no daemon src file but direct-slack-alarm.ts", () => {
    const src = join(__dirname, "..", "src");
    const offenders = walk(src)
      .filter((p) => /\.[cm]?[jt]s$/.test(p))
      .filter((p) => readFileSync(p, "utf8").includes("hooks.slack.com") || readFileSync(p, "utf8").includes("hooks\\.slack\\.com"))
      .map((p) => relative(src, p))
      .filter((p) => p !== "direct-slack-alarm.ts");
    expect(offenders).toEqual([]);
    expect(readFileSync(join(src, "direct-slack-alarm.ts"), "utf8")).toContain("hooks\\.slack\\.com");
  });

  it("the Telegram Bot API host appears nowhere in daemon src (its direct alarm was deleted)", () => {
    const src = join(__dirname, "..", "src");
    const offenders = walk(src)
      .filter((p) => /\.[cm]?[jt]s$/.test(p))
      .filter((p) => readFileSync(p, "utf8").includes("api.telegram.org"))
      .map((p) => relative(src, p));
    expect(offenders).toEqual([]);
  });
});

describe("outbox carries dialect and notifyOwner to /notifications/send", () => {
  it("passes rich.dialect and notifyOwner through to the worker body", async () => {
    const s = mem();
    s.outbox.upsert({
      notificationId: "q:sess-1:r",
      sessionId: "sess-1",
      requestId: "r",
      kind: "question",
      payload: JSON.stringify({
        messages: [{ text: "hi", entities: [] }],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "q:sess-1:r",
        rich: { markdown: "**hi**", dialect: "slack" },
        notifyOwner: true,
      }),
      token: "t",
    }, 1_000);
    const bodies: Array<Record<string, unknown>> = [];
    const poller = new Poller({ workerUrl: "https://w", apiKey: "k", machineId: "d" }, {} as PollerCallbacks, {
      fetchFn: (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, messageId: 1, rich: "sent" });
      }) as unknown as typeof fetch,
    });
    const sender = new OutboxSender({
      storage: s,
      sendNotification: (input) => poller.sendNotification(input),
      nowFn: () => 5_000,
    });
    await sender.processOnce();
    expect(bodies[0]).toMatchObject({ rich: { markdown: "**hi**", dialect: "slack" }, notifyOwner: true });
  });
});

describe("Slack alarm ladder via the composed notifier", () => {
  it("worker fails -> the Slack webhook gets the alert with the suffix", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.startsWith("https://w/")) return new Response("down", { status: 503 });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const n = createAlertNotifier({
      worker: new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn }),
      direct: new DirectSlackAlarm(HOOK, { fetchFn }),
    })!;
    await n.sendPlainAlert!("worker is down", "error");
    const hookCall = calls.find((c) => c.url === HOOK)!;
    expect(hookCall.body.text).toMatch(/^❌ worker is down · sent direct; worker: HTTP 503/);
  });

  it("a direct-only host (no worker) posts straight to the webhook", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const n = createAlertNotifier({ direct: new DirectSlackAlarm(HOOK, { fetchFn }) })!;
    await n.sendPlainAlert!("x", "info");
    expect(calls).toEqual([HOOK]);
  });
});

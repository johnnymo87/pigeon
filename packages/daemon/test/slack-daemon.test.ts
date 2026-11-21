/** Daemon Slack support (pigeon-4ogz.5; design docs/plans/2026-11-20-slack-transport-design.md §6-§7). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { ChatTransportState, transportOf } from "../src/chat-transport-state";
import { Poller, type PollerCallbacks } from "../src/worker/poller";
import { DirectSlackAlarm, parseSlackWebhookUrl, renderSlackAlarmText, SlackWebhookError } from "../src/direct-slack-alarm";
import { createDirectAlarm, pickDirectAlarm, SLACK_HANDLE_MIN } from "../src/direct-alarm";
import { launchCapability } from "../src/launch-capability";
import { buildRichMarkdown } from "../src/rich-markdown";
import type { TgMessage } from "../src/telegram-message";

const msg = (text: string, entities: TgMessage["entities"] = []): TgMessage => ({ text, entities });
import { classifyDeliveryFailure, getErrorClass } from "../src/worker/delivery-policy";
import { classifyWorkerHealthSample } from "../src/worker/worker-health";
import { WorkerMessageClient } from "../src/worker/worker-message-client";
import { createAlertNotifier } from "../src/alert-notifier";
import { buildAlertKeyboard } from "../src/alert-links";
import { loadConfig } from "../src/config";
import { TelegramSendError } from "../src/notification-service";

const HOOK = "https://hooks.slack.com/services/T0/B0/xyz";

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

  it("reads transport only when the worker says slack; absent stays byte-identical", async () => {
    expect(await poller({ credential: "machine", machine_id: "devbox", transport: "slack" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox", transport: "slack" });
    expect(await poller({ credential: "machine", machine_id: "devbox" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox" });
    expect(await poller({ credential: "machine", machine_id: "devbox", transport: "carrier-pigeon" }).whoami())
      .toEqual({ kind: "machine", machineId: "devbox" });
  });

  it("maps answers: absent in a 200 is telegram, non-answers establish nothing", () => {
    expect(transportOf({ kind: "machine", machineId: "d", transport: "slack" })).toBe("slack");
    expect(transportOf({ kind: "machine", machineId: "d" })).toBe("telegram");
    expect(transportOf({ kind: "shared" })).toBe("telegram");
    expect(transportOf({ kind: "rejected", status: 401 })).toBeUndefined();
    expect(transportOf({ kind: "unsupported" })).toBeUndefined();
    expect(transportOf({ kind: "unknown", error: "x" })).toBeUndefined();
  });

  it("persists the last value, keeps it on an unreadable whoami, and reloads it", () => {
    const s = mem();
    const log = vi.fn();
    const a = new ChatTransportState({ db: s.db, log });
    expect(a.get()).toBeUndefined();
    a.observe({ kind: "machine", machineId: "d", transport: "slack" });
    expect(a.get()).toBe("slack");
    a.observe({ kind: "unknown", error: "timeout" });
    a.observe({ kind: "rejected", status: 403 });
    expect(a.get()).toBe("slack");
    // A restart (new instance on the same DB) during an outage keeps it.
    expect(new ChatTransportState({ db: s.db, log }).get()).toBe("slack");
    a.observe({ kind: "machine", machineId: "d" });
    expect(new ChatTransportState({ db: s.db, log }).get()).toBe("telegram");
    expect(log).toHaveBeenCalledWith("[chat-transport] transport=telegram (was slack)");
  });

  it("re-reads on an interval", async () => {
    vi.useFakeTimers();
    try {
      const st = new ChatTransportState({ db: mem().db, log: () => {} });
      const whoami = vi.fn(async () => ({ kind: "machine" as const, machineId: "d", transport: "slack" as const }));
      st.start(whoami, 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(whoami).toHaveBeenCalledTimes(1);
      expect(st.get()).toBe("slack");
      st.stop();
    } finally {
      vi.useRealTimers();
    }
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

  it("mentions the owner only with PIGEON_SLACK_NOTIFY_OWNER=1 and an id", () => {
    expect(renderSlackAlarmText("x", "info", undefined, "U1")).toBe("<@U1> x");
    const { fetchFn, calls } = hook();
    void new DirectSlackAlarm(HOOK, { notifyOwner: true, fetchFn }).sendPlainAlert("x", "info");
    expect(calls[0]!.body.text).toBe("x");
  });

  it("throws SlackWebhookError on a non-2xx, never TelegramSendError", async () => {
    const { fetchFn } = hook(() => new Response("invalid_payload", { status: 400 }));
    const err = await new DirectSlackAlarm(HOOK, { fetchFn }).sendPlainAlert("x", "info").catch((e) => e);
    expect(err).toBeInstanceOf(SlackWebhookError);
    expect(err).not.toBeInstanceOf(TelegramSendError);
    expect(String(err.message)).toContain("invalid_payload");
    expect(String(err.message)).not.toContain("hooks.slack.com");
  });

  it("is bounded against a fetch that never settles", async () => {
    const { fetchFn } = hook(() => new Promise<Response>(() => {}));
    await expect(new DirectSlackAlarm(HOOK, { fetchFn }).sendPlainAlert("x", "info", { timeoutMs: 20 }))
      .rejects.toThrow(/timed out after 20ms/);
  });
});

describe("direct alarm selection", () => {
  const tg = { sendPlainAlert: vi.fn(async () => {}) };
  const sl = { sendPlainAlert: vi.fn(async () => {}) };

  it("slack transport -> slack; telegram -> telegram; unknown -> telegram first", () => {
    expect(pickDirectAlarm({ telegram: tg, slack: sl }, "slack")?.name).toBe("slack");
    expect(pickDirectAlarm({ telegram: tg, slack: sl }, "telegram")?.name).toBe("telegram");
    expect(pickDirectAlarm({ telegram: tg, slack: sl }, undefined)?.name).toBe("telegram");
    expect(pickDirectAlarm({ slack: sl }, undefined)?.name).toBe("slack");
    expect(pickDirectAlarm({ telegram: tg }, "slack")?.name).toBe("telegram");
    expect(createDirectAlarm({ transport: () => "slack" })).toBeUndefined();
  });

  it("follows the transport per alert and never hands Telegram a Slack address", async () => {
    let t: "slack" | "telegram" | undefined = "slack";
    const alarm = createDirectAlarm({ telegram: tg, slack: sl, transport: () => t })!;
    await alarm.sendPlainAlert("a", "info");
    expect(sl.sendPlainAlert).toHaveBeenCalledTimes(1);
    t = "telegram";
    await alarm.sendPlainAlert("b", "info", { messageThreadId: SLACK_HANDLE_MIN + 3, chatId: "slack:T1", timeoutMs: 9 });
    expect(tg.sendPlainAlert).toHaveBeenLastCalledWith("b", "info", { timeoutMs: 9 });
    await alarm.sendPlainAlert("c", "info", { messageThreadId: 42 });
    expect(tg.sendPlainAlert).toHaveBeenLastCalledWith("c", "info", { messageThreadId: 42 });
  });
});

describe("launchCapability", () => {
  const base = {
    remoteLaunchFrom: ["cloudbox"],
    opencodeClient: true,
    remoteLaunchClient: true,
    telegramBotToken: true,
    telegramChatId: true,
    slackAlarmWebhook: false,
  };
  it("telegram (or unknown) needs the bot token; slack needs the webhook instead", () => {
    expect(launchCapability(base, "telegram").capable).toBe(true);
    expect(launchCapability(base, undefined).capable).toBe(true);
    expect(launchCapability(base, "slack")).toEqual({ capable: false, missing: ["slackAlarmWebhookUrl"] });
    expect(launchCapability({ ...base, telegramBotToken: false, slackAlarmWebhook: true }, "slack").capable).toBe(true);
    expect(launchCapability({ ...base, telegramBotToken: false }, "telegram").missing).toEqual(["telegramBotToken"]);
    expect(launchCapability({ ...base, remoteLaunchFrom: [] }, "telegram")).toEqual({ capable: false, missing: [] });
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
  const header = msg("✅ s", [{ type: "bold", offset: 0, length: 3 }]);
  const footer = msg("🆔 ses_abc", [{ type: "code", offset: 3, length: 7 }]);
  const body = msg("Costs $5 == a || b <T>\n| a | b |\n|---|---|\n| 1 | 2 |");

  it("slack: standard GFM, no tg-button, no Telegram escapes or spacers", () => {
    const md = buildRichMarkdown(header, body, footer, { dialect: "slack" })!;
    expect(md).not.toContain("tg-button");
    expect(md).not.toContain("&nbsp;");
    expect(md).not.toContain("\\$");
    expect(md).not.toContain("&lt;");
    expect(md).not.toContain("\\=");
    expect(md).toContain("Costs $5 == a || b <T>");
    expect(md).toContain("`ses_abc`");
    expect(md).toContain("| a | b |\n|---|---|\n| 1 | 2 |");
  });

  it("telegram default is unchanged", () => {
    const md = buildRichMarkdown(header, body, footer)!;
    expect(md).toContain("tg-button");
    expect(md).toContain("\\$5");
  });

  it("slack limit is 12000 chars", () => {
    const big = msg(`| a |\n|---|\n| ${"x".repeat(13_000)} |`);
    expect(buildRichMarkdown(header, big, footer, { dialect: "slack" })).toBeNull();
    expect(buildRichMarkdown(header, big, footer)).not.toBeNull();
  });

  async function app(transport: "slack" | "telegram" | undefined) {
    const s = mem();
    const a = createApp(s, { nowFn: () => 1_000, chatId: "chat-1", machineId: "devbox", chatTransport: () => transport });
    await a(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-r", notify: true, label: "l" }),
    }));
    return { s, a };
  }

  it("a stop on a Slack machine carries dialect slack; on Telegram no dialect", async () => {
    for (const [t, dialect] of [["slack", "slack"], ["telegram", undefined], [undefined, undefined]] as const) {
      const { s, a } = await app(t);
      await a(new Request("http://localhost/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-r", event: "Stop", message: "| a |\n|---|\n| 1 |", notification_id: "s:sess-r:m.0" }),
      }));
      const payload = JSON.parse(s.outbox.getByNotificationId("s:sess-r:m.0")!.payload);
      expect(payload.rich.dialect).toBe(dialect);
      expect("dialect" in payload.rich).toBe(dialect !== undefined);
      expect(payload).not.toHaveProperty("notifyOwner");
    }
  });

  it("a question carries notifyOwner only on Slack", async () => {
    for (const t of ["slack", "telegram"] as const) {
      const { s, a } = await app(t);
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
      if (t === "slack") expect(payload.notifyOwner).toBe(true);
      else expect(payload).not.toHaveProperty("notifyOwner");
    }
  });
});

describe("errorClass", () => {
  const ctx = { hasLocalSession: true, alreadyReregistered: false, payloadHasEntities: true, attempts: 0 };
  const err = (body: unknown) => ({ ok: false as const, kind: "http_error" as const, status: 502, body });

  it("is preferred over details.error_code; legacy still honoured", () => {
    expect(getErrorClass({ errorClass: "rejected_format" })).toBe("rejected_format");
    expect(getErrorClass({ details: { errorClass: "upstream" } })).toBe("upstream");
    expect(classifyDeliveryFailure(err({ errorClass: "rejected_format", details: { error_code: 400 } }), ctx).action)
      .toBe("strip_entities");
    expect(classifyDeliveryFailure(err({ errorClass: "conversation_gone", details: { error_code: 400 } }), ctx).action)
      .toBe("retry");
    expect(classifyDeliveryFailure(err({ details: { error_code: 400 } }), ctx).action).toBe("strip_entities");
  });

  it("worker-health: rejected_format and conversation_gone are neutral, upstream counts", () => {
    expect(classifyWorkerHealthSample(err({ errorClass: "rejected_format" }))).toBe("neutral");
    expect(classifyWorkerHealthSample(err({ errorClass: "conversation_gone" }))).toBe("neutral");
    expect(classifyWorkerHealthSample(err({ errorClass: "upstream", details: { error_code: 400 } }))).toBe("server_error");
  });

  it("the worker client carries errorClass on a rejection and in the failure key", async () => {
    const client = (body: unknown, status = 200) =>
      new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn: (async () => Response.json(body, { status })) as unknown as typeof fetch });
    expect(await client({ ok: false, telegram: { status: 400, description: "thread not found: is_archived" }, errorClass: "conversation_gone" })
      .sendMessage({ chatId: "c", text: "t" }, { timeoutMs: 1000 }))
      .toEqual({ kind: "telegram_rejected", status: 400, description: "thread not found: is_archived", errorClass: "conversation_gone" });
    const failed = await client({ ok: false, error: "telegram_error", telegram: { status: 502 }, errorClass: "upstream" }, 502)
      .sendMessage({ chatId: "c", text: "t" }, { timeoutMs: 1000 });
    expect(failed).toMatchObject({ kind: "worker_failed", key: "http502:upstream" });
  });
});

describe("alert notifier on Slack", () => {
  function notifier(transport: "slack" | "telegram") {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, messageId: 1 });
    }) as unknown as typeof fetch;
    const n = createAlertNotifier({
      chatId: "-100123",
      worker: new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn }),
      transport: () => transport,
    })!;
    return { n, bodies };
  }

  it("asks for notifyOwner on error alerts on Slack only, and uses a returned chatId", async () => {
    const s = notifier("slack");
    await s.n.sendPlainAlert!("boom", "error");
    await s.n.sendPlainAlert!("fyi", "info");
    await s.n.sendPlainAlert!("x", "warning", { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN });
    expect(s.bodies[0]).toMatchObject({ notifyOwner: true, chatId: "-100123" });
    expect(s.bodies[1]).not.toHaveProperty("notifyOwner");
    expect(s.bodies[2]).toMatchObject({ chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN });
    const t = notifier("telegram");
    await t.n.sendPlainAlert!("boom", "error");
    expect(t.bodies[0]).toEqual({ chatId: "-100123", text: "❌ boom" });
  });
});

describe("/topics/lookup url", () => {
  it("prefers the worker's url, drops null, builds t.me when absent", () => {
    const kb = buildAlertKeyboard(
      [
        { label: "slack", sessionId: "a" },
        { label: "none", sessionId: "b" },
        { label: "tg", sessionId: "c" },
      ],
      {
        a: { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN, state: "open", url: "https://acme.slack.com/archives/C1" },
        b: { chatId: "slack:T1", messageThreadId: SLACK_HANDLE_MIN + 1, state: "open", url: null },
        c: { chatId: "-100555", messageThreadId: 7, state: "open" },
      },
    );
    expect(kb?.inline_keyboard).toEqual([
      [{ text: "slack", url: "https://acme.slack.com/archives/C1" }],
      [{ text: "tg", url: "https://t.me/c/555/7" }],
    ]);
  });
});

describe("/alert named topic chatId", () => {
  it("sends into the chat the worker returned, and drops it with the thread", async () => {
    const s = mem();
    const sent: Array<object | undefined> = [];
    const a = createApp(s, {
      chatId: "-100123",
      notifier: {
        sendPlainAlert: async (_t, _s, o) => {
          sent.push(o);
          if (sent.length === 1) throw new TelegramSendError(400, "x", "slack rejected the message: invalid_blocks", "rejected_format");
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
      chatId: "-100123",
      notifier: {
        sendPlainAlert: async (_t, _s, o) => {
          sent.push(o);
          if (sent.length === 1) throw new TelegramSendError(400, "x", "slack: is_archived", "conversation_gone");
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
});

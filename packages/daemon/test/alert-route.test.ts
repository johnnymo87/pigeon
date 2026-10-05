import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { TelegramSendError, type StopNotifier } from "../src/notification-service";

describe("POST /alert", () => {
  let storage: StorageDb | null = null;
  let sendPlainAlert: ReturnType<typeof vi.fn>;

  function makeNotifier(withSendPlainAlert: boolean): StopNotifier {
    const notifier: StopNotifier = {};
    if (withSendPlainAlert) {
      notifier.sendPlainAlert = sendPlainAlert;
    }
    return notifier;
  }

  beforeEach(() => {
    storage = openStorageDb(":memory:");
    sendPlainAlert = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("returns 204 and forwards text to the notifier", async () => {
    const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
    const res = await app(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world", severity: "error" }),
    }));
    expect(res.status).toBe(204);
    expect(sendPlainAlert).toHaveBeenCalledWith("hello world", "error");
  });

  it("defaults severity to 'info' when omitted", async () => {
    const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
    const res = await app(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }));
    expect(res.status).toBe(204);
    expect(sendPlainAlert).toHaveBeenCalledWith("hello", "info");
  });

  it("rejects empty text with 400", async () => {
    const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
    const res = await app(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }));
    expect(res.status).toBe(400);
    expect(sendPlainAlert).not.toHaveBeenCalled();
  });

  describe("links", () => {
    const CHAT = "-1001234567890";
    function post(app: ReturnType<typeof createApp>, body: unknown) {
      return app(new Request("http://localhost/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    it("absent links: notifier called with exactly (text, severity) and no lookup", async () => {
      const lookupTopics = vi.fn();
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, { text: "hi", severity: "info" });
      expect(res.status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["hi", "info"]);
      expect(lookupTopics).not.toHaveBeenCalled();
    });

    it("renders one url button per linkable session", async () => {
      const lookupTopics = vi.fn().mockResolvedValue({
        s1: { chatId: CHAT, messageThreadId: 42, state: "open" },
        s2: null,
      });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, {
        text: "digest",
        severity: "info",
        links: [{ label: "first", sessionId: "s1" }, { label: "second", sessionId: "s2" }],
      });
      expect(res.status).toBe(204);
      expect(lookupTopics).toHaveBeenCalledTimes(1);
      expect(lookupTopics.mock.calls[0]![0]).toEqual(["s1", "s2"]);
      expect(sendPlainAlert).toHaveBeenCalledWith("digest", "info", {
        replyMarkup: { inline_keyboard: [[{ text: "first", url: "https://t.me/c/1234567890/42" }]] },
        timeoutMs: expect.any(Number),
      });
    });

    it("the lookup is charged against the send's 10s budget, so the total stays at today's bound", async () => {
      let t = 0;
      const realNow = Date.now;
      Date.now = () => t;
      try {
        const lookupTopics = vi.fn(async () => {
          t += 1_500;
          return { s1: { chatId: CHAT, messageThreadId: 42, state: "open" as const } };
        });
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
        await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
        expect(sendPlainAlert.mock.calls[0]![2].timeoutMs).toBe(8_500);
      } finally {
        Date.now = realNow;
      }
    });

    it("no linkable session: sent exactly as if links were absent", async () => {
      const lookupTopics = vi.fn().mockResolvedValue({ s1: null });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
    });

    it("lookup failure fails open: 204, alert sent without buttons", async () => {
      const lookupTopics = vi.fn().mockRejectedValue(new Error("worker down"));
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
    });

    it("malformed links never produce a 4xx", async () => {
      const lookupTopics = vi.fn();
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      for (const links of ["nope", 5, { a: 1 }, [null, 3, { label: 1 }], null]) {
        sendPlainAlert.mockClear();
        const res = await post(app, { text: "x", links });
        expect(res.status).toBe(204);
        expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
      }
      expect(lookupTopics).not.toHaveBeenCalled();
    });

    it("no lookup configured (no worker on this host): sent without buttons", async () => {
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
      const res = await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
    });

    it("if Telegram rejects the buttons with a 400, resends once without them", async () => {
      sendPlainAlert
        .mockRejectedValueOnce(new TelegramSendError(400, "Bad Request: BUTTON_URL_INVALID"))
        .mockResolvedValueOnce(undefined);
      const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: CHAT, messageThreadId: 42, state: "open" } });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(204);
      expect(sendPlainAlert).toHaveBeenCalledTimes(2);
      expect(sendPlainAlert.mock.calls[1]![0]).toBe("x");
      expect(sendPlainAlert.mock.calls[1]![2]).not.toHaveProperty("replyMarkup");
      expect(sendPlainAlert.mock.calls[1]![2].timeoutMs).toBeLessThanOrEqual(10_000);
    });

    it("does not resend on a non-400 failure (it may have been delivered)", async () => {
      sendPlainAlert.mockRejectedValueOnce(new Error("Telegram sendMessage timed out after 10000ms"));
      const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: CHAT, messageThreadId: 42, state: "open" } });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), lookupTopics });
      const res = await post(app, { text: "x", links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(502);
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe("topic", () => {
    function post(app: ReturnType<typeof createApp>, body: unknown) {
      return app(new Request("http://localhost/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    }
    const threadNotFound = () => new TelegramSendError(400, "Telegram sendMessage returned 400", "Bad Request: message thread not found");

    it("absent topic: notifier called with exactly (text, severity) and no resolve", async () => {
      const resolveNamedTopic = vi.fn();
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
      expect((await post(app, { text: "hi" })).status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["hi", "info"]);
      expect(resolveNamedTopic).not.toHaveBeenCalled();
    });

    it("posts into the resolved topic", async () => {
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
      const res = await post(app, { text: "digest", topic: { key: "digest:a", name: "A" } });
      expect(res.status).toBe(204);
      expect(resolveNamedTopic.mock.calls[0]![0]).toEqual({ key: "digest:a", name: "A" });
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      expect(sendPlainAlert.mock.calls[0]![2]).toMatchObject({ messageThreadId: 77 });
    });

    it("links and topic together: buttons ride in the topic", async () => {
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
      const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: "-1001234567890", messageThreadId: 42, state: "open" } });
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic, lookupTopics });
      await post(app, { text: "d", topic: { key: "k" }, links: [{ label: "a", sessionId: "s1" }] });
      expect(sendPlainAlert.mock.calls[0]![2]).toMatchObject({
        messageThreadId: 77,
        replyMarkup: { inline_keyboard: [[{ text: "a", url: "https://t.me/c/1234567890/42" }]] },
      });
    });

    it("a malformed topic or a failing resolver falls back to General with 204", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("worker down"));
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic: failing });
      for (const topic of ["x", { key: "bad key" }, null, { key: "ok" }]) {
        sendPlainAlert.mockClear();
        const res = await post(app, { text: "x", topic });
        expect(res.status).toBe(204);
        expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
      }
      expect(failing).toHaveBeenCalledTimes(1); // only for the well-formed key
    });

    it("no resolver configured (no worker): General", async () => {
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
      expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
      expect(sendPlainAlert.mock.calls[0]).toEqual(["x", "info"]);
    });

    it("thread not found: re-resolves with the stale thread and resends into the new topic", async () => {
      const resolveNamedTopic = vi.fn()
        .mockResolvedValueOnce({ messageThreadId: 77, created: false })
        .mockResolvedValueOnce({ messageThreadId: 78, created: true });
      sendPlainAlert.mockRejectedValueOnce(threadNotFound()).mockResolvedValueOnce(undefined);
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
      expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
      expect(resolveNamedTopic.mock.calls[1]![0]).toEqual({ key: "k", name: "k", staleThreadId: 77 });
      expect(sendPlainAlert.mock.calls[1]![2]).toMatchObject({ messageThreadId: 78 });
    });

    it("thread not found and recreate fails: General", async () => {
      const resolveNamedTopic = vi.fn()
        .mockResolvedValueOnce({ messageThreadId: 77, created: false })
        .mockRejectedValueOnce(new Error("create failed"));
      sendPlainAlert.mockRejectedValueOnce(threadNotFound()).mockResolvedValueOnce(undefined);
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
      expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
      expect(sendPlainAlert.mock.calls[1]![2]).not.toHaveProperty("messageThreadId");
    });

    it("another 400 in the topic: drop the buttons, then move to General with the buttons restored", async () => {
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
      const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: "-1001234567890", messageThreadId: 42, state: "open" } });
      const bad = () => new TelegramSendError(400, "Telegram sendMessage returned 400", "Bad Request: something");
      sendPlainAlert.mockRejectedValueOnce(bad()).mockRejectedValueOnce(bad()).mockResolvedValueOnce(undefined);
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic, lookupTopics });
      const res = await post(app, { text: "x", topic: { key: "k" }, links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(204);
      expect(sendPlainAlert).toHaveBeenCalledTimes(3);
      expect(sendPlainAlert.mock.calls[1]![2]).toMatchObject({ messageThreadId: 77 });
      expect(sendPlainAlert.mock.calls[1]![2]).not.toHaveProperty("replyMarkup");
      expect(sendPlainAlert.mock.calls[2]![2]).not.toHaveProperty("messageThreadId");
      expect(sendPlainAlert.mock.calls[2]![2]).toHaveProperty("replyMarkup");
    });

    it("400 on every rung: five sends at most, then 502", async () => {
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
      const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: "-1001234567890", messageThreadId: 42, state: "open" } });
      sendPlainAlert.mockRejectedValue(new TelegramSendError(400, "Telegram sendMessage returned 400", "Bad Request: x"));
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic, lookupTopics });
      const res = await post(app, { text: "x", topic: { key: "k" }, links: [{ label: "a", sessionId: "s1" }] });
      expect(res.status).toBe(502);
      expect(sendPlainAlert.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it("a timeout in the topic is not retried (it may have posted)", async () => {
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
      sendPlainAlert.mockRejectedValueOnce(new Error("Telegram sendMessage timed out after 10000ms"));
      const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
      expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(502);
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    });

    it("a newly created topic gets its auto-pin cleared, best-effort", async () => {
      const unpinTopic = vi.fn().mockRejectedValue(new Error("no rights"));
      const notifier = { sendPlainAlert, unpinTopic } as StopNotifier;
      const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 90, created: true });
      const app = createApp(storage!, { nowFn: () => 1000, notifier, resolveNamedTopic });
      expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
      await new Promise((r) => setTimeout(r, 0));
      expect(unpinTopic).toHaveBeenCalledWith(90);
    });

    describe("strict_topic", () => {
      it("unresolved + strict → 502 and sendPlainAlert never called", async () => {
        const failing = vi.fn().mockRejectedValue(new Error("worker down"));
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic: failing });
        const res = await post(app, { text: "x", topic: { key: "k" }, strict_topic: true });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "topic_unavailable" });
        expect(sendPlainAlert).not.toHaveBeenCalled();
      });

      it("unresolved + not strict → unchanged (General, 204)", async () => {
        const failing = vi.fn().mockRejectedValue(new Error("worker down"));
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic: failing });
        const res = await post(app, { text: "x", topic: { key: "k" }, strict_topic: false });
        expect(res.status).toBe(204);
        expect(sendPlainAlert).toHaveBeenCalledTimes(1);
        expect(sendPlainAlert.mock.calls[0]![2]).toBeUndefined();
      });

      it("strict_topic without topic is ignored", async () => {
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
        const res = await post(app, { text: "x", strict_topic: true });
        expect(res.status).toBe(204);
        expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      });

      it("strict_topic with malformed topic returns 400 invalid_topic and sends nothing", async () => {
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true) });
        const res = await post(app, { text: "x", topic: { key: "bad key with spaces" }, strict_topic: true });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_topic" });
        expect(sendPlainAlert).not.toHaveBeenCalled();
      });

      it("thread-not-found + strict → recreated thread used", async () => {
        const resolveNamedTopic = vi.fn()
          .mockResolvedValueOnce({ messageThreadId: 77, created: false })
          .mockResolvedValueOnce({ messageThreadId: 78, created: true });
        sendPlainAlert.mockRejectedValueOnce(threadNotFound()).mockResolvedValueOnce(undefined);
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
        const res = await post(app, { text: "x", topic: { key: "k" }, strict_topic: true });
        expect(res.status).toBe(204);
        expect(resolveNamedTopic.mock.calls[1]![0]).toEqual({ key: "k", name: "k", staleThreadId: 77 });
        expect(sendPlainAlert.mock.calls[1]![2]).toMatchObject({ messageThreadId: 78 });
      });

      it("thread-not-found + strict when recreate fails → 502", async () => {
        const resolveNamedTopic = vi.fn()
          .mockResolvedValueOnce({ messageThreadId: 77, created: false })
          .mockRejectedValueOnce(new Error("create failed"));
        sendPlainAlert.mockRejectedValueOnce(threadNotFound());
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic });
        const res = await post(app, { text: "x", topic: { key: "k" }, strict_topic: true });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "topic_unavailable" });
      });

      it("400-after-buttons + strict → 502 without a General send", async () => {
        const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
        const lookupTopics = vi.fn().mockResolvedValue({ s1: { chatId: "-1001234567890", messageThreadId: 42, state: "open" } });
        const bad = () => new TelegramSendError(400, "Telegram sendMessage returned 400", "Bad Request: something in topic");
        sendPlainAlert.mockRejectedValueOnce(bad()).mockRejectedValueOnce(bad());
        const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(true), resolveNamedTopic, lookupTopics });
        const res = await post(app, {
          text: "x",
          topic: { key: "k" },
          links: [{ label: "a", sessionId: "s1" }],
          strict_topic: true,
        });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({
          error: "rejected_in_topic",
          detail: "Bad Request: something in topic",
        });
        expect(sendPlainAlert).toHaveBeenCalledTimes(2);
        expect(sendPlainAlert.mock.calls[0]![2]).toMatchObject({ messageThreadId: 77 });
        expect(sendPlainAlert.mock.calls[1]![2]).toMatchObject({ messageThreadId: 77 });
      });
    });
  });

  it("returns 503 when the notifier does not implement sendPlainAlert", async () => {
    const app = createApp(storage!, { nowFn: () => 1000, notifier: makeNotifier(false) });
    const res = await app(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    }));
    expect(res.status).toBe(503);
  });
});

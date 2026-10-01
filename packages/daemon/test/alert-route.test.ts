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
      });
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
      expect(sendPlainAlert.mock.calls[1]).toEqual(["x", "info"]);
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

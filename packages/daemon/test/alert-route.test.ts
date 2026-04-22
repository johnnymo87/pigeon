import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { StopNotifier } from "../src/notification-service";

describe("POST /alert", () => {
  let storage: StorageDb | null = null;
  let sendPlainAlert: ReturnType<typeof vi.fn>;

  function makeNotifier(withSendPlainAlert: boolean): StopNotifier {
    const notifier: StopNotifier & {
      sendQuestionNotification: ReturnType<typeof vi.fn>;
      sendPlainAlert?: ReturnType<typeof vi.fn>;
    } = {
      sendStopNotification: vi.fn().mockResolvedValue({ token: "t" }),
      sendQuestionNotification: vi.fn().mockResolvedValue({ token: "t" }),
    };
    if (withSendPlainAlert) {
      notifier.sendPlainAlert = sendPlainAlert;
    }
    return notifier as unknown as StopNotifier;
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

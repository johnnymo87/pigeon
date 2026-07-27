import { describe, expect, it, vi } from "vitest";
import { createTelegramReplySender, type SendTelegramMessageFn } from "../src/worker/reply-factory";
import type { TgEntity } from "../src/telegram-message";

describe("createTelegramReplySender", () => {
  it("(a) forwards messageThreadId from command message to sendTelegramMessage", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined) as unknown as SendTelegramMessageFn;
    const msg = { messageThreadId: 64003 };
    const replySender = createTelegramReplySender(mockSend, msg);

    await replySender("chat-123", "hello from topic");

    expect(mockSend).toHaveBeenCalledWith("chat-123", "hello from topic", {
      entities: undefined,
      messageThreadId: 64003,
    });
  });

  it("(b) forwards undefined when messageThreadId is absent/null/undefined", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined) as unknown as SendTelegramMessageFn;
    const msgWithoutThread = {};
    const replySender1 = createTelegramReplySender(mockSend, msgWithoutThread);

    await replySender1("chat-123", "hello general");

    expect(mockSend).toHaveBeenLastCalledWith("chat-123", "hello general", {
      entities: undefined,
      messageThreadId: undefined,
    });

    const msgWithNullThread = { messageThreadId: null };
    const replySender2 = createTelegramReplySender(mockSend, msgWithNullThread);

    await replySender2("chat-123", "hello general null");

    expect(mockSend).toHaveBeenLastCalledWith("chat-123", "hello general null", {
      entities: undefined,
      messageThreadId: undefined,
    });
  });

  it("(c) forwards entities through closure without dropping them", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined) as unknown as SendTelegramMessageFn;
    const msg = { messageThreadId: 64003 };
    const replySender = createTelegramReplySender(mockSend, msg);

    const entities: TgEntity[] = [
      { type: "bold", offset: 0, length: 5 },
      { type: "code", offset: 6, length: 10 },
    ];

    await replySender("chat-123", "hello styled world", entities);

    expect(mockSend).toHaveBeenCalledWith("chat-123", "hello styled world", {
      entities,
      messageThreadId: 64003,
    });
  });
});

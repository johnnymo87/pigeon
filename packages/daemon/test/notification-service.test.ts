import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramNotification,
  TelegramNotificationService,
} from "../src/notification-service";
import { openStorageDb } from "../src/storage/database";

describe("formatTelegramNotification", () => {
  it("formats markdown body and callback buttons", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "my_[label]*",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      buttons: [
        { text: "A", action: "continue" },
        { text: "B", action: "y" },
        { text: "C", action: "n" },
        { text: "D", action: "exit" },
      ],
    });

    expect(result.text).toContain("*Stop*: my\\_\\[label\\]\\*");
    expect(result.text).toContain("📂 `projects/pigeon`");
    expect(result.replyMarkup.inline_keyboard[0]?.[0]?.callback_data).toBe("cmd:tok123:continue");
    expect(result.replyMarkup.inline_keyboard[1]?.[0]?.callback_data).toBe("cmd:tok123:exit");
  });
});

describe("TelegramNotificationService", () => {
  it("mints session token, sends telegram message, and stores reply mapping", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      label: "Test Session",
      cwd: "/tmp/demo",
    }, 1_000);

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage,
      "bot-token",
      "8248645256",
      () => 2_000,
      fetchMock,
    );

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-1",
        label: "Test Session",
        cwd: "/tmp/demo",
      },
      event: "Stop",
      summary: "All done",
    });

    expect(result.token).toBeTruthy();

    const tokenRecord = storage.sessionTokens.validate(result.token, "8248645256", 2_001);
    expect(tokenRecord?.sessionId).toBe("sess-1");

    const replyMapped = storage.replyTokens.lookup("8248645256", "1234", 2_001);
    expect(replyMapped).toBe(result.token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload.parse_mode).toBe("Markdown");
    expect(payload.chat_id).toBe("8248645256");

    storage.db.close();
  });
});

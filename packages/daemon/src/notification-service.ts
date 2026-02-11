import { randomBytes } from "node:crypto";
import type { StorageDb } from "./storage/database";

interface NotificationButton {
  text: string;
  action: string;
}

interface NotificationInput {
  event: string;
  label: string;
  summary: string;
  cwd: string | null;
  token: string;
  buttons: NotificationButton[];
}

interface SessionLike {
  sessionId: string;
  label: string | null;
  cwd: string | null;
}

interface StopNotificationInput {
  session: SessionLike;
  event: string;
  summary: string;
  label?: string;
}

interface NotificationResult {
  token: string;
}

export interface StopNotifier {
  sendStopNotification(input: StopNotificationInput): Promise<NotificationResult>;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]]/g, "\\$&");
}

function eventEmoji(event: string): string {
  if (event === "SubagentStop") return "🔧";
  if (event === "Notification") return "❓";
  return "🤖";
}

export function formatTelegramNotification(input: NotificationInput): {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";

  const text = [
    `${eventEmoji(input.event)} *${input.event}*: ${escapeMarkdown(input.label)}`,
    "",
    input.summary,
    "",
    `📂 \`${cwdShort}\``,
    "",
    "↩️ _Swipe-reply to respond_",
  ].join("\n");

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push(input.buttons.slice(0, 3).map((button) => ({
    text: button.text,
    callback_data: `cmd:${input.token}:${button.action}`,
  })));

  if (input.buttons.length > 3) {
    rows.push(input.buttons.slice(3).map((button) => ({
      text: button.text,
      callback_data: `cmd:${input.token}:${button.action}`,
    })));
  }

  return {
    text,
    replyMarkup: {
      inline_keyboard: rows,
    },
  };
}

function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

export class TelegramNotificationService implements StopNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly storage: StorageDb,
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly nowFn: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        event: input.event,
        summary: input.summary,
      },
    }, now);

    const buttons: NotificationButton[] = [
      { text: "▶️ Continue", action: "continue" },
      { text: "✅ Yes", action: "y" },
      { text: "❌ No", action: "n" },
      { text: "🛑 Exit", action: "exit" },
    ];

    const notification = formatTelegramNotification({
      event: input.event,
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      buttons,
    });

    const response = await this.fetchFn(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: notification.text,
        parse_mode: "Markdown",
        reply_markup: notification.replyMarkup,
      }),
    });

    const payload = await response.json() as { result?: { message_id?: number } };
    const messageId = payload?.result?.message_id;

    if (messageId) {
      this.storage.replyTokens.store(this.chatId, String(messageId), token, now);
    }

    return { token };
  }
}

/**
 * The daemon's ONE direct line to Slack (chat-transport phase 2, pigeon-4ogz.5; design
 * docs/plans/2026-11-20-slack-transport-design.md §6): the Slack twin of
 * `direct-telegram-alarm.ts`.
 *
 * Everything else the daemon sends to Slack goes through the worker. This exists for the same
 * reason the Telegram alarm does: the alarms that report a broken worker must still get out
 * while the worker is broken, so `AlertNotifier` uses it as the FALLBACK leg of an operational
 * alert. It posts to the incoming webhook of the machine's `#alerts`
 * (`PIGEON_SLACK_ALARM_WEBHOOK_URL`), which can post to that one channel only: a narrower
 * credential than the bot token the daemon holds for Telegram. A thread is therefore ignored, and
 * link buttons become `<url|label>` lines.
 *
 * It is the only file under `daemon/src` allowed to contain the webhook host; a guard test
 * enforces that, as it does `api.telegram.org` for the Telegram file.
 *
 * Pushes (D7, off by default): the owner is mentioned only when `PIGEON_SLACK_NOTIFY_OWNER=1`
 * and `PIGEON_SLACK_OWNER_USER_ID` is set. pigeon never emits a broadcast: `<` is escaped (so no
 * `<!channel>` can form) and a bare `@channel`/`@here`/`@everyone` gets a zero-width joiner.
 */

import { PLAIN_ALERT_TIMEOUT_MS, type AlertSeverity, type PlainAlertOptions } from "./notification-service";
import { severityPrefix } from "./direct-telegram-alarm";

const WEBHOOK_URL_RE = /^https:\/\/hooks\.slack\.com\/\S+$/;

/** A Slack incoming-webhook URL, or undefined for anything else (including ""). */
export function parseSlackWebhookUrl(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  return WEBHOOK_URL_RE.test(v) ? v : undefined;
}

/**
 * A failed webhook post. Deliberately NOT a `TelegramSendError`: the `/alert` ladder retries a
 * Telegram 400 without its buttons or topic, which changes nothing for a webhook that ignores
 * both.
 */
export class SlackWebhookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SlackWebhookError";
  }
}

export interface DirectSlackAlarmOptions {
  ownerUserId?: string;
  /** `PIGEON_SLACK_NOTIFY_OWNER=1`. Without it (the default) nothing mentions the owner. */
  notifyOwner?: boolean;
  fetchFn?: typeof fetch;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function defuseBroadcasts(text: string): string {
  return text.replace(/@(channel|here|everyone)\b/gi, "@\u200d$1");
}

/** `<url|label>` lines for url buttons. A url Slack's link syntax cannot carry is dropped. */
function linkLines(options: PlainAlertOptions | undefined): string {
  const rows = options?.replyMarkup?.inline_keyboard ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    for (const b of row) {
      if (typeof b?.url !== "string" || !/^https:\/\/[^\s|<>]+$/.test(b.url)) continue;
      const label = defuseBroadcasts(escapeMrkdwn(String(b.text ?? "").replace(/[|\n]/g, " ").trim())) || b.url;
      lines.push(`<${b.url}|${label}>`);
    }
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/** The webhook's `text`: mention (when enabled), severity prefix, escaped text, links. */
export function renderSlackAlarmText(
  text: string,
  severity: AlertSeverity,
  options: PlainAlertOptions | undefined,
  mentionUserId: string | undefined,
): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
  return `${mention}${severityPrefix(severity)}${defuseBroadcasts(escapeMrkdwn(text))}${linkLines(options)}`;
}

export class DirectSlackAlarm {
  private readonly fetchFn: typeof fetch;
  private readonly mention: string | undefined;

  constructor(
    private readonly webhookUrl: string,
    options: DirectSlackAlarmOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.mention = options.notifyOwner && options.ownerUserId ? options.ownerUserId : undefined;
  }

  /**
   * Bounded the same way as the Telegram alarm (pigeon-wfj1): the AbortSignal bounds a fetch
   * that honours it, and the raced deadline bounds one that does not, because the drainer and
   * the watchdog await this.
   */
  async sendPlainAlert(text: string, severity: AlertSeverity, options?: PlainAlertOptions): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? PLAIN_ALERT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Slack webhook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    deadline.catch(() => {});

    let response: Response;
    try {
      const inFlight = this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: renderSlackAlarmText(text, severity, options, this.mention),
          unfurl_links: false,
          unfurl_media: false,
        }),
        signal: controller.signal,
      });
      inFlight.catch(() => {});
      response = await Promise.race([inFlight, deadline]);
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Slack webhook timed out after ${timeoutMs}ms`);
      // The URL is a credential by itself: never put it (or a message that may contain it) in
      // the error.
      throw new Error(`Slack webhook failed: ${err instanceof Error ? err.name : "error"}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new SlackWebhookError(
        response.status,
        `Slack webhook returned ${response.status}${await readError(response)}`,
      );
    }
  }
}

/** Slack's error slug (`invalid_payload`, `no_service`, ...), bounded like the Telegram read. */
async function readError(response: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), 1_000);
      }),
    ]);
    const slug = text.trim();
    return /^[a-z_]{1,60}$/.test(slug) ? `: ${slug}` : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which direct alarm an operational alert falls back to (pigeon-4ogz.5; design
 * docs/plans/2026-11-20-slack-transport-design.md §6): Telegram's Bot API or Slack's `#alerts`
 * webhook, chosen PER ALERT from the machine's persisted `whoami.transport`, so a flip needs no
 * restart.
 *
 *  - transport `slack`: Slack, else Telegram if only that is configured.
 *  - transport `telegram`: Telegram, else Slack.
 *  - never answered yet: Telegram first, then Slack. The spec said Slack first, but devbox's
 *    daemon gets its webhook BEFORE it flips (bead note from pigeon-4ogz.15), and a worker-down
 *    alarm on a fresh start would then land in a Slack channel nobody watches yet.
 *
 * Either path is better than silence, which is why a transport with no path of its own uses the
 * other. A Slack conversation handle (or a `slack:` chat) is never handed to Telegram as a
 * thread: it means nothing there and would only produce a 400.
 */
import type { AlertSeverity, PlainAlertOptions } from "./notification-service";
import type { ChatTransportName } from "./chat-transport-state";

export interface DirectAlarm {
  sendPlainAlert(text: string, severity: AlertSeverity, options?: PlainAlertOptions): Promise<void>;
}

/** Slack conversation handles start here (worker `SLACK_HANDLE_MIN`, 2^40). */
export const SLACK_HANDLE_MIN = 2 ** 40;

export interface DirectAlarmDeps {
  telegram?: DirectAlarm;
  slack?: DirectAlarm;
  transport: () => ChatTransportName | undefined;
}

export function pickDirectAlarm(
  deps: Omit<DirectAlarmDeps, "transport">,
  transport: ChatTransportName | undefined,
): { name: ChatTransportName; alarm: DirectAlarm } | undefined {
  const order: ChatTransportName[] = transport === "slack" ? ["slack", "telegram"] : ["telegram", "slack"];
  for (const name of order) {
    const alarm = deps[name];
    if (alarm) return { name, alarm };
  }
  return undefined;
}

/** Undefined when neither path is configured. */
export function createDirectAlarm(deps: DirectAlarmDeps): DirectAlarm | undefined {
  if (!deps.telegram && !deps.slack) return undefined;
  return {
    sendPlainAlert(text, severity, options) {
      const picked = pickDirectAlarm(deps, deps.transport())!;
      if (picked.name === "telegram" && options && isSlackAddressed(options)) {
        const { messageThreadId: _thread, chatId: _chat, ...rest } = options;
        return picked.alarm.sendPlainAlert(text, severity, rest);
      }
      return picked.alarm.sendPlainAlert(text, severity, options);
    },
  };
}

function isSlackAddressed(options: PlainAlertOptions): boolean {
  return (
    (typeof options.chatId === "string" && options.chatId.startsWith("slack:")) ||
    (typeof options.messageThreadId === "number" && options.messageThreadId >= SLACK_HANDLE_MIN)
  );
}

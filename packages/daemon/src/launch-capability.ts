/**
 * Whether this daemon may receive remote launches (pigeon-k0qn.17), computed per poll from the
 * persisted `whoami.transport` (pigeon-4ogz.5, design §6), so a flip needs no restart.
 *
 * A receiver must be able to tell the human that something was launched, and to report its own
 * trouble while the worker is down, so it needs an alarm path for the transport it is on:
 *
 *  - Telegram (or no answer yet): the bot token and the chat id, as before.
 *  - Slack: the `#alerts` webhook. The bot token is no longer needed. The chat id still is,
 *    because the outbox and the alert notifier are built only when it is set (the worker
 *    ignores its value on a Slack machine); deleting Telegram (pigeon-4ogz.13) removes that.
 */
import type { ChatTransportName } from "./chat-transport-state";

export interface LaunchCapabilityInputs {
  remoteLaunchFrom: readonly string[];
  opencodeClient: boolean;
  remoteLaunchClient: boolean;
  telegramBotToken: boolean;
  telegramChatId: boolean;
  slackAlarmWebhook: boolean;
}

export function launchCapability(
  inputs: LaunchCapabilityInputs,
  transport: ChatTransportName | undefined,
): { capable: boolean; missing: string[] } {
  if (inputs.remoteLaunchFrom.length === 0) return { capable: false, missing: [] };
  const missing: string[] = [];
  if (!inputs.opencodeClient) missing.push("opencodeClient");
  if (transport === "slack") {
    if (!inputs.slackAlarmWebhook) missing.push("slackAlarmWebhookUrl");
    if (!inputs.telegramChatId) missing.push("telegramChatId");
  } else {
    if (!inputs.telegramBotToken) missing.push("telegramBotToken");
    if (!inputs.telegramChatId) missing.push("telegramChatId");
  }
  if (!inputs.remoteLaunchClient) missing.push("remoteLaunchClient");
  return { capable: missing.length === 0, missing };
}

/**
 * Whether this daemon may receive remote launches (pigeon-k0qn.17).
 *
 * A receiver must be able to tell the human that something was launched, and to report its own
 * trouble while the worker is down, so it needs the `#alerts` webhook as its direct alarm path
 * (pigeon-4ogz.5). It needs no chat id: the worker resolves every address itself, and the outbox
 * and alert notifier no longer depend on one (Telegram was deleted, pigeon-4ogz.13).
 */
export interface LaunchCapabilityInputs {
  remoteLaunchFrom: readonly string[];
  opencodeClient: boolean;
  remoteLaunchClient: boolean;
  slackAlarmWebhook: boolean;
}

export function launchCapability(inputs: LaunchCapabilityInputs): { capable: boolean; missing: string[] } {
  if (inputs.remoteLaunchFrom.length === 0) return { capable: false, missing: [] };
  const missing: string[] = [];
  if (!inputs.opencodeClient) missing.push("opencodeClient");
  if (!inputs.slackAlarmWebhook) missing.push("slackAlarmWebhookUrl");
  if (!inputs.remoteLaunchClient) missing.push("remoteLaunchClient");
  return { capable: missing.length === 0, missing };
}

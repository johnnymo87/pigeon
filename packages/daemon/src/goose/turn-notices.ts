import type { GooseTurnOrigin } from "./session-runner.js";

export function msgIdFromCommandId(commandId: string): string {
  return commandId.startsWith("swarm:") ? commandId.slice(6) : commandId;
}

export function recoveredBusyNotice(origin: GooseTurnOrigin, msgId: string): string {
  if (origin === "swarm") {
    return `a swarm message to this coordinator was not delivered (msg ${msgId}); goose was busy and nothing was resent.`;
  }
  return "your message was not delivered (goose was busy); nothing was resent — send it again.";
}

export function recoveryUnsupportedNotice(origin: GooseTurnOrigin, msgId: string): string {
  if (origin === "swarm") {
    return `pigeon restarted while goose was working on a swarm message (msg ${msgId}); can't safely collect the reply, nothing was resent`;
  }
  return "pigeon restarted while goose was working on this; can't safely collect the reply, nothing was resent — check the session / ask again";
}

export function resumeAdviceNotice(origin: GooseTurnOrigin, msgId: string, resent = false): string {
  const resendClause = resent ? "one resend was attempted" : "nothing was resent";
  if (origin === "swarm") {
    return `A swarm message (msg ${msgId}) may remain in the session's history with no reply, and ${resendClause}.`;
  }
  return (
    `Your message is still in the session's history with no reply, and ${resendClause}. `
    + "Replying (\"continue\" is enough) starts a fresh turn that sees that message but NOT what the "
    + "cancelled turn had already done -- so if it may have pushed, posted or sent something, say so, "
    + "or it may do it again."
  );
}

export function honkResumeAdviceNotice(origin: GooseTurnOrigin, msgId: string, resent = false): string {
  const resendClause = resent ? "one resend was attempted" : "nothing was resent";
  if (origin === "swarm") {
    return `A swarm message (msg ${msgId}) may remain in the session's history with no reply, and ${resendClause}. The turn may have finished in goose's history; the reply just wasn't collected.`;
  }
  return (
    `Your message is still in the session's history with no reply, and ${resendClause}. `
    + "The turn may have finished in goose's history; the reply just wasn't collected."
  );
}

export function queuedStaleNotice(origin: GooseTurnOrigin, msgId: string): string {
  if (origin === "swarm") {
    return `pigeon queued a swarm message (msg ${msgId}) more than 24h ago and never sent it; nothing was sent`;
  }
  return "pigeon queued this message more than 24h ago and never sent it; nothing was sent";
}

export function recoveryExhaustedNotice(origin: GooseTurnOrigin, msgId: string): string {
  if (origin === "swarm") {
    return `pigeon failed repeatedly while processing a swarm message (msg ${msgId}); giving up to prevent crash loop.`;
  }
  return "pigeon failed repeatedly while processing this turn; giving up to prevent crash loop. Check the session before resending.";
}

export function recoveryCutoffNotice(origin: GooseTurnOrigin, msgId: string): string {
  if (origin === "swarm") {
    return `pigeon was down too long (>6h) to safely collect the reply from honkd for swarm message (msg ${msgId}); nothing was resent.`;
  }
  return "pigeon was down too long (>6h) to safely collect the reply from honkd; nothing was resent. Check the session before asking again.";
}

import type { StorageDb } from "./storage/database";
import { PULL_UNACKED_ALERT_MS } from "./storage/pull-inbox-repo";
import { clampPreservingSurrogates } from "./text";
import {
  DELIVERY_FAILED_KIND,
  formatFailureNotice,
  type DeliveryEvidence,
} from "./swarm/notify-sender";
import { bankOrInsertSwarmMessage } from "./swarm/bank-or-insert";
import { makeMsgId } from "./ids";

/** How long an acked row is kept before reaping. Forensics only; nothing reads it. */
export const PULL_ACKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Enough of the message to recognise it in an alert, without pasting an essay into Telegram. */
const EXCERPT_CHARS = 200;

export interface PullInboxMaintenanceDeps {
  storage: StorageDb;
  nowFn?: () => number;
  unackedThresholdMs?: number;
  ackedRetentionMs?: number;
  log?: (msg: string) => void;
}

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARS
    ? `${clampPreservingSurrogates(text, EXCERPT_CHARS)}... [truncated]`
    : text;
}

/**
 * The two ways banked mail can be lost, each turned into something a human hears.
 *
 * BOTH ARE FAILURES OF SPEECH, NOT OF STORAGE. The message is gone either way;
 * the only question is whether anyone is told, and the ordinary notifier cannot
 * tell them: `notifySenderOfFailure` returns early for any sender that is not
 * `^ses_...`, which a Telegram-originated message never is. So this is the only
 * place either fact can be said, and a silent sweep here would recreate exactly
 * the silent drop the whole pull design exists to avoid.
 *
 *  - EXPIRED UNREAD: nobody came to collect within the TTL. The likely cause is
 *    the client being disabled or broken, which is precisely when the human is
 *    least likely to notice on their own.
 *  - CLAIMED BUT NEVER ACKED: the client took the payload and died before it
 *    could record it. The next drain re-serves the row, so this is not by itself
 *    a loss -- but a row that stays unacked across many drains means the client
 *    is failing in a loop, and that IS a loss the client cannot report about
 *    itself.
 *
 * Alerts are deduped on `ref_msg_id`, and the unacked one is additionally marked
 * durably on the row, because the alert table's own dedupe lasts only as long as
 * the alert row (sent alerts are reaped after an hour) and every in-memory dedupe
 * in this daemon dies with the process.
 */
export function runPullInboxMaintenance(deps: PullInboxMaintenanceDeps): void {
  const now = (deps.nowFn ?? Date.now)();
  const log = deps.log ?? ((msg: string) => console.log(`[pull-inbox] ${msg}`));
  const { storage } = deps;

  storage.pullInbox.sweepExpired(now, (row) => {
    if (row.source === "swarm") {
      // Loop guards: notify only real ses_ senders and never reply to a delivery.failed message.
      // Senders that are "pigeon" or non-ses_ are logged only with no notice and no human alert.
      const isSesSender = Boolean(row.senderId && /^ses_[A-Za-z0-9_-]+$/.test(row.senderId));
      const isDeliveryFailed = row.kind === DELIVERY_FAILED_KIND;

      if (isSesSender && !isDeliveryFailed) {
        // Honest evidence wording:
        // never collected => evidence "absent" ("never delivered and was NOT received ... safe to resend")
        // collected but unconfirmed => evidence "present" ("unconfirmed ... Do NOT resend")
        const evidence: DeliveryEvidence = row.claimCount > 0 ? "present" : "absent";
        const reason =
          row.claimCount === 0
            ? "expired in pull inbox without being collected"
            : `expired in pull inbox after ${row.claimCount} unconfirmed collection attempt(s)`;
        const payload = formatFailureNotice(
          { msgId: row.msgId, handedOffAt: row.claimedAt },
          row.sessionId,
          reason,
          evidence,
        );
        const noticeMsgId = makeMsgId();
        const result = bankOrInsertSwarmMessage(
          storage,
          {
            msgId: noticeMsgId,
            fromSession: "pigeon",
            toSession: row.senderId!,
            channel: null,
            kind: DELIVERY_FAILED_KIND,
            priority: "normal",
            replyTo: row.msgId,
            payload,
          },
          now,
        );
        if (result.status === "refused") {
          log(`expired swarm notice refused for ${row.senderId}: ${result.error}`);
        }
      }
      log(`expired unread msg=${row.msgId} session=${row.sessionId}`);
      return;
    }

    const label = storage.sessions.get(row.sessionId)?.label ?? row.sessionId;
    const ageHours = Math.round((now - row.createdAt) / 3_600_000);
    storage.alerts.enqueue({
      source: "pull-inbox-expired",
      refMsgId: `pull-expired:${row.msgId}`,
      severity: "warning",
      now,
      text:
        `A message banked for ${label} was never read and has now expired ` +
        `(banked ${ageHours}h ago, ${row.claimCount === 0 ? "never collected" : `collected ${row.claimCount}x but never confirmed`}).\n\n` +
        `${row.source}: ${excerpt(row.payload)}`,
    });
    log(`expired unread msg=${row.msgId} session=${row.sessionId}`);
  });

  const threshold = deps.unackedThresholdMs ?? PULL_UNACKED_ALERT_MS;
  for (const row of storage.pullInbox.listUnackedForAlert(now, threshold)) {
    const label = storage.sessions.get(row.sessionId)?.label ?? row.sessionId;
    storage.alerts.enqueue({
      source: "pull-inbox-unacked",
      refMsgId: `pull-unacked:${row.msgId}`,
      severity: "error",
      now,
      text:
        `${label} collected a banked message but never confirmed it reached the ` +
        `agent (claimed ${Math.round((now - (row.claimedAt ?? now)) / 60_000)} min ago, ` +
        `${row.claimCount} attempt(s)). It will be re-served on the next drain, ` +
        `but something is failing between collection and use.\n\n` +
        `${row.source}: ${excerpt(row.payload)}`,
    });
    log(`claimed but unacked msg=${row.msgId} session=${row.sessionId}`);
  }

  const reaped = storage.pullInbox.cleanupAcked(
    now - (deps.ackedRetentionMs ?? PULL_ACKED_RETENTION_MS),
  );
  if (reaped > 0) log(`reaped ${reaped} acked rows`);
}

import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import { excerptOf } from "../text";
import {
  displayName,
  formatSwarmNotification,
  formatSwarmCancelNotification,
} from "../notification-service";
import { splitTelegramMessage } from "../split-message";
import { shouldEmitAncillaryFor } from "../ancillary-gate";

export function enqueueSwarmTelegramNotice(
  storage: StorageDb,
  record: SwarmMessageRecord,
  now: number,
): void {
  try {
    if (!record.toSession) {
      console.log("[pigeon-daemon] swarm telegram notice skipped for channel broadcast", record.msgId);
      return;
    }

    // A session declared quiet suppresses its swarm feed too. lgtm re-prompts its
    // review sessions via /swarm/send on every reawaken, so without this the feed
    // reinstates exactly the noise the origin policy exists to remove -- and can
    // create the session's Telegram topic in the first place.
    if (!shouldEmitAncillaryFor(storage, record.toSession, now)) {
      console.log(
        `[swarm-notice] quieted msgId=${record.msgId} sessionId=${record.toSession} reason=origin`,
      );
      return;
    }

    const target = storage.sessions.get(record.toSession);
    const sender = storage.sessions.get(record.fromSession);

    const notification = formatSwarmNotification({
      kind: record.kind,
      priority: record.priority,
      fromLabel: displayName({
        title: sender?.title,
        label: sender?.label,
        sessionId: record.fromSession,
      }),
      toSessionId: record.toSession,
      msgId: record.msgId,
      payload: record.payload.toWellFormed(),
      createdAt: record.createdAt,
      deliverAt: record.deliverAt,
    });

    const chunks = splitTelegramMessage(
      notification.header,
      notification.body,
      notification.footer,
    );
    storage.outbox.upsert(
      {
        notificationId: `w:${record.msgId}`,
        sessionId: record.toSession,
        requestId: `swarm-${record.msgId}`,
        kind: "swarm",
        // A peer message is not presence, so the anchor is the RECIPIENT's own
        // last human turn -- the design is explicit that peer turns never anchor.
        anchorMsgId: target?.lastHumanMsgId ?? null,
        excerpt: excerptOf(record.payload),
        payload: JSON.stringify({
          messages: chunks.map((c) => ({ text: c.text, entities: c.entities })),
          replyMarkup: undefined,
          notificationId: `w:${record.msgId}`,
          title: target?.title ?? undefined,
          dir: target?.cwd ?? undefined,
          threaded: true,
        }),
        token: "",
      },
      now,
    );
  } catch (err) {
    console.error("[pigeon-daemon] swarm telegram notice failed", record.msgId, err);
  }
}

export function enqueueSwarmCancelNotice(
  storage: StorageDb,
  record: SwarmMessageRecord,
  now: number,
): void {
  try {
    if (!record.toSession) {
      console.log("[pigeon-daemon] swarm telegram cancel notice skipped for channel broadcast", record.msgId);
      return;
    }

    // A retraction follows the fate of the notice it retracts, NOT a fresh policy
    // read. If the original was posted and the session was quieted afterwards (or its
    // quiet TTL expired the other way), re-evaluating policy here would strand a live
    // "message dispatched" notice in the topic that can never be withdrawn. Absence of
    // the original is the only correct reason to stay silent.
    if (!storage.outbox.getByNotificationId(`w:${record.msgId}`)) {
      console.log(
        `[swarm-notice] cancel skipped msgId=${record.msgId} reason=original-not-posted`,
      );
      return;
    }

    const target = storage.sessions.get(record.toSession);

    const notification = formatSwarmCancelNotification({
      msgId: record.msgId,
      toSessionId: record.toSession,
    });

    const chunks = splitTelegramMessage(
      notification.header,
      notification.body,
      notification.footer,
    );
    storage.outbox.upsert(
      {
        notificationId: `wc:${record.msgId}`,
        sessionId: record.toSession,
        requestId: `swarm-cancel-${record.msgId}`,
        kind: "swarm",
        anchorMsgId: target?.lastHumanMsgId ?? null,
        // NO excerpt, deliberately. This notice says a message was RETRACTED;
        // record.payload is the withdrawn content, so showing it in the
        // drill-down would surface exactly what the reader is told to disregard.
        excerpt: null,
        payload: JSON.stringify({
          messages: chunks.map((c) => ({ text: c.text, entities: c.entities })),
          replyMarkup: undefined,
          notificationId: `wc:${record.msgId}`,
          title: target?.title ?? undefined,
          dir: target?.cwd ?? undefined,
          threaded: true,
        }),
        token: "",
      },
      now,
    );
  } catch (err) {
    console.error("[pigeon-daemon] swarm telegram cancel notice failed", record.msgId, err);
  }
}

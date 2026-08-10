import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import {
  displayName,
  formatSwarmNotification,
  formatSwarmCancelNotification,
} from "../notification-service";
import { splitTelegramMessage } from "../split-message";

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

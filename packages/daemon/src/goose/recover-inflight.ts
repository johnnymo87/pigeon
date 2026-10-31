import { GOOSE_BACKEND_KIND } from "./backend-kind.js";
import type { StorageDb } from "../storage/database.js";
import { GooseRunnerRegistry, GooseSessionRunner, gooseShutdownNotice, sanitiseIdPart } from "./session-runner.js";
import type { GooseInflightRecord } from "../storage/goose-inflight-repo.js";
import type { SessionRecord } from "../storage/types.js";
import type { SwarmSettleCallback } from "../swarm/swarm-settle.js";
import {
  msgIdFromCommandId,
  queuedStaleNotice,
  recoveryExhaustedNotice,
  recoveryCutoffNotice,
} from "./turn-notices.js";

export const DEFAULT_MAX_DOWNTIME_MS = 6 * 60 * 60 * 1000; // 6 hours (R1)
export const DEFAULT_STALE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 hours (R9)
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3; // Poison guard

export interface RecoverGooseTurnsOptions {
  storage: StorageDb;
  gooseRunners: GooseRunnerRegistry;
  onSwarmSettled?: SwarmSettleCallback;
  now?: number;
  maxDowntimeMs?: number;
  staleCutoffMs?: number;
  maxAttempts?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  postStop?: (body: Record<string, unknown>) => Promise<void>;
}

export async function recoverGooseTurns(opts: RecoverGooseTurnsOptions): Promise<void> {
  const now = opts.now ?? Date.now();
  const maxDowntimeMs = opts.maxDowntimeMs ?? DEFAULT_MAX_DOWNTIME_MS;
  const staleCutoffMs = opts.staleCutoffMs ?? DEFAULT_STALE_CUTOFF_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
  const log = opts.log ?? ((msg, fields) => console.log(`[goose-recover] ${msg}`, fields ?? ""));

  const allRows = opts.storage.gooseInflight.listAll();
  if (allRows.length === 0) return;

  log("recovering in-flight goose turns", { count: allRows.length });

  // Group rows per session, preserving oldest-first order (R5)
  const bySession = new Map<string, GooseInflightRecord[]>();
  for (const row of allRows) {
    const list = bySession.get(row.sessionId);
    if (list) {
      list.push(row);
    } else {
      bySession.set(row.sessionId, [row]);
    }
  }

  // Process rows per session oldest-first, one at a time (R5)
  for (const [sessionId, rows] of bySession) {
    void processSessionRows(sessionId, rows).catch((err) => {
      log("processSessionRows failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function processSessionRows(sessionId: string, rows: GooseInflightRecord[]): Promise<void> {
    const sentRows = rows.filter((r) => r.state === "sent");
    const queuedRows = rows.filter((r) => r.state === "queued");

    const session = opts.storage.sessions.get(sessionId);
    let runner: GooseSessionRunner | undefined;

    // Filter queued rows through checks (Item 5/9)
    const validQueuedRows: GooseInflightRecord[] = [];
    if (queuedRows.length > 0) {
      for (const row of queuedRows) {
        const commandId = row.commandId;
        const sanitisedCmd = sanitiseIdPart(commandId);
        const normalNotifId = `s:${sessionId}:${sanitisedCmd}`;
        const stalledNotifId = `s:${sessionId}:${sanitisedCmd}:stalled`;

        // Check 1: 24h stale check posts notice and deletes row
        if (now - row.createdAt > staleCutoffMs) {
          log("queued row older than 24h, posting stale notice and deleting", {
            commandId,
            sessionId,
            createdAt: row.createdAt,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "not_delivered",
              reason: "queued message older than 24h was never sent",
            });
          }
          if (session) {
            void sendPostStop(
              {
                session_id: sessionId,
                notification_id: normalNotifId,
                message: queuedStaleNotice(
                  commandId.startsWith("swarm:") ? "swarm" : "telegram",
                  msgIdFromCommandId(commandId),
                ),
                event: "Error",
                error_kind: "goose-queued-stale",
              },
              session,
            );
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 2: Session missing or not goose
        if (!session || session.backendKind !== GOOSE_BACKEND_KIND) {
          log("session missing or not goose, deleting queued row without notice", {
            commandId,
            sessionId,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "not_delivered",
              reason: "session missing or no longer goose backend",
            });
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 3: Outbox pre-check for s:sid:cmd and s:sid:cmd:stalled
        if (
          opts.storage.outbox.getByNotificationId(normalNotifId) ||
          opts.storage.outbox.getByNotificationId(stalledNotifId)
        ) {
          log("notification already in outbox, deleting queued row without enqueuing", {
            commandId,
            sessionId,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), { kind: "delivered" });
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        validQueuedRows.push(row);
      }
    }

    // Hand valid queued rows to runner up front and hold drain
    if (validQueuedRows.length > 0 && session && session.backendKind === GOOSE_BACKEND_KIND) {
      runner = opts.gooseRunners.get(session);
      runner.holdDrain();
      for (const row of validQueuedRows) {
        runner.enqueueRecovered(row);
      }
    }

    try {
      for (const row of sentRows) {
        const commandId = row.commandId;
        const sanitisedCmd = sanitiseIdPart(commandId);

        // Check 1: R9 - rows older than 24h deleted with log line, no notice
        if (now - row.createdAt > staleCutoffMs) {
          log("row older than 24h, deleting without notice (R9)", {
            commandId,
            sessionId,
            createdAt: row.createdAt,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "unconfirmed",
              reason: "turn was in flight more than 24h ago; not resumed",
            });
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 2: Session missing or not goose
        if (!session || session.backendKind !== GOOSE_BACKEND_KIND) {
          log("session missing or not goose, deleting row without notice", {
            commandId,
            sessionId,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "unconfirmed",
              reason: "session missing or no longer goose backend",
            });
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 3: Outbox pre-check for s:sid:cmd and s:sid:cmd:stalled
        const normalNotifId = `s:${sessionId}:${sanitisedCmd}`;
        const stalledNotifId = `s:${sessionId}:${sanitisedCmd}:stalled`;
        if (
          opts.storage.outbox.getByNotificationId(normalNotifId) ||
          opts.storage.outbox.getByNotificationId(stalledNotifId)
        ) {
          log("notification already in outbox, deleting row without resending", {
            commandId,
            sessionId,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), { kind: "delivered" });
          }
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 4: Attempts check (poison guard)
        // Attempts bumped only for rows without clean_suspend (crash)
        if (!row.cleanSuspend) {
          const attempts = opts.storage.gooseInflight.bumpAttempts(commandId, now);
          if (attempts > maxAttempts) {
            log("recovery attempts exceeded (>3), posting give-up notice", {
              commandId,
              sessionId,
              attempts,
            });
            if (commandId.startsWith("swarm:")) {
              opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
                kind: "unconfirmed",
                reason: "recovery attempts exceeded; giving up to prevent crash loop",
              });
            }
            void sendPostStop(
              {
                session_id: sessionId,
                notification_id: normalNotifId,
                message: recoveryExhaustedNotice(
                  commandId.startsWith("swarm:") ? "swarm" : "telegram",
                  msgIdFromCommandId(commandId),
                ),
                event: "Error",
                error_kind: "goose-recovery-exhausted",
              },
              session,
            );
            opts.storage.gooseInflight.delete(commandId);
            opts.storage.inbox.markDone(commandId);
            continue;
          }
        }

        // Check 5: Bare goose (is_honk = 0)
        if (!row.isHonk) {
          log("bare goose turn cancelled by restart, posting notice", {
            commandId,
            sessionId,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "unconfirmed",
              reason: "bare goose turn cancelled by restart",
            });
          }
          void sendPostStop(
            {
              session_id: sessionId,
              notification_id: normalNotifId,
              message: gooseShutdownNotice(sessionId, false),
              event: "Error",
              error_kind: "goose-turn-cancelled-by-restart",
            },
            session,
          );
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 6: Downtime cutoff (R1)
        if (now - row.lastAliveAt > maxDowntimeMs) {
          log("downtime cutoff exceeded (>6h), posting cutoff notice", {
            commandId,
            sessionId,
            lastAliveAt: row.lastAliveAt,
          });
          if (commandId.startsWith("swarm:")) {
            opts.onSwarmSettled?.(msgIdFromCommandId(commandId), {
              kind: "unconfirmed",
              reason: "pigeon was down too long (>6h) to safely collect the reply from honkd",
            });
          }
          void sendPostStop(
            {
              session_id: sessionId,
              notification_id: normalNotifId,
              message: recoveryCutoffNotice(
                commandId.startsWith("swarm:") ? "swarm" : "telegram",
                msgIdFromCommandId(commandId),
              ),
              event: "Error",
              error_kind: "goose-recovery-cutoff",
            },
            session,
          );
          opts.storage.gooseInflight.delete(commandId);
          opts.storage.inbox.markDone(commandId);
          continue;
        }

        // Check 7: Valid honk row to resume!
        if (!runner && session) {
          runner = opts.gooseRunners.get(session);
        }
        if (!runner) continue;

        // Wait while the runner is busy before resuming this row
        while (runner.isBusy()) {
          await runner.settled();
        }

        const resumed = runner.resume(row);
        if (resumed) {
          // Wait for turn to settle before processing any subsequent row for the same session (R5)
          await runner.settled().finally(() => {
            opts.storage.inbox.markDone(commandId);
          });
        }
      }
    } finally {
      runner?.releaseDrain();
    }
  }

  async function sendPostStop(body: Record<string, unknown>, session: SessionRecord): Promise<void> {
    try {
      if (opts.postStop) {
        await opts.postStop(body);
      } else {
        const runner = opts.gooseRunners.get(session);
        await runner.postNotice(body);
      }
    } catch (err) {
      log("sendPostStop failed", {
        notificationId: body.notification_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

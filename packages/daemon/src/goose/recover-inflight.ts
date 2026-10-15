import { GOOSE_BACKEND_KIND } from "./backend-kind.js";
import type { StorageDb } from "../storage/database.js";
import { GooseRunnerRegistry, GooseSessionRunner, gooseShutdownNotice, sanitiseIdPart } from "./session-runner.js";
import type { GooseInflightRecord } from "../storage/goose-inflight-repo.js";
import type { SessionRecord } from "../storage/types.js";

export const DEFAULT_MAX_DOWNTIME_MS = 6 * 60 * 60 * 1000; // 6 hours (R1)
export const DEFAULT_STALE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 hours (R9)
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3; // Poison guard

export interface RecoverGooseTurnsOptions {
  storage: StorageDb;
  gooseRunners: GooseRunnerRegistry;
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
    for (const row of rows) {
      const commandId = row.commandId;
      const sanitisedCmd = sanitiseIdPart(commandId);

      // Check 1: R9 - rows older than 24h deleted with log line, no notice
      if (now - row.createdAt > staleCutoffMs) {
        log("row older than 24h, deleting without notice (R9)", {
          commandId,
          sessionId,
          createdAt: row.createdAt,
        });
        opts.storage.gooseInflight.delete(commandId);
        opts.storage.inbox.markDone(commandId);
        continue;
      }

      // Check 2: Session missing or not goose
      const session = opts.storage.sessions.get(sessionId);
      if (!session || session.backendKind !== GOOSE_BACKEND_KIND) {
        log("session missing or not goose, deleting row without notice", {
          commandId,
          sessionId,
        });
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
          void sendPostStop(
            {
              session_id: sessionId,
              notification_id: normalNotifId,
              message:
                "pigeon failed repeatedly while processing this turn; giving up to prevent crash loop. Check the session before resending.",
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
        void sendPostStop(
          {
            session_id: sessionId,
            notification_id: normalNotifId,
            message:
              "pigeon was down too long (>6h) to safely collect the reply from honkd; nothing was resent. Check the session before asking again.",
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
      const runner = opts.gooseRunners.get(session);

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

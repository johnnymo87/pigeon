/**
 * OutboxSender — background loop that reads queued outbox entries and delivers
 * them to the worker (Telegram) via sendNotification.
 *
 * Runs on a 5s interval alongside the Poller. Implements retry with backoff
 * and terminal failure on max attempts or max age.
 */

import type { StorageDb } from "../storage/database";

export type SendNotificationFn = (
  sessionId: string,
  chatId: string,
  text: string,
  replyMarkup: unknown,
  media?: unknown,
  notificationId?: string,
  entities?: unknown[],
) => Promise<{ ok: boolean; retryAfter?: number }>;

export type LogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface OutboxSenderOptions {
  storage: StorageDb;
  sendNotification: SendNotificationFn;
  chatId?: string;
  nowFn?: () => number;
  log?: LogFn;
}

const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_SCHEDULE = [5_000, 10_000, 30_000, 60_000, 120_000];

function getBackoff(attempts: number): number {
  return BACKOFF_SCHEDULE[Math.min(attempts, BACKOFF_SCHEDULE.length - 1)] ?? BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] ?? 120_000;
}

/**
 * Per-chunk idempotency key. The LAST chunk keeps the bare notificationId
 * because handleEditNotification (the multi-question wizard) looks messages up
 * by exactly that id, and it is the chunk that carries reply_markup.
 * Earlier chunks get a "#c{i}" suffix so worker-side dedup can suppress them
 * on retry. See webhook.ts question-id parsing, which strips this suffix.
 */
export function chunkNotificationId(
  notificationId: string | undefined,
  index: number,
  isLast: boolean,
): string | undefined {
  if (!notificationId) return undefined;
  return isLast ? notificationId : `${notificationId}#c${index}`;
}

export class OutboxSender {
  private readonly storage: StorageDb;
  private readonly sendNotification: SendNotificationFn;
  private readonly chatId: string | undefined;
  private readonly nowFn: () => number;
  private readonly log: LogFn;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  /**
   * Timestamp (ms) until which outbox delivery is paused due to rate limiting.
   * Kept in-memory: if daemon restarts mid-pause, state is self-healing as the
   * next delivery attempt will receive another 429 and re-establish pausedUntil.
   */
  private pausedUntil = 0;

  constructor(opts: OutboxSenderOptions) {
    this.storage = opts.storage;
    this.sendNotification = opts.sendNotification;
    this.chatId = opts.chatId;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log = opts.log ?? ((msg, fields) => {
      if (fields) {
        console.log(`[outbox-sender] ${msg}`, fields);
      } else {
        console.log(`[outbox-sender] ${msg}`);
      }
    });
  }

  /** Start the background delivery loop. */
  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => {
      void this.processOnce();
    }, intervalMs);
  }

  /** Stop the background delivery loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process one batch of ready outbox entries. Public for testing. */
  async processOnce(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      if (!this.chatId) {
        return;
      }

      const now = this.nowFn();
      if (this.pausedUntil > 0) {
        if (now < this.pausedUntil) {
          return;
        }
        this.log("outbox rate-limit pause ended, resuming delivery", {
          now,
          wasPausedUntil: this.pausedUntil,
        });
        this.pausedUntil = 0;
      }

      const entries = this.storage.outbox.getReady(now, 5);

      batchLoop: for (const entry of entries) {
        const age = now - entry.createdAt;

        // Check terminal conditions
        if (entry.attempts >= MAX_ATTEMPTS || age > MAX_AGE_MS) {
          this.storage.outbox.markFailed(entry.notificationId, now);
          this.log("outbox entry marked failed (terminal)", {
            notificationId: entry.notificationId,
            sessionId: entry.sessionId,
            attempts: entry.attempts,
            ageMs: age,
          });
          continue;
        }

        // Parse payload
        let messages: Array<{ text: string; entities?: unknown[] }>;
        let replyMarkup: unknown;
        let notificationId: string | undefined;
        try {
          const parsed = JSON.parse(entry.payload) as {
            messages?: Array<{ text: string; entities?: unknown[] }>;
            message?: { text: string; entities?: unknown[] };
            replyMarkup: unknown;
            notificationId?: string;
          };
          messages = parsed.messages ?? (parsed.message ? [parsed.message] : []);
          replyMarkup = parsed.replyMarkup;
          notificationId = parsed.notificationId;
        } catch (err) {
          this.log("outbox entry payload parse failed", {
            notificationId: entry.notificationId,
            err: err instanceof Error ? err.message : String(err),
          });
          this.storage.outbox.markFailed(entry.notificationId, now);
          continue;
        }

        if (messages.length === 0) {
          this.storage.outbox.markFailed(entry.notificationId, now);
          continue;
        }

        // Attempt delivery — send each chunk
        try {
          let allOk = true;
          for (let i = 0; i < messages.length; i++) {
            const isLast = i === messages.length - 1;
            const msg = messages[i]!;
            const result = await this.sendNotification(
              entry.sessionId,
              this.chatId,
              msg.text,
              isLast ? replyMarkup : { inline_keyboard: [] },
              undefined,
              chunkNotificationId(notificationId, i, isLast),
              msg.entities,
            );

            if (!result.ok) {
              allOk = false;
              const backoff = getBackoff(entry.attempts);
              this.storage.outbox.markRetry(entry.notificationId, now, backoff);
              this.log("outbox entry delivery failed, scheduling retry", {
                notificationId: entry.notificationId,
                sessionId: entry.sessionId,
                attempts: entry.attempts + 1,
                nextRetryIn: backoff,
              });
              if (result.retryAfter !== undefined) {
                this.pausedUntil = now + result.retryAfter * 1000;
                this.log("outbox paused due to rate limit", {
                  notificationId: entry.notificationId,
                  retryAfterSec: result.retryAfter,
                  pausedUntil: this.pausedUntil,
                });
                break batchLoop;
              }
              break;
            }
          }

          if (allOk) {
            this.storage.outbox.markSent(entry.notificationId, now);
            this.log("outbox entry sent", {
              notificationId: entry.notificationId,
              sessionId: entry.sessionId,
              chunks: messages.length,
            });
          }
        } catch (err) {
          const backoff = getBackoff(entry.attempts);
          this.storage.outbox.markRetry(entry.notificationId, now, backoff);
          this.log("outbox entry delivery threw, scheduling retry", {
            notificationId: entry.notificationId,
            sessionId: entry.sessionId,
            attempts: entry.attempts + 1,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

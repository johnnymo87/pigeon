/**
 * Retention for `slack_posts` (bead pigeon-4ogz.3). A row is the handle a later edit (the question
 * wizard) needs to find a post's channel and ts, so it is useful for minutes. 30 days is far
 * past any edit and keeps the table (and its AUTOINCREMENT counter) from growing without bound.
 *
 * Run from the hourly cron, best-effort: this is a janitor, so a missing table (schema not applied
 * yet) or a D1 error is logged and never propagates to the other cron jobs.
 */
import type { D1Database } from "@cloudflare/workers-types";

export const SLACK_POST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows deleted per tick at most, so one tick's write volume stays bounded after a long gap. */
export const SLACK_POST_SWEEP_CAP = 5000;

export interface SlackPostSweepOptions {
  now?: number;
  ttlMs?: number;
  cap?: number;
}

/**
 * Deletes up to `cap` posts older than `ttlMs`. The seed row (`team_id = '_seed'`, `created_at = 0`)
 * is never touched: it pins AUTOINCREMENT above 2^40 so handles never collide with Telegram ids.
 * Returns the number deleted, 0 on any failure.
 */
export async function sweepSlackPosts(db: D1Database, opts: SlackPostSweepOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.ttlMs ?? SLACK_POST_TTL_MS);
  const cap = opts.cap ?? SLACK_POST_SWEEP_CAP;
  try {
    const res = await db
      .prepare(
        `DELETE FROM slack_posts WHERE handle IN (
           SELECT handle FROM slack_posts WHERE created_at < ? AND team_id != '_seed' ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(cutoff, cap)
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    console.error("[worker] slack_posts retention sweep failed", { error: String(err) });
    return 0;
  }
}

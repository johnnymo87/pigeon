import type BetterSqlite3 from "better-sqlite3";
import { INJECTED_PROMPTS_TTL_MS } from "./injected-prompts-schema";

export class InjectedPromptsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  record(sessionId: string, textHash: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO injected_prompts (session_id, text_hash, count, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(session_id, text_hash) DO UPDATE SET
           count = count + 1,
           created_at = excluded.created_at`,
      )
      .run(sessionId, textHash, now);
  }

  consume(sessionId: string, textHash: string, now: number = Date.now()): boolean {
    const cutoff = now - INJECTED_PROMPTS_TTL_MS;
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT count, created_at FROM injected_prompts WHERE session_id = ? AND text_hash = ?",
        )
        .get(sessionId, textHash) as { count: number; created_at: number } | undefined;

      if (!row) {
        return false;
      }

      if (row.created_at < cutoff || row.count <= 0) {
        return false;
      }

      if (row.count > 1) {
        this.db
          .prepare(
            "UPDATE injected_prompts SET count = count - 1 WHERE session_id = ? AND text_hash = ?",
          )
          .run(sessionId, textHash);
      } else {
        this.db
          .prepare(
            "DELETE FROM injected_prompts WHERE session_id = ? AND text_hash = ?",
          )
          .run(sessionId, textHash);
      }

      return true;
    })();
  }

  has(sessionId: string, textHash: string, now: number = Date.now()): boolean {
    const cutoff = now - INJECTED_PROMPTS_TTL_MS;
    const row = this.db
      .prepare(
        "SELECT 1 FROM injected_prompts WHERE session_id = ? AND text_hash = ? AND count > 0 AND created_at >= ?",
      )
      .get(sessionId, textHash, cutoff);
    return !!row;
  }

  cleanupExpired(now: number = Date.now()): number {
    const cutoff = now - INJECTED_PROMPTS_TTL_MS;
    const result = this.db
      .prepare("DELETE FROM injected_prompts WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }
}

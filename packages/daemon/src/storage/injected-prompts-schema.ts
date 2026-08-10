import type BetterSqlite3 from "better-sqlite3";

export const INJECTED_PROMPTS_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function initInjectedPromptsSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS injected_prompts (
      session_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, text_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_injected_prompts_created_at
      ON injected_prompts(created_at);
  `);
}

import type BetterSqlite3 from "better-sqlite3";

export interface GooseInflightRecord {
  commandId: string;
  sessionId: string;
  backendSessionId: string;
  isHonk: boolean;
  promptText: string;
  recoveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  lastAliveAt: number;
  cleanSuspend: boolean;
}

export interface InsertGooseInflightInput {
  commandId: string;
  sessionId: string;
  backendSessionId: string;
  isHonk: boolean;
  promptText: string;
  recoveryAttempts?: number;
  createdAt?: number;
  updatedAt?: number;
  lastAliveAt?: number;
  cleanSuspend?: boolean;
}

export interface GooseInflightStore {
  insert(input: InsertGooseInflightInput, now?: number): void;
  delete(commandId: string): boolean;
  listAll(): GooseInflightRecord[];
  touchAlive(commandId: string, now?: number): void;
  markSuspended(commandId: string, now?: number): void;
  bumpAttempts(commandId: string, now?: number): number;
  get(commandId: string): GooseInflightRecord | undefined;
}

interface GooseInflightDbRow {
  command_id: string;
  session_id: string;
  backend_session_id: string;
  is_honk: number;
  prompt_text: string;
  recovery_attempts: number;
  created_at: number;
  updated_at: number;
  last_alive_at: number;
  clean_suspend: number;
}

function toRecord(row: GooseInflightDbRow): GooseInflightRecord {
  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    backendSessionId: row.backend_session_id,
    isHonk: row.is_honk === 1,
    promptText: row.prompt_text,
    recoveryAttempts: row.recovery_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAliveAt: row.last_alive_at,
    cleanSuspend: row.clean_suspend === 1,
  };
}

export class GooseInflightRepository implements GooseInflightStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  insert(input: InsertGooseInflightInput, now: number = Date.now()): void {
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const lastAliveAt = input.lastAliveAt ?? now;
    const recoveryAttempts = input.recoveryAttempts ?? 0;
    const cleanSuspend = input.cleanSuspend ? 1 : 0;
    const isHonk = input.isHonk ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO goose_inflight_turns (
          command_id,
          session_id,
          backend_session_id,
          is_honk,
          prompt_text,
          recovery_attempts,
          created_at,
          updated_at,
          last_alive_at,
          clean_suspend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.commandId,
        input.sessionId,
        input.backendSessionId,
        isHonk,
        input.promptText,
        recoveryAttempts,
        createdAt,
        updatedAt,
        lastAliveAt,
        cleanSuspend,
      );
  }

  delete(commandId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM goose_inflight_turns WHERE command_id = ?")
      .run(commandId);
    return result.changes > 0;
  }

  get(commandId: string): GooseInflightRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT command_id, session_id, backend_session_id, is_honk, prompt_text,
                recovery_attempts, created_at, updated_at, last_alive_at, clean_suspend
         FROM goose_inflight_turns WHERE command_id = ?`,
      )
      .get(commandId) as GooseInflightDbRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listAll(): GooseInflightRecord[] {
    const rows = this.db
      .prepare(
        `SELECT command_id, session_id, backend_session_id, is_honk, prompt_text,
                recovery_attempts, created_at, updated_at, last_alive_at, clean_suspend
         FROM goose_inflight_turns
         ORDER BY created_at ASC, command_id ASC`,
      )
      .all() as GooseInflightDbRow[];
    return rows.map(toRecord);
  }

  touchAlive(commandId: string, now: number = Date.now()): void {
    this.db
      .prepare(
        "UPDATE goose_inflight_turns SET last_alive_at = ?, updated_at = ? WHERE command_id = ?",
      )
      .run(now, now, commandId);
  }

  markSuspended(commandId: string, now: number = Date.now()): void {
    this.db
      .prepare(
        "UPDATE goose_inflight_turns SET clean_suspend = 1, last_alive_at = ?, updated_at = ?, recovery_attempts = 0 WHERE command_id = ?",
      )
      .run(now, now, commandId);
  }

  bumpAttempts(commandId: string, now: number = Date.now()): number {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE goose_inflight_turns SET recovery_attempts = recovery_attempts + 1, updated_at = ? WHERE command_id = ?",
        )
        .run(now, commandId);
      const row = this.db
        .prepare("SELECT recovery_attempts FROM goose_inflight_turns WHERE command_id = ?")
        .get(commandId) as { recovery_attempts: number } | undefined;
      return row?.recovery_attempts ?? 0;
    })();
  }
}

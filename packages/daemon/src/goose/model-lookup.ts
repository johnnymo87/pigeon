/**
 * Read-only lookup of the model a goose session used on its latest turn.
 *
 * Neither goose ACP `usage_update` nor honkd's `turn.ended` event carries the
 * model name today. Goose writes every non-compaction LLM call's actual model
 * into `usage_ledger` in `~/.local/share/goose/sessions/sessions.db` (WAL mode,
 * indexed by `session_id`), and also stores the session's configured model in
 * `sessions.model_config_json`.
 *
 * We prefer `usage_ledger` (reflects mid-session model switches such as the
 * Opus/Neon switch) and fall back to `sessions.model_config_json.model_name`
 * when no ledger row exists yet. Every failure returns `undefined` so a missing
 * or locked DB never affects notification delivery.
 */

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import path from "node:path";

const loggedErrors = new Set<string>();

function warnOnce(key: string, message: string, err: unknown): void {
  if (loggedErrors.has(key)) return;
  loggedErrors.add(key);
  console.warn(`[goose-model-lookup] ${message}:`, err instanceof Error ? err.message : String(err));
}

export function defaultGooseSessionsDbPath(): string {
  const override = process.env.PIGEON_GOOSE_SESSIONS_DB?.trim();
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
  return path.join(dataHome, "goose", "sessions", "sessions.db");
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function lookupGooseSessionModel(
  backendSessionId: string,
  dbPath: string = defaultGooseSessionsDbPath(),
): string | undefined {
  const sid = nonEmptyTrimmed(backendSessionId);
  if (!sid) return undefined;

  let db: BetterSqlite3.Database | undefined;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 100");

    // 1. Actual model from the latest non-compaction LLM call in usage_ledger.
    try {
      const ledgerRow = db
        .prepare(
          "SELECT model FROM usage_ledger " +
            "WHERE session_id = ? AND is_compaction = 0 AND model IS NOT NULL AND trim(model) != '' " +
            "ORDER BY id DESC LIMIT 1",
        )
        .get(sid) as { model?: unknown } | undefined;
      const fromLedger = nonEmptyTrimmed(ledgerRow?.model);
      if (fromLedger) return fromLedger;
    } catch {
      // Older goose schema without usage_ledger — fall through to sessions table.
    }

    // 2. Fallback: session's configured model_name in sessions.model_config_json.
    const sessionRow = db
      .prepare("SELECT model_config_json FROM sessions WHERE id = ?")
      .get(sid) as { model_config_json?: unknown } | undefined;
    if (typeof sessionRow?.model_config_json === "string" && sessionRow.model_config_json.length > 0) {
      try {
        const parsed = JSON.parse(sessionRow.model_config_json) as { model_name?: unknown };
        const fromConfig = nonEmptyTrimmed(parsed?.model_name);
        if (fromConfig) return fromConfig;
      } catch {
        // Malformed JSON — fail open.
      }
    }

    return undefined;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "ERR";
    warnOnce(`${dbPath}:${code}`, `failed to read ${dbPath}`, err);
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close error
    }
  }
}

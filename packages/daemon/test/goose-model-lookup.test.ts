import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lookupGooseSessionModel } from "../src/goose/model-lookup";

describe("lookupGooseSessionModel", () => {
  const tmpDirs: string[] = [];

  function makeDb(initSql?: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "pigeon-goose-model-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "sessions.db");
    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    if (initSql) {
      db.exec(initSql);
    } else {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          model_config_json TEXT
        );
        CREATE TABLE usage_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          model TEXT,
          is_compaction INTEGER DEFAULT 0
        );
      `);
    }
    db.close();
    return dbPath;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns the latest non-compaction model from usage_ledger (reflecting mid-session switches)", () => {
    const dbPath = makeDb();
    const db = new BetterSqlite3(dbPath);
    db.prepare("INSERT INTO sessions (id, model_config_json) VALUES (?, ?)").run(
      "20261125_1",
      JSON.stringify({ model_name: "claude-opus-5-5" }),
    );
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_1",
      "claude-opus-5-5",
      0,
    );
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_1",
      "gemini-4-neon",
      0,
    );
    // Compaction row after the turn should be ignored
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_1",
      "claude-haiku-5-5",
      1,
    );
    db.close();

    expect(lookupGooseSessionModel("20261125_1", dbPath)).toBe("gemini-4-neon");
  });

  it("skips null or empty usage_ledger.model rows and uses the previous valid row", () => {
    const dbPath = makeDb();
    const db = new BetterSqlite3(dbPath);
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_2",
      "claude-opus-5-5",
      0,
    );
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_2",
      null,
      0,
    );
    db.prepare("INSERT INTO usage_ledger (session_id, model, is_compaction) VALUES (?, ?, ?)").run(
      "20261125_2",
      "   ",
      0,
    );
    db.close();

    expect(lookupGooseSessionModel("20261125_2", dbPath)).toBe("claude-opus-5-5");
  });

  it("falls back to sessions.model_config_json when usage_ledger has no rows for the session", () => {
    const dbPath = makeDb();
    const db = new BetterSqlite3(dbPath);
    db.prepare("INSERT INTO sessions (id, model_config_json) VALUES (?, ?)").run(
      "20261125_3",
      JSON.stringify({ model_name: "gemini-4-neon", reasoning: true }),
    );
    db.close();

    expect(lookupGooseSessionModel("20261125_3", dbPath)).toBe("gemini-4-neon");
  });

  it("falls back to sessions.model_config_json when usage_ledger table does not exist", () => {
    const dbPath = makeDb(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model_config_json TEXT
      );
    `);
    const db = new BetterSqlite3(dbPath);
    db.prepare("INSERT INTO sessions (id, model_config_json) VALUES (?, ?)").run(
      "20261125_4",
      JSON.stringify({ model_name: "claude-opus-5-5" }),
    );
    db.close();

    expect(lookupGooseSessionModel("20261125_4", dbPath)).toBe("claude-opus-5-5");
  });

  it("returns undefined for unknown session, missing DB, empty id, or malformed JSON", () => {
    const dbPath = makeDb();
    const db = new BetterSqlite3(dbPath);
    db.prepare("INSERT INTO sessions (id, model_config_json) VALUES (?, ?)").run(
      "20261125_bad",
      "{not json",
    );
    db.close();

    expect(lookupGooseSessionModel("20261125_missing", dbPath)).toBeUndefined();
    expect(lookupGooseSessionModel("20261125_bad", dbPath)).toBeUndefined();
    expect(lookupGooseSessionModel("", dbPath)).toBeUndefined();
    expect(lookupGooseSessionModel("20261125_1", path.join(tmpdir(), "nonexistent-goose-sessions.db"))).toBeUndefined();
  });
});

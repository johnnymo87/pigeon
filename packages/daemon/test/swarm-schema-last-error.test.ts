import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initSwarmSchema } from "../src/storage/swarm-schema";

describe("swarm schema: last_error migration", () => {
  it("adds last_error to a database created before the column existed, keeping rows", () => {
    const db = new Database(":memory:");
    // The pre-column shape: everything up to verify_family, no last_error.
    db.exec(`
      CREATE TABLE swarm_messages (
        msg_id TEXT PRIMARY KEY, from_session TEXT NOT NULL, to_session TEXT,
        channel TEXT, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
        reply_to TEXT, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        handed_off_at INTEGER, verified_at INTEGER,
        requeue_count INTEGER NOT NULL DEFAULT 0, aborted_at INTEGER,
        deliver_at INTEGER, expires_at INTEGER, cancelled_at INTEGER, ref TEXT,
        nudge_count INTEGER NOT NULL DEFAULT 0, verify_family TEXT
      );
      INSERT INTO swarm_messages (msg_id, from_session, kind, payload, created_at, updated_at)
      VALUES ('m_old', 'ses_a', 'chat', 'hi', 1, 1);
    `);

    initSwarmSchema(db);

    const cols = (db.pragma("table_info(swarm_messages)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("last_error");
    const row = db.prepare("SELECT last_error FROM swarm_messages WHERE msg_id = 'm_old'").get() as {
      last_error: string | null;
    };
    expect(row.last_error).toBeNull();
  });
});

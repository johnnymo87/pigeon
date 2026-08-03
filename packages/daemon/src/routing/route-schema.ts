import type BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";

export const ROUTING_SCHEMA_VERSION = 1;

/**
 * ── `session_assignment.last_active_at` IS MISNAMED, AND CANNOT BE RENAMED ────
 *
 * The column records when a session was last PLACED onto a serve. It is written
 * only by `RouteRepo.upsert` (sole caller: `Router.placeSession`), and because
 * placement happens only when `resolveRoute` finds no live lease, its recency is
 * anti-correlated with activity: a busy session holds a serve-renewed lease, never
 * re-places, and keeps a stale timestamp forever. Deriving "active" from it reads 0
 * for the busiest serve in the pool — which is exactly what happened, and cost an
 * entire memory investigation that was filed against an "idle" serve serving 602
 * requests from 5 sessions.
 *
 * The TypeScript field is therefore `AssignmentRecord.lastPlacedAt`. The COLUMN
 * keeps the wrong name on purpose: this string is sha256'd into
 * `routing_meta.ddl_checksum` (below), and every serve validates that digest against
 * a constant compiled into opencode-patched. Renaming the column — or editing any
 * byte of this string, including adding a SQL comment inside it — forks the checksum
 * and crash-loops the entire serve pool until a lockstep opencode-patched release
 * ships. See the schema-safety note in `reassignment-repo.ts`.
 *
 * For a real activity signal read `session_lease` (rows with `lease_expires_at >
 * now`), which the serve renews for the duration of every turn and releases when the
 * turn ends.
 */
export const ROUTING_DDL = `
  CREATE TABLE IF NOT EXISTS serve_instance (
    serve_id       TEXT PRIMARY KEY,
    instance_uuid  TEXT NOT NULL,
    endpoint       TEXT NOT NULL,
    binary_epoch   INTEGER NOT NULL DEFAULT 0,
    health_state   TEXT NOT NULL DEFAULT 'unknown',  -- healthy | unhealthy | unknown
    heartbeat_at   INTEGER NOT NULL,
    draining       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_assignment (
    session_id        TEXT PRIMARY KEY,
    directory_key     TEXT,
    desired_serve_id  TEXT NOT NULL,
    owner_generation  INTEGER NOT NULL DEFAULT 1,
    state             TEXT NOT NULL DEFAULT 'assigned', -- assigned|draining|dormant|migrating
    last_active_at    INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assignment_serve ON session_assignment(desired_serve_id, state);

  CREATE TABLE IF NOT EXISTS session_lease (
    session_id        TEXT PRIMARY KEY,
    serve_id          TEXT NOT NULL,
    instance_uuid     TEXT NOT NULL,
    owner_generation  INTEGER NOT NULL,
    lease_expires_at  INTEGER NOT NULL,
    heartbeat_at      INTEGER NOT NULL,
    binary_epoch      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_lease_serve ON session_lease(serve_id);
  CREATE INDEX IF NOT EXISTS idx_lease_expiry ON session_lease(lease_expires_at);

  CREATE TABLE IF NOT EXISTS routing_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    ddl_checksum   TEXT NOT NULL,
    binary_epoch   INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
`;

export function initRouteSchema(db: BetterSqlite3.Database): void {
  db.exec(ROUTING_DDL);

  const checksum = createHash("sha256").update(ROUTING_DDL).digest("hex");

  db.prepare(`
    INSERT OR IGNORE INTO routing_meta (id, schema_version, ddl_checksum, binary_epoch, updated_at)
    VALUES (1, ?, ?, 0, ?)
  `).run(ROUTING_SCHEMA_VERSION, checksum, Date.now());
}

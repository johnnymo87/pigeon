/**
 * Pigeon's teardown for an opencode session its backend has deleted (pigeon-4ogz.21).
 *
 * A session deleted in the opencode TUI used to keep its daemon row: the plugin's
 * `session.deleted` handler cleared only its own state, so the session's topic (or Slack
 * channel) stayed open until the 7-day reaper and the next daily close window. The plugin now
 * reports the delete (`POST /session-deleted`) and this decides whether to act on it.
 *
 * Two rules make that safe:
 *
 * - **Only an opencode row that is not pinned is torn down.** The plugin speaks for opencode
 *   sessions only; a goose row (`goose-acp`, `goose-pull`) or a row bound to a named topic is
 *   never touched by this route, whatever id it is handed.
 * - **A `/kill` in flight for the session owns the teardown.** `/kill` deletes the session in
 *   opencode, which fires `session.deleted`, and the plugin's report can arrive before the kill
 *   has posted its reply. Tearing down then would archive a Slack channel under the reply. So the
 *   report is deferred to the kill, and run once the kill finishes only if the kill left the row
 *   behind (its delete call failed though opencode had in fact deleted the session).
 */

export interface SessionGoneRow {
  backendKind: string | null;
  boundTopicKey?: string | null;
}

export type BackendDeletedOutcome =
  /** Row removed, routing dropped, worker unregistered with an immediate topic close. */
  | "torn_down"
  /** No row: a subagent, a session from another daemon, or one already torn down. */
  | "absent"
  /** A row this route must not touch (goose, or pinned to a named topic). */
  | "refused"
  /** A /kill for the session is in flight; it tears down, or this runs after it. */
  | "deferred"
  /** The teardown threw. Logged; the reaper collects the row later. */
  | "teardown_failed";

export interface SessionGoneDeps {
  getSession: (sessionId: string) => SessionGoneRow | null;
  /** Deletes the row and runs the explicit-delete teardown (`onSessionDeleted` in index.ts). */
  teardown: (sessionId: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Backend kinds this route may tear down. A NULL kind is a legacy opencode row. */
const OPENCODE_KINDS = new Set<string | null>([null, "opencode-plugin-direct"]);

export class SessionGone {
  private readonly kills = new Map<string, number>();
  private readonly deferred = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SessionGoneDeps) {
    this.log = deps.log ?? ((message) => console.log(`[session-gone] ${message}`));
  }

  /** Runs a /kill for `sessionId` with the guard held, so a concurrent report defers to it. */
  async runKill<T>(sessionId: string, kill: () => Promise<T>): Promise<T> {
    this.kills.set(sessionId, (this.kills.get(sessionId) ?? 0) + 1);
    try {
      return await kill();
    } finally {
      const left = (this.kills.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        this.kills.set(sessionId, left);
      } else {
        this.kills.delete(sessionId);
        if (this.deferred.delete(sessionId)) {
          // Never throws: the caller is the kill path, whose ack must not be skipped.
          await this.backendDeleted(sessionId);
        }
      }
    }
  }

  /** The backend reports `sessionId` deleted. Never throws. */
  async backendDeleted(sessionId: string): Promise<BackendDeletedOutcome> {
    const row = this.deps.getSession(sessionId);
    if (!row) return "absent";
    if (!OPENCODE_KINDS.has(row.backendKind) || row.boundTopicKey) {
      this.log(`not tearing down ${sessionId}: backend_kind=${row.backendKind ?? "null"} bound=${row.boundTopicKey ? "yes" : "no"}`);
      return "refused";
    }
    if (this.kills.has(sessionId)) {
      this.deferred.add(sessionId);
      this.log(`deferring teardown of ${sessionId} to the /kill in flight`);
      return "deferred";
    }
    try {
      await this.deps.teardown(sessionId);
      this.log(`tore down ${sessionId}: deleted in its backend`);
      return "torn_down";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`teardown of ${sessionId} failed: ${message}`);
      return "teardown_failed";
    }
  }
}

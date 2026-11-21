/**
 * Which chat transport the worker says this machine is on (`GET /whoami` `transport`,
 * chat-transport phase 2, pigeon-4ogz.5; design docs/plans/2026-11-20-slack-transport-design.md
 * §1, §6).
 *
 * The worker decides where every notification goes; the daemon needs the answer for three
 * things only: which direct alarm to use, which markdown dialect to write, and whether it is
 * launch-capable. So the rules are about not guessing:
 *
 *  - A `machine` answer sets the transport: `transport: "slack"` means Slack, its absence in a
 *    200 means Telegram (the worker adds the field only for a machine on Slack). A `shared`
 *    answer is Telegram: the shared key never reaches Slack.
 *  - Any answer that is not an answer (`rejected`, `unsupported`, `unknown`) keeps the last
 *    value. It never "assumes Telegram", because the worker being unreachable is exactly when
 *    the alarm path matters.
 *  - The value is persisted, so a restart during a worker outage keeps it. Before the first
 *    answer ever, `get()` is undefined and each caller decides what that means.
 *
 * Refreshed every 60 s, so a flip (`scripts/slack-flip.ts`) needs no daemon restart.
 */
import type BetterSqlite3 from "better-sqlite3";
import type { WorkerIdentity } from "./worker/poller";

export type ChatTransportName = "telegram" | "slack";

export const TRANSPORT_REFRESH_MS = 60_000;
const KEY = "whoami.transport";

export function initDaemonKvSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** The transport an identity answer establishes, or undefined when it establishes nothing. */
export function transportOf(identity: WorkerIdentity): ChatTransportName | undefined {
  if (identity.kind === "machine") return identity.transport === "slack" ? "slack" : "telegram";
  if (identity.kind === "shared") return "telegram";
  return undefined;
}

export interface ChatTransportStateDeps {
  db: BetterSqlite3.Database;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

export class ChatTransportState {
  private current: ChatTransportName | undefined;
  private readonly nowFn: () => number;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: ChatTransportStateDeps) {
    initDaemonKvSchema(deps.db);
    this.nowFn = deps.nowFn ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.log(m));
    const row = deps.db.prepare("SELECT value FROM daemon_kv WHERE key = ?").get(KEY) as
      | { value: string }
      | undefined;
    this.current = row?.value === "slack" || row?.value === "telegram" ? row.value : undefined;
  }

  /** The last transport the worker reported, or undefined when it never has. */
  get(): ChatTransportName | undefined {
    return this.current;
  }

  /** Feed one `whoami` answer. Returns the transport after it. Never throws. */
  observe(identity: WorkerIdentity): ChatTransportName | undefined {
    const next = transportOf(identity);
    if (next === undefined || next === this.current) return this.current;
    const previous = this.current;
    this.current = next;
    try {
      this.deps.db
        .prepare(
          `INSERT INTO daemon_kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(KEY, next, this.nowFn());
    } catch (err) {
      // Memory still has it; the next restart re-learns it from the worker.
      this.log(`[chat-transport] could not persist transport=${next}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.log(`[chat-transport] transport=${next}${previous ? ` (was ${previous})` : ""}`);
    return next;
  }

  /** Re-ask the worker every `intervalMs` (the first call is the caller's). */
  start(whoami: () => Promise<WorkerIdentity>, intervalMs = TRANSPORT_REFRESH_MS): void {
    this.stop();
    this.timer = setInterval(() => {
      void whoami().then(
        (identity) => this.observe(identity),
        () => undefined,
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

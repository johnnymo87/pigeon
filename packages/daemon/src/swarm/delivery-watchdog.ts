import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import type { StopNotifier, AlertSeverity } from "../notification-service";
import { notifySenderOfFailure } from "./notify-sender";

/**
 * The delivery watchdog verifies that a message the arbiter marked
 * `handed_off` (2xx from `prompt_async`) actually caused an assistant run to
 * start. A serve can accept the HTTP request while its runner is wedged
 * behind an unrelated in-flight turn — the user row lands in the transcript,
 * but nobody ever reads it. This module periodically re-checks unverified
 * handoffs and escalates: alert -> abort the blocking turn + redeliver ->
 * terminal failure (after a bounded number of recovery attempts).
 */

// ---------------------------------------------------------------------------
// Injected client contract
// ---------------------------------------------------------------------------

/** True when `kind === "wake"` or `kind.startsWith("wake.")`. */
export function isWakeKind(kind: string): boolean {
  return kind === "wake" || kind.startsWith("wake.");
}

/** The subset of OpencodeClient the watchdog needs. */
export interface WatchdogClient {
  getSessionMessages(sessionId: string): Promise<unknown[]>;
  abortSession(sessionId: string): Promise<void>;
}

/**
 * Result of resolving the healthy opencode-serve clients relevant to a
 * session. `preferred` is used for the primary transcript read (and the
 * TOCTOU re-read before acting); `all` is the full healthy set, used for
 * second-opinion reads (a different client than `preferred`) and for
 * broadcasting an abort. Either may be empty/undefined when no healthy serve
 * is currently known for the session.
 */
export interface ClientSet {
  preferred: WatchdogClient | undefined;
  all: WatchdogClient[];
}

export type ResolveClientsFn = (sessionId: string) => ClientSet;

/** Optional — callers that don't wire a notifier simply get no alerts. */
export type DeliveryWatchdogNotifier = Pick<StopNotifier, "sendPlainAlert">;

export type WatchdogLogger = (
  msg: string,
  fields?: Record<string, unknown>,
) => void;

// ---------------------------------------------------------------------------
// Config knobs (env wiring is a follow-up task; these are just defaults)
// ---------------------------------------------------------------------------

/** WATCHDOG_INTERVAL_MS */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
/** VERIFY_AFTER_MS */
export const DEFAULT_VERIFY_AFTER_MS = 300_000;
/** STUCK_ALERT_MS */
export const DEFAULT_STUCK_ALERT_MS = 900_000;
/** STUCK_ABORT_SILENCE_MS */
export const DEFAULT_STUCK_ABORT_SILENCE_MS = 3_600_000;
/** MAX_REQUEUES */
export const DEFAULT_MAX_REQUEUES = 3;

/** Delay before a watchdog-initiated redelivery is retried by the arbiter. */
const RECOVERY_REQUEUE_DELAY_MS = 5_000;

export interface DeliveryWatchdogOptions {
  storage: StorageDb;
  resolveClients: ResolveClientsFn;
  notifier?: DeliveryWatchdogNotifier;
  nowFn?: () => number;
  log?: WatchdogLogger;
  intervalMs?: number;
  verifyAfterMs?: number;
  stuckAlertMs?: number;
  stuckAbortSilenceMs?: number;
  maxRequeues?: number;
}

export interface CycleSummary {
  verified: number;
  requeued: number;
  alerted: number;
  aborted: number;
  terminal: number;
  skipped: number;
  /** True when this call coalesced into an already-running cycle and did no work. */
  coalesced: boolean;
  /** Set when the cycle threw and was caught at the top level; counts above
   *  reflect only whatever partial progress happened before the throw. */
  error?: string;
}

function emptySummary(coalesced = false): CycleSummary {
  return {
    verified: 0,
    requeued: 0,
    alerted: 0,
    aborted: 0,
    terminal: 0,
    skipped: 0,
    coalesced,
  };
}

/** Render a millisecond duration as a short human-readable string
 *  ("45s", "62min") for alert bodies. Raw ms is still logged alongside it. */
function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (Math.abs(seconds) < 60) return `${Math.round(seconds)}s`;
  const minutes = ms / 60_000;
  return `${Math.round(minutes)}min`;
}

// ---------------------------------------------------------------------------
// Transcript parsing
//
// Shape follows opencode's GET /session/:id/message (MessageV2.WithParts):
// each entry is `{ info: Message, parts: Part[] }`. `info.time.created` is
// always present; `info.time.completed` is set once the run finishes.
// Text/reasoning parts carry `time.start`/`time.end` directly; tool parts
// carry it nested under `state.time`.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface ParsedMessage {
  role: string;
  created: number;
  completed: number | null;
  hasError: boolean;
  parts: unknown[];
}

function parseMessage(raw: unknown): ParsedMessage | null {
  if (!isObject(raw)) return null;
  const info = raw.info;
  if (!isObject(info)) return null;
  const role = info.role;
  if (typeof role !== "string") return null;

  const time = info.time;
  const created =
    isObject(time) && typeof time.created === "number" ? time.created : 0;
  const completed =
    isObject(time) && typeof time.completed === "number" ? time.completed : null;
  const hasError = info.error !== undefined && info.error !== null;
  const parts = Array.isArray(raw.parts) ? raw.parts : [];

  return { role, created, completed, hasError, parts };
}

function messageText(msg: ParsedMessage): string {
  const chunks: string[] = [];
  for (const part of msg.parts) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

/**
 * Latest `time.created` among user messages whose rendered text contains the
 * exact attribute `msg_id="<id>"`. Redelivery writes a duplicate user row;
 * we anchor verification on the newest one. Deliberately a plain substring
 * match on the attribute form so `reply_to="<id>"` mentions never match.
 */
function findAnchor(messages: ParsedMessage[], msgId: string): number | null {
  const needle = `msg_id="${msgId}"`;
  let anchor: number | null = null;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!messageText(m).includes(needle)) continue;
    if (anchor === null || m.created > anchor) anchor = m.created;
  }
  return anchor;
}

/**
 * Evidence that our run started/ran: a clean-completed assistant message, or
 * an in-flight assistant message, strictly after `anchor`. A completed
 * assistant message WITH an error is not evidence — it falls through to the
 * stuck rules (something else may still be blocking our prompt).
 */
function findVerificationEvidence(
  messages: ParsedMessage[],
  anchor: number,
): boolean {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.created <= anchor) continue;
    if (m.completed === null) return true; // in-flight, serving our prompt right now
    if (!m.hasError) return true; // ran clean
  }
  return false;
}

/**
 * The in-flight assistant turn that started before our anchor and is still
 * running — i.e. the turn blocking our prompt from ever being read.
 */
function findBlockingInFlight(
  messages: ParsedMessage[],
  anchor: number,
): ParsedMessage | null {
  let blocking: ParsedMessage | null = null;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.completed !== null) continue;
    if (m.created >= anchor) continue;
    if (blocking === null || m.created > blocking.created) blocking = m;
  }
  return blocking;
}

function partTimestamps(part: unknown): number[] {
  if (!isObject(part)) return [];
  const ts: number[] = [];
  if (part.type === "text" || part.type === "reasoning") {
    const time = part.time;
    if (isObject(time)) {
      if (typeof time.start === "number") ts.push(time.start);
      if (typeof time.end === "number") ts.push(time.end);
    }
  } else if (part.type === "tool") {
    const state = part.state;
    if (isObject(state)) {
      const time = state.time;
      if (isObject(time)) {
        if (typeof time.start === "number") ts.push(time.start);
        if (typeof time.end === "number") ts.push(time.end);
      }
    }
  }
  return ts;
}

/** Newest part timestamp on the message; falls back to the message's own
 *  `time.created` when no part carries a timestamp. */
function lastActivityOf(msg: ParsedMessage): number {
  let max: number | null = null;
  for (const part of msg.parts) {
    for (const t of partTimestamps(part)) {
      if (max === null || t > max) max = t;
    }
  }
  return max ?? msg.created;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

interface FetchOk {
  ok: true;
  messages: ParsedMessage[];
}
interface FetchErr {
  ok: false;
  status: number | null;
  error: Error;
}
type FetchResult = FetchOk | FetchErr;

/** OpencodeClient throws `getSessionMessages failed (<status>): <body>` on
 *  any non-2xx response — pull the status back out of that message. */
function extractStatus(err: unknown): number | null {
  if (err instanceof Error) {
    const m = err.message.match(/\((\d+)\)/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function fetchTranscript(
  client: WatchdogClient,
  sessionId: string,
): Promise<FetchResult> {
  try {
    const raw = await client.getSessionMessages(sessionId);
    const messages = (Array.isArray(raw) ? raw : [])
      .map(parseMessage)
      .filter((m): m is ParsedMessage => m !== null);
    return { ok: true, messages };
  } catch (err) {
    return {
      ok: false,
      status: extractStatus(err),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class DeliveryWatchdog {
  private readonly storage: StorageDb;
  private readonly resolveClients: ResolveClientsFn;
  private readonly notifier: DeliveryWatchdogNotifier | undefined;
  private readonly nowFn: () => number;
  private readonly log: WatchdogLogger;
  private readonly verifyAfterMs: number;
  private readonly stuckAlertMs: number;
  private readonly stuckAbortSilenceMs: number;
  private readonly maxRequeues: number;

  // Dedupe: msg_id -> the stuck-behind-blocking-turn warn has already fired
  // for this handoff episode. Pruned when the message verifies or goes
  // terminal (a fresh redelivery gets its own alert budget).
  private readonly stuckAlerted = new Set<string>();
  // Dedupe: msg_id -> the no-healthy-serve age alarm has already fired.
  private readonly ageAlarmed = new Set<string>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly intervalMs: number;

  constructor(opts: DeliveryWatchdogOptions) {
    this.storage = opts.storage;
    this.resolveClients = opts.resolveClients;
    this.notifier = opts.notifier;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log =
      opts.log ?? ((m, f) => console.log(`[delivery-watchdog] ${m}`, f ?? ""));
    this.intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.verifyAfterMs = opts.verifyAfterMs ?? DEFAULT_VERIFY_AFTER_MS;
    this.stuckAlertMs = opts.stuckAlertMs ?? DEFAULT_STUCK_ALERT_MS;
    this.stuckAbortSilenceMs =
      opts.stuckAbortSilenceMs ?? DEFAULT_STUCK_ABORT_SILENCE_MS;
    this.maxRequeues = opts.maxRequeues ?? DEFAULT_MAX_REQUEUES;
  }

  start(intervalMs = this.intervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce();
    }, intervalMs);
    // Matches the other background loops in index.ts (sweepTimer,
    // selfLivenessTimer): don't let this interval alone keep the process
    // alive on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processOnce(): Promise<CycleSummary> {
    if (this.processing) {
      return emptySummary(true);
    }
    this.processing = true;
    try {
      return await this.runCycle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("cycle error", { error: message });
      return { ...emptySummary(), error: message };
    } finally {
      this.processing = false;
    }
  }

  private async alert(severity: AlertSeverity, text: string): Promise<void> {
    if (!this.notifier?.sendPlainAlert) return;
    try {
      await this.notifier.sendPlainAlert(text, severity);
    } catch (err) {
      this.log("alert send failed", { error: String(err) });
    }
  }

  private pruneDedupe(msgId: string): void {
    this.stuckAlerted.delete(msgId);
    this.ageAlarmed.delete(msgId);
  }

  /**
   * Reconcile the in-memory dedupe Sets against this cycle's eligible-row
   * snapshot, dropping any entry whose msgId is no longer present.
   *
   * Why this is safe: `stuckAlerted`/`ageAlarmed` are only ever populated for
   * a msgId that appeared in `listUnverifiedHandedOff` at alert time. Given
   * fixed `state`/`verified_at`/`handed_off_at`, that query's eligibility
   * (`handed_off_at < now - verifyAfterMs`) only becomes MORE true as `now`
   * advances — so a row that was once eligible stays eligible on every
   * subsequent cycle until one of three things happens: (a) it verifies,
   * (b) it goes terminal, or (c) its `state` moves away from `handed_off`
   * (redelivery via `requeueForRecovery`, which resets `handed_off_at` on
   * the next `markHandedOff`). Paths (a) and (b) already call
   * `pruneDedupe` explicitly. Path (c) currently does NOT prune explicitly
   * on a successful abort+requeue — but that's fine (arguably correct):
   * the row is temporarily absent from the eligible set only for the brief
   * window between the abort's requeue and the arbiter's redelivery, and
   * per the class-level doc comment a fresh redelivery is meant to get its
   * own alert budget anyway, so reconciling it away here just makes that
   * intent actually happen.
   *
   * The remaining case — and the bug this exists to fix — is the row being
   * deleted out from under us by the 7-day `cleanupOlderThan` retention
   * sweep without ever resolving through (a) or (b). That leaves a
   * dedupe entry with no corresponding row at all, and reconciling against
   * "not in this cycle's eligible set" catches it the same way.
   *
   * Rows that are alive but simply too young (handed_off more recently than
   * `verifyAfterMs`) were never alerted in the first place — they can't be
   * in these Sets — so they can't be spuriously pruned here.
   */
  private reconcileDedupe(eligibleIds: ReadonlySet<string>): void {
    for (const msgId of this.stuckAlerted) {
      if (!eligibleIds.has(msgId)) this.stuckAlerted.delete(msgId);
    }
    for (const msgId of this.ageAlarmed) {
      if (!eligibleIds.has(msgId)) this.ageAlarmed.delete(msgId);
    }
  }

  private async runCycle(): Promise<CycleSummary> {
    const now = this.nowFn();
    const counts = emptySummary();
    const rows = this.storage.swarm.listUnverifiedHandedOff(
      now,
      this.verifyAfterMs,
    );

    this.reconcileDedupe(new Set(rows.map((r) => r.msgId)));

    const bySession = new Map<string, SwarmMessageRecord[]>();
    for (const row of rows) {
      const target = row.toSession;
      if (!target) continue;
      const list = bySession.get(target) ?? [];
      list.push(row);
      bySession.set(target, list);
    }

    for (const [sessionId, sessionRows] of bySession) {
      try {
        await this.processSession(sessionId, sessionRows, now, counts);
      } catch (err) {
        // A single session's resolveClients/fetch/etc. blowing up must not
        // abort the whole cycle — every other session's rows still deserve
        // a chance to verify/requeue/abort this cycle. Isolate the failure
        // to this session's rows (counted as skipped) and keep going.
        const message = err instanceof Error ? err.message : String(err);
        this.log("session error", { sessionId, error: message });
        counts.skipped += sessionRows.length;
      }
    }

    this.log("cycle complete", { ...counts });
    return counts;
  }

  private async processSession(
    sessionId: string,
    rows: SwarmMessageRecord[],
    now: number,
    counts: CycleSummary,
  ): Promise<void> {
    const clients = this.resolveClients(sessionId);
    let readClient = clients.preferred ?? clients.all[0];

    if (!readClient) {
      for (const row of rows) {
        counts.skipped++;
        this.log("skipped", {
          msgId: row.msgId,
          sessionId,
          reason: "no-healthy-serve",
        });
        const age = now - (row.handedOffAt ?? now);
        if (age > this.stuckAbortSilenceMs && !this.ageAlarmed.has(row.msgId)) {
          this.ageAlarmed.add(row.msgId);
          counts.alerted++;
          await this.alert(
            "warning",
            `delivery watchdog: msg ${row.msgId} to ${sessionId} unverified for ${age}ms (${humanDuration(age)}) — no healthy serve available to check it`,
          );
          this.log("alerted", {
            msgId: row.msgId,
            sessionId,
            reason: "no-healthy-serve-age",
          });
        }
      }
      return;
    }

    const initial = await fetchTranscript(readClient, sessionId);
    let messages: ParsedMessage[];

    if (!initial.ok) {
      if (initial.status === 404) {
        const alt = clients.all.find((c) => c !== readClient);
        if (!alt) {
          for (const row of rows) {
            counts.skipped++;
            this.log("skipped", {
              msgId: row.msgId,
              sessionId,
              reason: "404-no-second-opinion-client",
            });
          }
          return;
        }

        const second = await fetchTranscript(alt, sessionId);
        if (second.ok) {
          // Contradicted — the "gone" serve was wrong. Proceed with the
          // second opinion's transcript, and adopt `alt` as the read client
          // for the rest of this session's processing (the TOCTOU refetch
          // in attemptAbort included) — otherwise every subsequent refetch
          // keeps hitting the 404-ing client and abort escalation stalls
          // forever via "toctou-refetch-failed".
          messages = second.messages;
          readClient = alt;
        } else if (second.status === 404) {
          // Confirmed — the session is truly gone.
          for (const row of rows) {
            this.storage.swarm.markFailed(row.msgId, now);
            counts.terminal++;
            this.pruneDedupe(row.msgId);
            await this.alert(
              "error",
              `delivery watchdog: session ${sessionId} no longer exists on opencode-serve; msg ${row.msgId} cannot be verified — marking failed`,
            );
            notifySenderOfFailure(
              this.storage,
              row,
              `session ${sessionId} no longer exists`,
              now,
            );
            this.log("terminal", {
              msgId: row.msgId,
              sessionId,
              reason: "session-deleted-confirmed",
            });
          }
          return;
        } else {
          // Second opinion errored too (network/5xx) — can't confirm or
          // deny. Skip this cycle, no counter bumps.
          for (const row of rows) {
            counts.skipped++;
            this.log("skipped", {
              msgId: row.msgId,
              sessionId,
              reason: "404-second-opinion-errored",
            });
          }
          return;
        }
      } else {
        // 5xx/network error — skip this cycle entirely, no counter bumps.
        for (const row of rows) {
          counts.skipped++;
          this.log("skipped", {
            msgId: row.msgId,
            sessionId,
            reason: "fetch-error",
          });
        }
        return;
      }
    } else {
      messages = initial.messages;
    }

    let interventionUsed = false;
    for (const row of rows) {
      const used = await this.evaluateRow(
        row,
        messages,
        sessionId,
        readClient,
        clients,
        now,
        counts,
        interventionUsed,
      );
      if (used) interventionUsed = true;
    }
  }

  /** Shared skip block for every "we already used this cycle's one
   *  intervention (requeue/abort/terminal) on another row for this
   *  session" fallthrough. Always returns `false` (no intervention used). */
  private skipInterventionBudgetUsed(
    row: SwarmMessageRecord,
    sessionId: string,
    counts: CycleSummary,
  ): boolean {
    counts.skipped++;
    this.log("skipped", {
      msgId: row.msgId,
      sessionId,
      reason: "intervention-budget-used",
    });
    return false;
  }

  private async evaluateRow(
    row: SwarmMessageRecord,
    messages: ParsedMessage[],
    sessionId: string,
    readClient: WatchdogClient,
    clients: ClientSet,
    now: number,
    counts: CycleSummary,
    interventionAlreadyUsed: boolean,
  ): Promise<boolean> {
    const anchor = findAnchor(messages, row.msgId);

    if (anchor === null) {
      // The 2xx lied (or the write was lost) — our prompt never made it
      // into the transcript at all.
      if (isWakeKind(row.kind)) {
        const blockedAge = now - (row.handedOffAt ?? now);
        if (blockedAge > this.stuckAlertMs && !this.stuckAlerted.has(row.msgId)) {
          this.stuckAlerted.add(row.msgId);
          counts.alerted++;
          await this.alert(
            "warning",
            `delivery watchdog: wake msg ${row.msgId} to ${sessionId} handed off ${blockedAge}ms (${humanDuration(blockedAge)}) ago and remains unverified (expected for idle target)`,
          );
          this.log("alerted", {
            msgId: row.msgId,
            sessionId,
            reason: "idle-wake-unverified",
          });
        }
        counts.skipped++;
        this.log("skipped", {
          msgId: row.msgId,
          sessionId,
          reason: "wake-suppress-requeue",
        });
        return false;
      }
      if (interventionAlreadyUsed) {
        return this.skipInterventionBudgetUsed(row, sessionId, counts);
      }
      return this.requeueOrTerminal(
        row,
        sessionId,
        now,
        counts,
        "delivery write repeatedly lost",
      );
    }

    if (findVerificationEvidence(messages, anchor)) {
      this.storage.swarm.markVerified(row.msgId, now);
      this.pruneDedupe(row.msgId);
      counts.verified++;
      this.log("verified", { msgId: row.msgId, sessionId });
      return false;
    }

    const blocking = findBlockingInFlight(messages, anchor);
    if (!blocking) {
      // Session is idle — our prompt is sitting there but nothing ever ran
      // it. Nothing to abort.
      if (isWakeKind(row.kind)) {
        const blockedAge = now - (row.handedOffAt ?? now);
        if (blockedAge > this.stuckAlertMs && !this.stuckAlerted.has(row.msgId)) {
          this.stuckAlerted.add(row.msgId);
          counts.alerted++;
          await this.alert(
            "warning",
            `delivery watchdog: wake msg ${row.msgId} to ${sessionId} handed off ${blockedAge}ms (${humanDuration(blockedAge)}) ago and remains unverified (expected for idle target)`,
          );
          this.log("alerted", {
            msgId: row.msgId,
            sessionId,
            reason: "idle-wake-unverified",
          });
        }
        counts.skipped++;
        this.log("skipped", {
          msgId: row.msgId,
          sessionId,
          reason: "wake-suppress-requeue",
        });
        return false;
      }
      if (interventionAlreadyUsed) {
        return this.skipInterventionBudgetUsed(row, sessionId, counts);
      }
      return this.requeueOrTerminal(
        row,
        sessionId,
        now,
        counts,
        "session idle — our prompt never ran",
      );
    }

    if (row.abortedAt !== null) {
      if (isWakeKind(row.kind)) {
        counts.skipped++;
        this.log("skipped", {
          msgId: row.msgId,
          sessionId,
          reason: "wake-suppress-stuck-after-recovery",
        });
        return false;
      }
      // We already used our one recovery attempt (abort+redeliver) for this
      // message, and after redelivery it's stuck again. Give up.
      if (interventionAlreadyUsed) {
        return this.skipInterventionBudgetUsed(row, sessionId, counts);
      }
      this.storage.swarm.markFailed(row.msgId, now);
      counts.terminal++;
      this.pruneDedupe(row.msgId);
      await this.alert(
        "error",
        `delivery watchdog: msg ${row.msgId} to ${sessionId} stuck again after abort+redeliver recovery — giving up`,
      );
      notifySenderOfFailure(
        this.storage,
        row,
        "stuck again after abort+redeliver recovery attempt",
        now,
      );
      this.log("terminal", {
        msgId: row.msgId,
        sessionId,
        reason: "stuck-after-recovery",
      });
      return true;
    }

    const lastActivity = lastActivityOf(blocking);
    const blockedAge = now - (row.handedOffAt ?? now);
    const silence = now - lastActivity;

    if (blockedAge > this.stuckAlertMs && !this.stuckAlerted.has(row.msgId)) {
      this.stuckAlerted.add(row.msgId);
      counts.alerted++;
      const fresh = silence <= this.stuckAbortSilenceMs;
      const label = fresh ? "ACTIVE" : "SILENT";
      await this.alert(
        "warning",
        `delivery watchdog: msg ${row.msgId} to ${sessionId} queued behind ${label} turn — blocked ${blockedAge}ms (${humanDuration(blockedAge)}), turn silent ${silence}ms (${humanDuration(silence)})`,
      );
      this.log("alerted", {
        msgId: row.msgId,
        sessionId,
        reason: `queued-behind-${label.toLowerCase()}-turn`,
      });
    }

    if (silence <= this.stuckAbortSilenceMs) {
      counts.skipped++;
      this.log("skipped", { msgId: row.msgId, sessionId, reason: "waiting" });
      return false;
    }

    if (isWakeKind(row.kind)) {
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "wake-suppress-abort",
      });
      return false;
    }

    if (interventionAlreadyUsed) {
      return this.skipInterventionBudgetUsed(row, sessionId, counts);
    }

    return this.attemptAbort(row, sessionId, anchor, readClient, clients, now, counts);
  }

  private async requeueOrTerminal(
    row: SwarmMessageRecord,
    sessionId: string,
    now: number,
    counts: CycleSummary,
    reason: string,
  ): Promise<boolean> {
    if (row.requeueCount < this.maxRequeues) {
      this.storage.swarm.requeueForRecovery(
        row.msgId,
        now,
        RECOVERY_REQUEUE_DELAY_MS,
      );
      counts.requeued++;
      this.log("requeued", { msgId: row.msgId, sessionId, reason });
      return true;
    }

    this.storage.swarm.markFailed(row.msgId, now);
    counts.terminal++;
    this.pruneDedupe(row.msgId);
    await this.alert(
      "error",
      `delivery watchdog: msg ${row.msgId} to ${sessionId} — ${reason} (max requeues exhausted)`,
    );
    notifySenderOfFailure(this.storage, row, reason, now);
    this.log("terminal", { msgId: row.msgId, sessionId, reason });
    return true;
  }

  private async attemptAbort(
    row: SwarmMessageRecord,
    sessionId: string,
    anchor: number,
    readClient: WatchdogClient,
    clients: ClientSet,
    now: number,
    counts: CycleSummary,
  ): Promise<boolean> {
    // TOCTOU: re-fetch immediately before acting. A fresh turn may have
    // started (or ours may have finally run) since the transcript we based
    // this decision on was read at the top of the cycle.
    const refetch = await fetchTranscript(readClient, sessionId);
    if (!refetch.ok) {
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "toctou-refetch-failed",
      });
      return false;
    }

    if (findVerificationEvidence(refetch.messages, anchor)) {
      this.storage.swarm.markVerified(row.msgId, now);
      this.pruneDedupe(row.msgId);
      counts.verified++;
      this.log("verified", {
        msgId: row.msgId,
        sessionId,
        reason: "toctou-refetch",
      });
      return false;
    }

    const stillBlocking = findBlockingInFlight(refetch.messages, anchor);
    if (!stillBlocking) {
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "toctou-no-longer-blocked",
      });
      return false;
    }

    const freshLastActivity = lastActivityOf(stillBlocking);
    if (now - freshLastActivity <= this.stuckAbortSilenceMs) {
      // A fresh turn/activity appeared — don't abort.
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "toctou-fresh-activity",
      });
      return false;
    }

    // Still stuck — broadcast the abort to every healthy serve. Best-effort
    // per serve: a 4xx from a non-owning serve is a benign no-op, so we only
    // need one 2xx to consider the abort delivered.
    const results = await Promise.allSettled(
      clients.all.map((c) => c.abortSession(sessionId)),
    );
    const anySuccess = results.some((r) => r.status === "fulfilled");

    if (!anySuccess) {
      counts.skipped++;
      await this.alert(
        "error",
        `delivery watchdog: abort broadcast failed on all healthy serves for session ${sessionId}, msg ${row.msgId}`,
      );
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "abort-broadcast-all-failed",
      });
      return false;
    }

    this.storage.swarm.markAborted(row.msgId, now);
    this.storage.swarm.requeueForRecovery(
      row.msgId,
      now,
      RECOVERY_REQUEUE_DELAY_MS,
    );
    counts.aborted++;
    this.log("aborted+requeued", { msgId: row.msgId, sessionId });
    return true;
  }
}

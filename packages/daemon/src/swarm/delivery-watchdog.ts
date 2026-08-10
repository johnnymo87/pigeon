import { existsSync } from "node:fs";
import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import type { StopNotifier, AlertSeverity } from "../notification-service";
import { notifySenderOfFailure } from "./notify-sender";
import {
  isWakeKind,
  isSuppressedFromRecovery,
  formatWakePayloadAlert,
  formatNudgePayload,
  NUDGE_KIND,
} from "./delivery-policy";
import { makeMsgId } from "../ids";
import { enqueueSwarmTelegramNotice } from "./telegram-notice";

export { isWakeKind, isSuppressedFromRecovery };

/** The subset of OpencodeClient the watchdog needs. */
export interface WatchdogClient {
  getSessionMessages(sessionId: string): Promise<unknown[]>;
  /**
   * DELIBERATELY RETAINED THOUGH THE WATCHDOG NEVER CALLS IT (pigeon-0gxy).
   *
   * This is not dead code to be tidied away. It is what makes the
   * never-preempt invariant ASSERTABLE: ~25 tests, including
   * "15. INVARIANT: abortSession is never called, for any row shape, ever",
   * assert `expect(client.abortSession).not.toHaveBeenCalled()`. Delete this
   * member and those assertions stop being expressible — the fence silently
   * becomes prose.
   *
   * Removing it would also buy nothing structurally: the concrete
   * `OpencodeClient` keeps the method regardless (the Telegram `/interrupt`
   * command calls it via `worker/interrupt-ingest.ts`), so re-adding it here
   * is one line. Capability-absence that is trivially recoverable is
   * decoration; the mutation-tested assertion is the real guard.
   */
  abortSession(sessionId: string): Promise<void>;
}

/**
 * Result of resolving the healthy opencode-serve clients relevant to a
 * session. `preferred` is used for the primary transcript read; `all` is the
 * full healthy set, used for second-opinion reads (a different client than
 * `preferred`). Either may be empty/undefined when no healthy serve is
 * currently known for the session.
 *
 * `all` used to exist to broadcast aborts as well. Nothing broadcasts aborts
 * any more (pigeon-0gxy); it is now purely a read facility.
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
/**
 * STUCK_ABORT_SILENCE_MS. Historical name: nothing aborts any more
 * (pigeon-0gxy). It now only sets how long a blocking turn must be silent
 * before the stuck alert labels it SILENT rather than ACTIVE.
 */
export const DEFAULT_STUCK_ABORT_SILENCE_MS = 3_600_000;
/** MAX_REQUEUES */
export const DEFAULT_MAX_REQUEUES = 3;
/** MAX_NUDGES — how many times we may ask a target to read a payload it
 *  already holds before giving up and reporting DELIVERED_UNCONFIRMED. */
export const DEFAULT_MAX_NUDGES = 3;
/** OVERDUE_ALERT_MS */
export const DEFAULT_OVERDUE_ALERT_MS = 300_000;
/** DIRECTORY_TIMEOUT_MS */
export const DEFAULT_DIRECTORY_TIMEOUT_MS = 5_000;
/** See `DeliveryWatchdogOptions.stallAlertMs`. */
export const DEFAULT_STALL_ALERT_MS = 10 * 60_000;

/** Delay before a watchdog-initiated redelivery is retried by the arbiter. */
const RECOVERY_REQUEUE_DELAY_MS = 5_000;

export interface DeliveryWatchdogOptions {
  storage: StorageDb;
  resolveClients: ResolveClientsFn;
  directoryForSession?: (sessionId: string) => Promise<string | undefined>;
  notifier?: DeliveryWatchdogNotifier;
  nowFn?: () => number;
  log?: WatchdogLogger;
  intervalMs?: number;
  verifyAfterMs?: number;
  stuckAlertMs?: number;
  stuckAbortSilenceMs?: number;
  maxRequeues?: number;
  maxNudges?: number;
  /**
   * Threshold for the overdue-still-queued alarm. Constructor-only on purpose:
   * unlike its siblings there is no env knob yet, because nothing has needed to
   * tune it. Tests use it to drive the clock.
   */
  overdueAlertMs?: number;
  directoryTimeoutMs?: number;
  /**
   * How long an in-flight cycle may run before a coalesced call reports it as
   * stalled. Generous on purpose: a cycle legitimately makes one bounded
   * transcript fetch per eligible session, so a backlog of sessions each
   * hitting the 30s client timeout can take minutes without anything being
   * wrong. This alarm is for "wedged", not "slow".
   */
  stallAlertMs?: number;
}

export interface CycleSummary {
  verified: number;
  requeued: number;
  /** Nudges sent this cycle (recovery that did NOT re-inject a payload). */
  nudged: number;
  alerted: number;
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
    nudged: 0,
    alerted: 0,
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
  id?: string;
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

  const id = typeof info.id === "string" ? info.id : undefined;
  const time = info.time;
  const created =
    isObject(time) && typeof time.created === "number" ? time.created : 0;
  const completed =
    isObject(time) && typeof time.completed === "number" ? time.completed : null;
  const hasError = info.error !== undefined && info.error !== null;
  const parts = Array.isArray(raw.parts) ? raw.parts : [];

  return { id, role, created, completed, hasError, parts };
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

/** Which evidence path verified a handoff — recorded so audits can tell them apart. */
type VerificationReason = "completed-clean" | "in-flight-progressed";

/**
 * True when the turn has emitted at least one part carrying a timestamp —
 * i.e. the model or a tool actually did something at a knowable moment.
 *
 * Deliberately NOT `parts.length > 0`. Sampling real transcripts (2026-08-03)
 * shows every assistant turn carries `step-start` and `step-finish` parts, and
 * neither carries a timestamp: they are scaffolding emitted around a turn, not
 * evidence that the turn produced anything. A wedged turn can hold those parts
 * while having run nothing at all, so counting them would reintroduce exactly
 * the false confidence this predicate exists to remove. `partTimestamps`
 * extracts times only from text/reasoning/tool parts, which is the structural
 * artifact of real execution.
 */
function hasProducedOutput(msg: ParsedMessage): boolean {
  for (const part of msg.parts) {
    if (partTimestamps(part).length > 0) return true;
    // A tool part in ANY state — including `pending`, which carries no `time`
    // at all (sdk types.gen.ts: ToolStatePending is {status,input,raw}) — means
    // the model already emitted a tool call. That is stronger evidence of
    // execution than a reasoning timestamp, so it must not depend on timing
    // fields that this particular state omits.
    if (isObject(part) && part.type === "tool") return true;
  }
  return false;
}

/**
 * Evidence that our run started/ran: a clean-completed assistant message, or
 * an in-flight assistant message THAT HAS PRODUCED OUTPUT, strictly after
 * `anchor`. A completed assistant message WITH an error is not evidence — it
 * falls through to the stuck rules (something else may still be blocking our
 * prompt).
 *
 * The in-flight branch used to return true on the mere EXISTENCE of an
 * in-flight row, on the assumption that "in-flight" means "serving our prompt
 * right now". It does not. A wake delivered into a session whose working
 * directory was deleted leaves an assistant row at parts=0 / completed=null
 * FOREVER, and that assumption stamped it verified on the first pass — closing
 * a wake that never ran as a success, permanently (pigeon-s9d; measured
 * msg_msbtad7o_8f8596fb, verified 308s after handoff, and 4763-of-4763
 * handed_off rows verified with zero unverified). Existence is a snapshot;
 * progress is the structural property. Absence of output is NOT failure here,
 * only absence of evidence — the caller decides when silence has lasted long
 * enough to mean wedged.
 */
function findVerificationEvidence(
  messages: ParsedMessage[],
  anchor: number,
): VerificationReason | null {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.created <= anchor) continue;
    if (m.completed === null) {
      // in-flight AND actually running
      if (hasProducedOutput(m)) return "in-flight-progressed";
      continue; // started but silent: no evidence yet, keep looking
    }
    if (!m.hasError) return "completed-clean"; // ran clean
  }
  return null;
}

/**
 * The OLDEST post-anchor in-flight assistant turn that has produced no output.
 *
 * Only meaningful once `findVerificationEvidence` has returned false, which
 * implies no post-anchor in-flight turn has produced anything. Oldest, not
 * newest: the turn plausibly serving OUR prompt is the earliest one after the
 * anchor, and keying on the newest would let unrelated later traffic in a busy
 * session keep resetting the reported silence.
 *
 * This is the structural difference between the two states the watchdog
 * previously could not tell apart: an idle target has NO post-anchor assistant
 * turn at all (nothing ever started — the benign case W3 reasoned about),
 * whereas this target HAS one that started and has yet to produce anything.
 *
 * IT IS NOT, HOWEVER, PROOF OF A WEDGE, and must never be treated as such.
 * A turn that has started and gone quiet is produced by at least two very
 * different causes that the transcript cannot separate:
 *   - the session can never run it (working directory deleted — pigeon-s9d);
 *   - the provider told us to wait (a 429 retry, which opencode surfaces as
 *     ephemeral session STATUS, never as a part, and whose delay honours
 *     retry-after up to RETRY_MAX_DELAY; the `step-start` part is only written
 *     from a stream event, so a rate-limit refused before the first event
 *     leaves exactly zero parts, identical to the wedge).
 * Failing the first on a false positive of the second would destroy a live
 * wake that was about to run, and tell a human it never ran. So the caller
 * treats this state as UNKNOWN. Distinguishing them needs a liveness signal
 * this transcript does not carry (see pigeon-fnx R4).
 */
function findSilentInFlight(
  messages: ParsedMessage[],
  anchor: number,
): ParsedMessage | null {
  let silent: ParsedMessage | null = null;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.completed !== null) continue;
    if (m.created < anchor) continue;
    if (hasProducedOutput(m)) continue;
    if (silent === null || m.created < silent.created) silent = m;
  }
  return silent;
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
  private readonly directoryForSession:
    | ((sessionId: string) => Promise<string | undefined>)
    | undefined;
  private readonly notifier: DeliveryWatchdogNotifier | undefined;
  private readonly nowFn: () => number;
  private readonly log: WatchdogLogger;
  private readonly verifyAfterMs: number;
  private readonly stuckAlertMs: number;
  private readonly stuckAbortSilenceMs: number;
  private readonly maxRequeues: number;
  private readonly maxNudges: number;
  private readonly overdueAlertMs: number;

  // Dedupe: msg_id -> the stuck-behind-blocking-turn warn has already fired
  // for this handoff episode. Pruned when the message verifies or goes
  // terminal (a fresh redelivery gets its own alert budget).
  private readonly stuckAlerted = new Set<string>();
  // Dedupe: msg_id -> the lost-wake alert has already been enqueued.
  //
  // DELIBERATELY SEPARATE from `stuckAlerted`, which this branch used to share
  // with the queued-behind-turn advisory. Sharing meant a row that first
  // appeared blocked behind a live turn spent the budget on a losable,
  // payload-less warning, and the durable payload alert was then never even
  // attempted for the rest of the process lifetime. A warning and a
  // last-resort delivery of the message body are not interchangeable, so they
  // do not share a budget.
  private readonly lostWakeAlerted = new Set<string>();
  // Dedupe: msg_id -> the no-healthy-serve age alarm has already fired.
  private readonly ageAlarmed = new Set<string>();
  // Dedupe: msg_id -> the overdue queued alarm has already fired.
  private readonly overdueAlerted = new Set<string>();
  // Dedupe: msg_id -> the silent-in-flight warn has already fired.
  // Intentional per-episode alert semantics: silentInFlightAlerted is not cleared when
  // signature changes (only observation clock is reset), matching stuckAlerted until verification/terminal.
  private readonly silentInFlightAlerted = new Set<string>();
  // Observation clock: msg_id -> { firstSeen: number; signature: string }
  private readonly silentInFlightObserved = new Map<
    string,
    { firstSeen: number; signature: string }
  >();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  /** Wall-clock start of the in-flight cycle; null when idle. See `reportStallIfOverdue`. */
  private cycleStartedAt: number | null = null;
  /** `cycleStartedAt` of the episode a stall alert was raised for, so it can be retracted. */
  private stallReportedFor: number | null = null;
  private readonly intervalMs: number;
  private readonly directoryTimeoutMs: number;
  private readonly stallAlertMs: number;

  constructor(opts: DeliveryWatchdogOptions) {
    this.storage = opts.storage;
    this.resolveClients = opts.resolveClients;
    this.directoryForSession = opts.directoryForSession;
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
    this.maxNudges = opts.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.overdueAlertMs = opts.overdueAlertMs ?? DEFAULT_OVERDUE_ALERT_MS;
    this.directoryTimeoutMs =
      opts.directoryTimeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS;
    this.stallAlertMs = opts.stallAlertMs ?? DEFAULT_STALL_ALERT_MS;
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
      this.reportStallIfOverdue();
      return emptySummary(true);
    }
    this.processing = true;
    this.cycleStartedAt = this.nowFn();
    try {
      return await this.runCycle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("cycle error", { error: message });
      return { ...emptySummary(), error: message };
    } finally {
      const startedAt = this.cycleStartedAt;
      this.processing = false;
      this.cycleStartedAt = null;
      if (startedAt !== null && this.stallReportedFor === startedAt) {
        // Never let bookkeeping break the loop it is reporting on: a throw from
        // a `finally` would replace the cycle's real outcome with this one's.
        try {
          this.reportStallRecovered(startedAt, this.nowFn());
        } catch (err) {
          this.log("stall-recovered alert failed", { error: String(err) });
        }
      }
    }
  }

  /**
   * The single-flight `processing` flag above is only safe while every await in
   * a cycle is bounded. A HANG (as opposed to a throw) leaves it set forever,
   * every later cycle coalesces, and the watchdog is silently dead — taking the
   * overdue-queued alarm with it, which is the one alarm placed here precisely
   * so the monitor cannot die together with the thing it monitors. `try/catch`
   * cannot help: a hang is not a throw.
   *
   * pigeon-wfj1 bounded the known awaits (the client and the registry now carry
   * end-to-end deadlines covering the response BODY, not just the headers). This
   * is the backstop for the ones nobody has thought of yet — INCLUDING any await
   * a future change adds to the cycle.
   *
   * It deliberately does NOT force-clear `processing`. Doing so would let two
   * `runCycle()` bodies overlap: the dedupe Sets are check-then-act across
   * awaits, and the nudge budget is read from a row snapshot taken before an
   * await, so overlapping cycles could double-nudge a live session — replacing a
   * silent death with a possibly-corrupt life. A stalled watchdog that says so
   * is the honest outcome; a human (or a daemon restart) is the recovery.
   *
   * The report itself must not be able to hang, or it inherits the failure it
   * exists to report — so it is a SYNCHRONOUS better-sqlite3 enqueue, and the
   * independent AlertDrainer performs the network send.
   */
  private reportStallIfOverdue(): void {
    const startedAt = this.cycleStartedAt;
    if (startedAt === null) return;

    const now = this.nowFn();
    const stalledFor = now - startedAt;
    if (stalledFor < this.stallAlertMs) return;

    // Synthetic, non-null ref keyed to THIS episode. Non-null matters: SQLite
    // permits many NULLs in a UNIQUE index, so a null ref would re-alert every
    // cycle. Keying on the stalled cycle's start collapses that episode to one
    // alert while still letting a later, distinct stall raise its own. The
    // `watchdog-stall:` prefix keeps it out of the msg_id namespace, so it can
    // never occupy the dedupe slot belonging to a real message's alert.
    //
    // THE WORDING DOES NOT PICK A CAUSE, because this trigger cannot separate
    // the two. Exceeding the threshold proves only that the cycle has run that
    // long. A hung await produces it — but so does a legitimate backlog: the
    // cycle makes up to two bounded 30s transcript fetches per eligible session,
    // so ~10 sessions on unresponsive serves reach 10 minutes honestly. Naming
    // "hung" and demanding a restart would be a decisive instruction derived
    // from evidence that does not support it, and during a multi-serve outage it
    // would repeat every cycle. The follow-up alert below is what disambiguates.
    const enqueued = this.storage.alerts.enqueue({
      source: "delivery-watchdog-stall",
      refMsgId: `watchdog-stall:${startedAt}`,
      text:
        `delivery watchdog: cycle started ${new Date(startedAt).toISOString()} ` +
        `has been running ${humanDuration(stalledFor)} without finishing. ` +
        `Delivery recovery and the overdue-queued alarm are BOTH stopped while ` +
        `it runs, for every session. Two causes look identical from here: an ` +
        `await inside the cycle is hung, OR the cycle is grinding through a ` +
        `backlog of per-session timeouts (a multi-serve outage can legitimately ` +
        `take this long). DO NOT restart yet: if a "cycle recovered" alert ` +
        `follows, it was slow, not stuck. If none arrives, it is wedged — ` +
        `restart the pigeon daemon and check what it was fetching.`,
      severity: "error",
      now,
    });

    if (enqueued) {
      this.stallReportedFor = startedAt;
      this.log("cycle stalled", {
        stalledForMs: stalledFor,
        startedAt,
      });
    }
  }

  /**
   * Retract the ambiguity of a stall report once the cycle actually finishes.
   *
   * Without this, a slow-but-healthy cycle leaves a bare "may be wedged, restart
   * the daemon" alert standing forever, and the reader has no way to tell that
   * it resolved itself — so the honest-unknown alert above would drive exactly
   * the unnecessary restart it is trying to prevent. Only fires for an episode
   * that was actually reported, so it cannot become chatter on its own.
   */
  private reportStallRecovered(startedAt: number, now: number): void {
    if (this.stallReportedFor !== startedAt) return;
    this.stallReportedFor = null;
    this.storage.alerts.enqueue({
      source: "delivery-watchdog-stall-recovered",
      refMsgId: `watchdog-stall-recovered:${startedAt}`,
      text:
        `delivery watchdog: the cycle started ${new Date(startedAt).toISOString()} ` +
        `COMPLETED after ${humanDuration(now - startedAt)}. It was slow, not ` +
        `wedged — no restart is needed. Recovery and the overdue-queued alarm ` +
        `are running again. Recurring reports of this mean the cycle is ` +
        `routinely spending minutes on unresponsive serves.`,
      severity: "warning",
      now,
    });
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
    this.lostWakeAlerted.delete(msgId);
    this.ageAlarmed.delete(msgId);
    this.overdueAlerted.delete(msgId);
    this.silentInFlightAlerted.delete(msgId);
    this.silentInFlightObserved.delete(msgId);
  }

  private reconcileOverdueDedupe(overdueIds: ReadonlySet<string>): void {
    for (const msgId of this.overdueAlerted) {
      if (!overdueIds.has(msgId)) this.overdueAlerted.delete(msgId);
    }
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
   * `pruneDedupe` explicitly. Path (c) does NOT prune explicitly — but
   * that's fine (arguably correct): the row is temporarily absent from the
   * eligible set only for the window between the requeue and the arbiter's
   * redelivery, and per the class-level doc comment a fresh redelivery is
   * meant to get its own alert budget anyway, so reconciling it away here
   * just makes that intent actually happen.
   *
   * Note that a NUDGE does not take path (c): the row stays `handed_off`
   * throughout, so it keeps its dedupe entry and its alert budget.
   *
   * The remaining case — and the bug this exists to fix — is the row being
   * deleted out from under us without ever resolving through (a) or (b).
   * Note: swarm retention (`swarm.cleanupOlderThan`) IS wired, but unverified
   * rows are exempt from age cleanup (never deleted by retention while
   * unverified), so they persist until verified or moved to a terminal state.
   * Reconciling against "not in this cycle's eligible set" catches entries
   * whose row was deleted or moved.
   *
   * Rows that are alive but simply too young (handed_off more recently than
   * `verifyAfterMs`) were never alerted in the first place — they can't be
   * in these Sets — so they can't be spuriously pruned here.
   */
  private reconcileDedupe(eligibleIds: ReadonlySet<string>): void {
    for (const msgId of this.stuckAlerted) {
      if (!eligibleIds.has(msgId)) this.stuckAlerted.delete(msgId);
    }
    for (const msgId of this.lostWakeAlerted) {
      if (!eligibleIds.has(msgId)) this.lostWakeAlerted.delete(msgId);
    }
    for (const msgId of this.ageAlarmed) {
      if (!eligibleIds.has(msgId)) this.ageAlarmed.delete(msgId);
    }
    for (const msgId of this.silentInFlightAlerted) {
      if (!eligibleIds.has(msgId)) this.silentInFlightAlerted.delete(msgId);
    }
    for (const msgId of Array.from(this.silentInFlightObserved.keys())) {
      if (!eligibleIds.has(msgId)) this.silentInFlightObserved.delete(msgId);
    }
  }

  private async runCycle(): Promise<CycleSummary> {
    const now = this.nowFn();
    const counts = emptySummary();

    // PLACEMENT IS THE WHOLE POINT:
    // The overdue-and-still-queued check lives in DeliveryWatchdog, NOT in the
    // SwarmArbiter tick where an expiry sweeper naturally wants to go. If it
    // lived in the arbiter, a dead arbiter would mean a dead alarm — the monitor
    // would die with the thing it monitors and the silence would look like
    // health. This alarm exists precisely to catch "the delivery loop is not
    // running", so it must not run inside that loop.
    //
    // `listOverdueQueued` also requires a stale `updated_at`, which is what
    // keeps this from firing every night: during the 03:00 serve bounce a wake
    // sits queued and overdue on purpose while the arbiter retries it without
    // charging its budget. See the query for the full argument.
    const overdueRows = this.storage.swarm.listOverdueQueued(
      now,
      this.overdueAlertMs,
    );
    this.reconcileOverdueDedupe(new Set(overdueRows.map((r) => r.msgId)));
    for (const row of overdueRows) {
      if (!this.overdueAlerted.has(row.msgId)) {
        this.overdueAlerted.add(row.msgId);
        counts.alerted++;
        const overdueMs = now - (row.deliverAt ?? now);
        // Report these SEPARATELY. They are only equal when nothing touched
        // the row since before its delivery time. In the likelier crash shape
        // — the arbiter retried through a two-hour outage and then died five
        // minutes ago — the row is overdue by 2h but untouched for 5min, and
        // collapsing them into one number would state something false. The
        // gap between the two is also the useful diagnostic: it says how long
        // delivery was being attempted before it stopped.
        const untouchedMs = now - row.updatedAt;
        await this.alert(
          "error",
          `delivery watchdog: msg ${row.msgId} to ${row.toSession ?? "unknown"} ` +
            `is still queued, overdue by ${humanDuration(overdueMs)} (${overdueMs}ms) ` +
            `and untouched for ${humanDuration(untouchedMs)} (${untouchedMs}ms) — ` +
            `nothing is retrying it, so the arbiter delivery loop appears to be ` +
            `stopped or wedged for this target. This wake will not fire until ` +
            `delivery resumes.`,
        );
        this.log("alerted", {
          msgId: row.msgId,
          sessionId: row.toSession,
          reason: "overdue-queued",
        });
      }
    }

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
          // for the rest of this session's processing — otherwise every
          // subsequent read keeps hitting the 404-ing client.
          messages = second.messages;
          readClient = alt;
        } else if (second.status === 404) {
          // Confirmed — the session is truly gone.
          for (const row of rows) {
            let marked = false;
            const alertText = isSuppressedFromRecovery(row)
              ? formatWakePayloadAlert(
                  row,
                  `session ${sessionId} no longer exists on opencode-serve`,
                  "delivery watchdog: session no longer exists",
                )
              : `delivery watchdog: session ${sessionId} no longer exists on opencode-serve; msg ${row.msgId} cannot be verified — marking failed`;

            this.storage.db.transaction(() => {
              if (!this.storage.swarm.markFailed(row.msgId, now)) return;
              marked = true;

              if (isSuppressedFromRecovery(row)) {
                this.storage.alerts.enqueue({
                  source: "wake-session-deleted",
                  refMsgId: row.msgId,
                  text: alertText,
                  severity: "error",
                  now,
                });
              }

              if (row.fromSession !== row.toSession) {
                notifySenderOfFailure(
                  this.storage,
                  row,
                  `session ${sessionId} no longer exists`,
                  now,
                  "absent",
                );
              }
            })();

            if (!marked) continue;

            if (!isSuppressedFromRecovery(row)) {
              await this.alert("error", alertText);
            }

            counts.terminal++;
            this.pruneDedupe(row.msgId);
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

  /**
   * Helper for suppressing recovery (requeue/abort) on wake / scheduled messages.
   * Handles alerting if blocked past threshold and logs skip. Always returns `false`.
   */
  private suppressWakeRecovery(
    row: SwarmMessageRecord,
    sessionId: string,
    now: number,
    counts: CycleSummary,
    severity: AlertSeverity,
    reason: string,
    alertText: string,
  ): boolean {
    const blockedAge = now - (row.handedOffAt ?? now);
    if (blockedAge > this.stuckAlertMs && !this.lostWakeAlerted.has(row.msgId)) {
      // DURABLE, not best-effort (pigeon-fww). `alertText` is built by
      // formatWakePayloadAlert and CARRIES THE PAYLOAD: for a self-wake there
      // is no sender watching in-band, so this alert is the only path by which
      // the message's content ever reaches a human. Sent inline it died on a
      // 429, a transport blip, or a daemon crash, and nothing re-derived it.
      //
      // TWO LAYERS OF DEDUPE, and each covers the other's gap. The in-memory
      // `lostWakeAlerted` (dedicated to this branch — see its declaration)
      // bounds this to ONE alert per process lifetime, so a wake that sits
      // unresolved for weeks cannot turn into a recurring page. The durable
      // unique ref covers what the Set cannot: a restart empties the Set, and
      // the alert row then refuses the duplicate on its own.
      //
      // ENQUEUE BEFORE THE SET ADD, and the order is load-bearing. Unlike
      // `this.alert` (which swallowed everything), enqueue CAN throw —
      // SQLITE_BUSY, SQLITE_IOERR. Marking the Set first would suppress this
      // row for the entire process lifetime on a transient failure, which is
      // the exact silent loss being fixed here; the row never leaves the
      // eligible set, so reconcileDedupe would never restore it either.
      //
      // WHY THE REF IS NAMESPACED. The dedupe index is UNIQUE on ref_msg_id
      // ALONE, so keying this on the bare msgId would make this ADVISORY
      // occupy the slot belonging to the row's later TERMINAL alert
      // (session-deleted / nudges-exhausted, both `refMsgId: row.msgId`), and
      // ON CONFLICT DO NOTHING would drop the terminal SILENTLY — its return
      // value is discarded inside those transactions. The human's last word
      // would stay "may be lost" for a row since marked failed. The
      // `wake-lost:` prefix keeps this out of the msg_id namespace, which is
      // enforced (not merely assumed) by rejecting ':' in caller-supplied
      // msg_ids at the API boundary — see parseSwarmSendBody. The row can
      // therefore produce at most two durable alerts: this advisory, and one
      // terminal.
      const enqueued = this.storage.alerts.enqueue({
        source: "wake-lost-unverified",
        refMsgId: `wake-lost:${row.msgId}`,
        text: alertText,
        severity,
        now,
      });
      this.lostWakeAlerted.add(row.msgId);
      if (enqueued) {
        counts.alerted++;
        this.log("alerted", { msgId: row.msgId, sessionId, reason });
      }
    }
    counts.skipped++;
    this.log("skipped", {
      msgId: row.msgId,
      sessionId,
      reason: "wake-suppress-requeue",
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
      if (isSuppressedFromRecovery(row)) {
        const blockedAge = now - (row.handedOffAt ?? now);
        // The `as of` stamp is not decoration. Every duration in this text is
        // measured at OBSERVATION time, but the alert now rides the durable
        // queue: the drainer retries with backoff and, through a long Telegram
        // outage, this can reach a human hours after the fact. Without the
        // stamp "unverified for 17 minutes" silently becomes a claim about the
        // present, and a reader would size the problem wrongly.
        const reason = `prompt for msg ${row.msgId} to ${sessionId} not found in target transcript after ${blockedAge}ms (${humanDuration(blockedAge)}) — wake may be lost, redelivery suppressed (observed ${new Date(now).toISOString()})`;
        const alertText = formatWakePayloadAlert(
          row,
          reason,
          "delivery watchdog: prompt lost and unverified",
        );
        return this.suppressWakeRecovery(
          row,
          sessionId,
          now,
          counts,
          "error",
          "lost-wake-unverified",
          alertText,
        );
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

    const verifiedBy = findVerificationEvidence(messages, anchor);
    if (verifiedBy) {
      this.storage.swarm.markVerified(row.msgId, now);
      this.pruneDedupe(row.msgId);
      counts.verified++;
      // `reason` distinguishes the two evidence paths. Without it the last
      // audit could not tell a genuinely-completed run from a rubber stamp,
      // and 4763 verified rows were retroactively unknowable (pigeon-s9d).
      this.log("verified", { msgId: row.msgId, sessionId, reason: verifiedBy });
      return false;
    }

    // A post-anchor turn that STARTED but has produced nothing. Distinct from
    // the idle case below (where nothing started at all) and from the blocking
    // case (where the turn predates our prompt). This is the shape a wake into
    // a deleted working directory leaves behind — and, critically, it is ALSO
    // the shape a provider rate-limit leaves behind, so the two cannot be told
    // apart from the transcript alone (see the note on findSilentInFlight).
    //
    // So this is where the watchdog says "I do not know", and stops. The row
    // stays handed_off and unverified, and is re-examined every cycle. It is
    // deliberately NOT requeued: redelivering a prompt whose turn may simply be
    // waiting on a retry would inject a duplicate into a live session, and
    // prompt_async is not idempotent.
    const silent = findSilentInFlight(messages, anchor);
    if (silent) {
      // Task 1: One-shot escalation alert for long-silent in-flight rows.
      // Clock starts from OUR FIRST OBSERVATION (now), not from turn's created timestamp.
      // Signature records the turn's observed state (turn ID/created timestamp + part count).
      // Note: A parked retry (e.g. 429) is also unchanged across observations, so this signature
      // check does NOT separate wedged turns from parked retries — it only avoids shouting
      // about turns that are visibly progressing.
      const turnId = silent.id ?? String(silent.created);
      const signature = `${turnId}:${silent.parts.length}`;
      const observed = this.silentInFlightObserved.get(row.msgId);

      if (!observed || observed.signature !== signature) {
        this.silentInFlightObserved.set(row.msgId, { firstSeen: now, signature });
      } else {
        // Note: If serve was unreachable between observations, silentMs spans unobserved time.
        // Acceptable for an advisory about the same turn state, but duration is not continuously observed.
        const silentMs = now - observed.firstSeen;
        if (
          silentMs > this.stuckAlertMs &&
          !this.silentInFlightAlerted.has(row.msgId)
        ) {
          this.silentInFlightAlerted.add(row.msgId);
          counts.alerted++;

          // Task 2: Working-directory corroboration.
          // CRITICAL: This directory check is for human alert text corroboration ONLY.
          // Under no circumstances may a missing directory trigger a state change,
          // a markFailed, or a requeue. It assumes the daemon and the serve share a
          // filesystem (true on this host, not structural), and it assumes gone-now
          // implies gone-when-the-turn-parked. It is evidence for a human, not for
          // the state machine.
          let dirText = "working directory unresolvable; cannot determine cause";
          if (this.directoryForSession) {
            // Bound directory lookup so an unbounded network await does not wedge
            // the entire watchdog cycle (which would silently kill future cycles
            // since processing remains true).
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const dirPromise = this.directoryForSession(sessionId);
              dirPromise.catch(() => {}); // catch late rejections after timeout
              const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("directoryForSession timeout")),
                  this.directoryTimeoutMs,
                );
                timer.unref?.();
              });

              const dir = await Promise.race([dirPromise, timeoutPromise]);
              if (dir) {
                if (existsSync(dir)) {
                  dirText = `working directory exists (${dir}); turn may be parked on a provider retry (cannot distinguish from wedged turn in transcript)`;
                } else {
                  dirText = `working directory (${dir}) not found on daemon filesystem; if daemon and serve share a filesystem, turn cannot proceed — otherwise check is not meaningful here`;
                }
              }
            } catch {
              dirText = "working directory unresolvable; cannot determine cause";
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          }

          // Sent via the EPHEMERAL alert path (this.alert), NOT durable
          // storage.alerts.enqueue — and after pigeon-fww that is a positive
          // choice, not the absence of one.
          //
          // The reason recorded here originally was "a durable advisory would
          // permanently block a later TERMINAL alert for this row, because the
          // dedupe index is UNIQUE on ref_msg_id alone". That hazard is real
          // but it is no longer a reason to stay ephemeral: pigeon-fww showed
          // a namespaced ref (`wake-lost:<msgId>`) sidesteps it entirely, so
          // any site that needs durability can have it.
          //
          // This site stays ephemeral because it does not need durability. The
          // rule: an alert must be DURABLE when losing it can be the final
          // silent loss of the event — no later durable signal is guaranteed
          // to fire for the same underlying fact. That is true of the
          // lost-wake alert (it carries the payload, and the row can sit
          // handed_off indefinitely). It is NOT true here: this row remains in
          // a live state machine whose terminal exits — session-deleted and
          // nudges-exhausted — are both durable. Losing this advisory costs a
          // human some latency, never the payload.
          //
          // Task 3: REFUSED DESIGN OPTION:
          // opencode-serve's GET /session/status is INSTANCE-SCOPED by the x-opencode-directory header.
          // Queried without the correct directory it returns {} for a provably busy session,
          // and absent means idle by design — so a liveness check built on it FAILS OPEN and silently
          // becomes a no-op. If it is ever adopted it must send the directory header AND confirm
          // the serve owns the session, and even then it may only DELAY or SUPPRESS an alert
          // (failing open into alerting is the safe direction), never justify a terminal.
          await this.alert(
            "warning",
            `delivery watchdog: msg ${row.msgId} to ${sessionId} in-flight turn produces no output — silent for ${humanDuration(silentMs)} (${silentMs}ms); ${dirText}`,
          );
          this.log("alerted", {
            msgId: row.msgId,
            sessionId,
            reason: "silent-in-flight",
            silentForMs: silentMs,
          });
        }
      }

      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "in-flight-no-output-yet",
        silentForMs: now - silent.created,
      });
      return false;
    } else {
      this.silentInFlightObserved.delete(row.msgId);
      this.silentInFlightAlerted.delete(row.msgId);
    }

    const blocking = findBlockingInFlight(messages, anchor);
    if (!blocking) {
      // Session is idle — our prompt is sitting there but nothing ever ran
      // it. Nothing to abort.
      //
      // Suppression exists because REDELIVERY duplicates a payload. A nudge
      // does not duplicate the payload — it asks the session to read the copy
      // it already has — so the rationale that justifies suppressing requeue
      // does not extend to suppressing nudges. Wakes are, by construction, the
      // population with NOBODY WATCHING IN-BAND (a session asked to be woken
      // later), so they need the strongest in-band recovery and currently get
      // the weakest.
      if (interventionAlreadyUsed) {
        return this.skipInterventionBudgetUsed(row, sessionId, counts);
      }
      // The payload is already in the transcript (we have an anchor) and no
      // turn has run since. Do NOT requeue: that re-renders the whole envelope
      // and injects a SECOND copy, which is exactly the duplicate-injection
      // half of pigeon-3m5. Nudge instead — ask the target to read the copy it
      // already holds.
      return this.nudgeOrTerminal(row, sessionId, now, counts);
    }

    const lastActivity = lastActivityOf(blocking);
    const blockedAge = now - (row.handedOffAt ?? now);
    const silence = now - lastActivity;

    if (blockedAge > this.stuckAlertMs && !this.stuckAlerted.has(row.msgId)) {
      this.stuckAlerted.add(row.msgId);
      counts.alerted++;
      const fresh = silence <= this.stuckAbortSilenceMs;
      const label = fresh ? "ACTIVE" : "SILENT";
      const recoveryNote = isSuppressedFromRecovery(row)
        ? " (recovery suppressed)"
        : "";
      await this.alert(
        "warning",
        `delivery watchdog: msg ${row.msgId} to ${sessionId} queued behind ${label} turn — blocked ${blockedAge}ms (${humanDuration(blockedAge)}), turn silent ${silence}ms (${humanDuration(silence)})${recoveryNote}`,
      );
      this.log("alerted", {
        msgId: row.msgId,
        sessionId,
        reason: `queued-behind-${label.toLowerCase()}-turn`,
      });
    }

    // Our prompt is queued behind somebody else's running turn. We WAIT, for
    // as long as it takes, and we do not touch that turn (pigeon-0gxy).
    //
    // Until R3 this is where the watchdog aborted the blocking turn and
    // redelivered. That was wrong twice over, and it produced 7 of the 9
    // duplicate-injection specimens in the production DB:
    //
    //  - opencode's runLoop re-reads the WHOLE transcript on every step
    //    (prompt.ts:1092 -> toModelMessagesEffect at :1261), so a turn that is
    //    already running SEES a user message injected after it started and can
    //    act on it mid-turn. The turn we were about to kill may be the very
    //    turn that is processing our message.
    //  - even when it is not, aborting destroys a peer session's in-flight
    //    work — its tool calls, its reasoning, its partial answer — purely so
    //    that mail arrives sooner. Late mail is cheaper than destroyed work.
    //
    // Waiting costs nothing: when the blocking turn ends, this row falls into
    // the idle branch above on a later cycle and gets NUDGED, so delivery
    // still completes. We give up nothing but the destruction.
    counts.skipped++;
    this.log("skipped", {
      msgId: row.msgId,
      sessionId,
      reason:
        silence <= this.stuckAbortSilenceMs
          ? "waiting"
          : "blocked-behind-silent-turn",
      blockedForMs: blockedAge,
      blockerSilentForMs: silence,
    });
    return false;
  }

  /**
   * Recovery for a row whose payload IS already in the target transcript.
   *
   * Sends a NUDGE — a small separate message telling the target it has an
   * unread swarm message and naming its msg_id — rather than re-injecting the
   * payload. This is the structural half of the pigeon-3m5 fix: the invariant
   * is ONE PAYLOAD INJECTION PER msg_id, FOREVER. Requeueing would render and
   * inject the whole envelope a second time, which is what put two identical
   * copies in a target's context while its sender was told nothing arrived.
   *
   * The nudge is enqueued as an ordinary swarm row so it inherits the
   * arbiter's routing, directory resolution, retry and backoff. When it lands
   * on an idle session it starts a turn; that turn's context contains the
   * original envelope (opencode rebuilds model input from the full transcript
   * every step), so the original message is read and the ORIGINAL row verifies
   * on the next cycle via the ordinary post-anchor evidence path.
   *
   * When the nudge budget is exhausted we stop and report honestly:
   * DELIVERED_UNCONFIRMED, never "was NOT received" (see formatFailureNotice).
   */
  private async nudgeOrTerminal(
    row: SwarmMessageRecord,
    sessionId: string,
    now: number,
    counts: CycleSummary,
  ): Promise<boolean> {
    const reason = "target session idle — no turn was confirmed to have read prompt";

    // Loop guard: a nudge that is itself unread must never spawn another
    // nudge. Without this a permanently-idle session mints nudges forever,
    // each of which is itself an unverified handed_off row.
    if (row.kind === NUDGE_KIND) {
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "nudge-unread-no-cascade",
      });
      return false;
    }

    if (this.storage.swarm.hasQueuedNudge(row.msgId)) {
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "previous-nudge-still-queued",
      });
      return false;
    }

    if (row.nudgeCount >= this.maxNudges) {
      let marked = false;
      this.storage.db.transaction(() => {
        if (!this.storage.swarm.markFailed(row.msgId, now)) return;
        marked = true;

        if (isSuppressedFromRecovery(row)) {
          this.storage.alerts.enqueue({
            source: "wake-nudge-exhausted",
            refMsgId: row.msgId,
            text: formatWakePayloadAlert(
              row,
              `${reason} (${row.nudgeCount} nudges exhausted); payload IS in the transcript but no turn was confirmed to have read it`,
              "delivery watchdog: wake unverified after nudges exhausted",
            ),
            severity: "error",
            now,
          });
        }

        if (row.fromSession !== row.toSession) {
          notifySenderOfFailure(this.storage, row, reason, now, "present");
        }
      })();

      if (!marked) {
        counts.skipped++;
        this.log("skipped", {
          msgId: row.msgId,
          sessionId,
          reason: "nudge-row-no-longer-handed-off",
        });
        return false;
      }

      if (!isSuppressedFromRecovery(row)) {
        await this.alert(
          "error",
          `delivery watchdog: msg ${row.msgId} to ${sessionId} — ${reason} (${row.nudgeCount} nudges exhausted); payload IS in the transcript but no turn was confirmed to have read it`,
        );
      }

      counts.terminal++;
      this.pruneDedupe(row.msgId);
      this.log("terminal", {
        msgId: row.msgId,
        sessionId,
        reason: "nudges-exhausted",
      });
      return true;
    }

    const recorded = this.storage.swarm.recordNudge(row.msgId);
    if (!recorded) {
      // The row left handed_off underneath us (verified/cancelled/failed on
      // another path). Do not send a nudge for a row that is no longer ours.
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "nudge-row-no-longer-handed-off",
      });
      return false;
    }

    const nudgeMsgId = makeMsgId();
    const inserted = this.storage.swarm.insert(
      {
        msgId: nudgeMsgId,
        fromSession: "pigeon",
        toSession: sessionId,
        channel: null,
        kind: NUDGE_KIND,
        priority: row.priority,
        replyTo: row.msgId,
        payload: formatNudgePayload(row),
      },
      now,
    );
    if (inserted) {
      const record = this.storage.swarm.getByMsgId(nudgeMsgId);
      if (record) enqueueSwarmTelegramNotice(this.storage, record, now);
    }
    counts.nudged++;
    this.log("nudged", {
      msgId: row.msgId,
      sessionId,
      reason,
      nudgeCount: row.nudgeCount + 1,
    });
    return true;
  }

  /**
   * Recovery for a row whose payload is NOT in the target transcript: the 2xx
   * lied (or the write was lost). This is the ONE case where re-sending the
   * whole envelope is correct rather than duplicative, because there is no
   * first copy to duplicate. Reached only from the `anchor === null` branch.
   */
  private async requeueOrTerminal(
    row: SwarmMessageRecord,
    sessionId: string,
    now: number,
    counts: CycleSummary,
    reason: string,
  ): Promise<boolean> {
    if (row.requeueCount < this.maxRequeues) {
      const requeued = this.storage.swarm.requeueForRecovery(
        row.msgId,
        now,
        RECOVERY_REQUEUE_DELAY_MS,
      );
      if (requeued) {
        counts.requeued++;
        this.log("requeued", { msgId: row.msgId, sessionId, reason });
        return true;
      }
      counts.skipped++;
      this.log("skipped", {
        msgId: row.msgId,
        sessionId,
        reason: "requeue-failed",
      });
      return false;
    }

    this.storage.swarm.markFailed(row.msgId, now);
    counts.terminal++;
    this.pruneDedupe(row.msgId);
    await this.alert(
      "error",
      `delivery watchdog: msg ${row.msgId} to ${sessionId} — ${reason} (max requeues exhausted)`,
    );
    // We have now read the transcript on every cycle that got us here and our
    // envelope was absent every time. Telling the sender "it IS in the
    // transcript, do NOT resend" -- which keying this on handedOffAt would do
    // -- would strand the message permanently and talk the sender out of the
    // only action that could recover it.
    if (row.fromSession !== row.toSession) {
      notifySenderOfFailure(this.storage, row, reason, now, "absent");
    }
    this.log("terminal", { msgId: row.msgId, sessionId, reason });
    return true;
  }

}

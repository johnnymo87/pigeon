/**
 * Runs goose turns for one session, detached from command delivery.
 *
 * WHY THIS EXISTS AS A SEPARATE OBJECT FROM THE ADAPTER
 *
 * `selectAdapter` constructs a fresh adapter per command, so an adapter cannot
 * hold state that outlives a single delivery. A goose turn outlives its delivery
 * by design (see below), so the state has to live somewhere that persists: this
 * runner, held in a registry keyed by session id.
 *
 * THE TIMING CONSTRAINT, which dictates everything else here
 *
 * `session/prompt` does not return until the whole turn ends -- minutes, in the
 * normal case. The worker lease is 60s (`packages/worker/src/d1-ops.ts`) and the
 * poller acks only AFTER the delivery handler returns. So a delivery that awaited
 * the turn would lapse its lease, be redelivered, and issue a SECOND prompt into
 * the still-running turn. `deliver()` therefore returns as soon as the prompt has
 * been SENT, and the turn is finished by a continuation with no caller.
 *
 * A continuation with no caller is a loaded gun on Node: an unhandled rejection
 * terminates the process, which would take command delivery down for every
 * session on the machine, not just this one. Nothing in `finishTurn` may throw --
 * hence the layered try/catch and the last-resort log.
 *
 * WHAT WAS MEASURED, rather than assumed (goose 1.48.0, 2026-09-18, recorded in
 * bead eng-agent-platform-drm):
 *
 *  - `session/update` notifications are the only streaming surface. Assistant
 *    text arrives as `agent_message_chunk`; `tool_call`/`tool_call_update`/
 *    `usage_update` are chatter.
 *  - The active run id arrives in `session_info_update._meta.goose.activeRunId`
 *    as soon as a turn starts, so a second message can STEER the running turn
 *    without first provoking a busy rejection.
 *  - /kill sends session/cancel via cancel() (against both honkd and bare goose).
 *  - A turn does NOT survive its WebSocket closing against bare goose.
 *    Re-measured on patched-1.54.0.3 (2026-10-12, bead pigeon-jlb6;
 *    also honk docs/spike/m0-findings.md T5), goose cancels every run a
 *    connection started the moment that connection closes -- a blip, the
 *    watchdog's own close(), or this daemon exiting. Nothing the turn had done
 *    yet (not even a started tool call) is recorded in the history; only the
 *    user's message is. So every notice for bare goose says "cancelled", never
 *    "it will finish on goose's side".
 *  - Through honkd (isHonk true), turns survive a client disconnect. On WS drop
 *    mid-turn, pigeon reconnects once and resends the prompt with the same
 *    client_req_id, which honkd attaches to the in-flight turn or returns the
 *    stored reply.
 *  - A fresh connection can prompt an EXISTING session id and still has its
 *    history, so reconnecting is cheap and a daemon restart does not orphan a
 *    SESSION -- only the turn that was in flight (on bare goose).
 */
import { backendSessionIdOf } from "../storage/types.js";
import type { SessionRecord } from "../storage/types.js";
import type { GooseInflightRecord, GooseInflightStore } from "../storage/goose-inflight-repo.js";
import { DisconnectedDuringTurn, type RunOwnership, type RunState, type RunStateInfo } from "./acp-client.js";

/**
 * What the human is told when the daemon shuts down with a goose turn in flight.
 *
 * Lives here, beside the other turn notices, so it is tested; it is sent from
 * index.ts's shutdown handler. Exiting closes the socket, and goose cancels the
 * run when it does -- the earlier text promised the turn "will finish on its
 * side", which sent the human off to wait for work that had been cancelled.
 */
export function gooseShutdownNotice(sessionId: string, isHonk = false): string {
  if (isHonk) {
    return (
      `pigeon is restarting while a goose turn was running on ${sessionId}. `
      + "The connection to honkd was closed, but the turn may still be running in honkd. "
      + `${HONK_RESUME_ADVICE} (Once pigeon is back.)`
    );
  }
  return (
    `pigeon is restarting while a goose turn was running on ${sessionId}. `
    + "goose cancels a turn when its connection closes, so that turn was cancelled and will not finish. "
    + `${RESUME_ADVICE} (Once pigeon is back.)`
  );
}

/**
 * What every "your turn is gone" notice tells the human to do next.
 *
 * One string so the three notices cannot drift apart. The warning in the
 * second half is load-bearing: measured, the cancelled turn leaves NOTHING in
 * goose's history but the user's message -- not even a tool call that had
 * started -- so a reply re-runs the task from the start, blind to whatever it
 * had already pushed or posted. That is where duplicates come from.
 */
function resumeAdvice(resent = false): string {
  const resendClause = resent ? "one resend was attempted" : "nothing was resent";
  return (
    `Your message is still in the session's history with no reply, and ${resendClause}. `
    + "Replying (\"continue\" is enough) starts a fresh turn that sees that message but NOT what the "
    + "cancelled turn had already done -- so if it may have pushed, posted or sent something, say so, "
    + "or it may do it again."
  );
}

function honkResumeAdvice(resent = false): string {
  const resendClause = resent ? "one resend was attempted" : "nothing was resent";
  return (
    `Your message is still in the session's history with no reply, and ${resendClause}. `
    + "The turn may have finished in goose's history; the reply just wasn't collected."
  );
}

const RESUME_ADVICE = resumeAdvice(false);
const HONK_RESUME_ADVICE = honkResumeAdvice(false);

/** The slice of GooseAcpClient the runner needs. Structural, so tests can fake it. */
export interface RunnerClient {
  connect(): Promise<void>;
  /** True once the socket has closed, so the runner knows to reconnect. */
  isClosed(): boolean;
  /** True when connected to honkd. Bare goose is false. */
  readonly isHonk?: boolean;
  /** True when honkd advertises resume_only feature. */
  readonly supportsResumeOnly?: boolean;
  /** Round-trips a cheap request; never settles on a dead socket. */
  ping(): Promise<void>;
  prompt(sessionId: string, text: string, options?: { clientReqId?: string; resumeOnly?: boolean }): Promise<unknown>;
  steer(sessionId: string, expectedRunId: string, text: string): Promise<unknown>;
  activeRunId(sessionId: string): string | undefined;
  runOwnership?(sessionId: string): RunOwnership;
  runState?(sessionId: string): RunState;
  cancel(sessionId: string): void;
  close(): void;
}

export interface DeliverOutcome {
  ok: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface GooseSessionRunnerOptions {
  session: SessionRecord;
  client: RunnerClient;
  /**
   * Reports a finished turn by calling the daemon's own `/stop` handler.
   *
   * Deliberately NOT a direct `outbox.upsert`. Everything the `/stop` route does
   * between reading the body and enqueueing -- notification-id idempotency, the
   * `notify` flag, notify policy, reply-token minting, message formatting and
   * splitting, the scroll anchor, and `sessions.touch` -- would otherwise have to
   * be reimplemented here, and would drift from the opencode path the first time
   * either side changed.
   */
  postStop: (body: Record<string, unknown>) => Promise<void>;
  /** Keeps the reaper off a session whose only activity is goose-side. */
  touch: (sessionId: string) => void;
  /** Persisted in-flight turns store for crash recovery (honk-znj.10). */
  inflight?: GooseInflightStore;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Transcript buffer cap. A runaway turn must not be able to exhaust memory. */
  maxTranscriptBytes?: number;
  /** Silence after which a turn is presumed dead. Defaults to 30 minutes. */
  turnIdleTimeoutMs?: number;
  /** Inactivity period after which an idle socket is closed. Defaults to 10 minutes. 0 disables. */
  idleSocketTimeoutMs?: number;
  /** Fallback drain interval while queue is non-empty and no turn is running. Defaults to 2 minutes. */
  drainFallbackIntervalMs?: number;
  /** Total time budget for retrying reconnection to honkd. Defaults to 2 minutes (~120s). */
  honkReconnectBudgetMs?: number;
  /** Total time budget for recovering an in-flight turn through honkd. Defaults to 10 minutes. */
  honkRecoveryBudgetMs?: number;
  /** Initial delay before retrying connect to honkd. Defaults to 250ms. */
  honkReconnectInitialDelayMs?: number;
  /** Max delay between reconnect attempts. Defaults to 5s. */
  honkReconnectMaxDelayMs?: number;
  /** Optional injectable sleep function for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface Turn {
  commandId: string;
  startedAt: number;
  /** Last time ANY frame arrived for this turn. The watchdog's only input. */
  lastActivityAt: number;
  /** Last time inflight last_alive_at was touched. Throttled to ~1/min (R1). */
  lastAliveTouchAt?: number;
  text: string[];
  bytes: number;
  truncated: boolean;
  settled: Promise<void>;
  /**
   * Set when the watchdog gave up on this turn and already told the human.
   *
   * Changes what a LATE settlement means, asymmetrically: a late error is the
   * expected consequence of our own close() and is logged only, while a late
   * receipt is reported normally.
   *
   * Be clear about that second branch: it is defence, not a live path. A turn is
   * only abandoned after a liveness probe has already failed, so the socket is
   * dead and no receipt is coming. Even on a live socket it would not arrive --
   * verified on node 22.22.2 that a WebSocket whose readyState has left OPEN
   * delivers no further message events, per the WHATWG step that drops them. It
   * is kept because the cost of being wrong here is a silently swallowed answer,
   * and because the distinct `:stalled` notification id that makes it possible is
   * worth having regardless. Nothing should be built on it firing.
   */
  abandoned: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  resent?: boolean;
  recovered?: boolean;
  cancelRequested?: boolean;
  queuedNoticeSent?: boolean;
  fromQueue?: boolean;
}

interface QueuedItem {
  commandId: string;
  text: string;
  queuedNoticeSent?: boolean;
}

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = "\n\n[... truncated: the turn produced more output than pigeon buffers]";
const TOUCH_ALIVE_INTERVAL_MS = 60_000; // ~1/min throttled touchAlive (R1)
const DEFAULT_DRAIN_FALLBACK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes (Item 6)
const QUEUED_NOTICE_MESSAGE =
  "goose is busy with a turn pigeon did not start (or cannot yet confirm is its own), so this was not added to it. It is queued and will be sent as a new turn when that turn ends.";

const BUSY_NOT_DELIVERED_TEXT =
  "goose was already running a turn and pigeon could not add this message to it. "
  + "It was NOT delivered -- please send it again once the current turn finishes.";

const DEFAULT_HONK_RECONNECT_BUDGET_MS = 120_000;
const DEFAULT_HONK_RECOVERY_BUDGET_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_HONK_RECONNECT_INITIAL_DELAY_MS = 250;
const DEFAULT_HONK_RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * How long a turn may emit NOTHING before pigeon stops believing in it.
 *
 * Silence is a weak signal and this threshold is chosen to respect that. goose
 * emits `tool_call` when a tool starts and `tool_call_update` when it ends, so a
 * twenty-minute build is twenty minutes of legitimate silence. Thirty minutes is
 * past anything the human is likely to be running and still short of the hours a
 * wedged session would otherwise sit there.
 *
 * Expiry does NOT mean the turn is abandoned. It means the socket gets asked
 * whether it is alive (see `checkStalled`), and only a socket that fails to
 * answer ends the turn. That is what makes this threshold a question of how
 * often to pester a working turn rather than a guess that costs the human their
 * answer when it is wrong.
 *
 * The interactive case does not wait for this at all: a human who sends anything
 * to a wedged session trips the 10s steer bound instead, which is evidence of
 * the same kind and arrives immediately.
 */
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a connected socket may sit without a turn in flight before closing.
 *
 * honkd keeps sessions in memory while an attached viewer socket remains open,
 * so leaving connections open indefinitely exhausts honkd's session limit.
 * Pigeon reconnects lazily on the next turn via ensureConnected().
 */
const DEFAULT_IDLE_SOCKET_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Timeout for connect attempt during cancel().
 * Never let /kill hang.
 */
const CANCEL_CONNECT_TIMEOUT_MS = 3_000;

/**
 * Deadline for every await on the delivery path that is NOT the turn itself.
 *
 * The contract in adapters/types.ts requires it: "Bound every await inside
 * deliverCommand. The poller dispatches serially, so one unbounded await freezes
 * command delivery for EVERY session on the machine, including another session's
 * /interrupt." The ACP client has no per-request timeout by design -- a TURN may
 * legitimately take minutes -- so the bound belongs here, where a handshake and
 * a steer are distinguishable from a turn.
 *
 * A half-open socket (NAT idle drop, serve SIGKILL with no FIN) emits no close
 * event, so this is the only thing that ends such a wait.
 */
const NON_TURN_TIMEOUT_MS = 10_000;

/** Rejects if `p` has not settled within `ms`. Does not cancel `p`. */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`goose ${what} did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class GooseSessionRunner {
  private readonly opts: GooseSessionRunnerOptions;
  private turn: Turn | undefined;
  /** The most recent turn's continuation. See settled(). */
  private lastSettled: Promise<void> = Promise.resolve();
  private connected = false;
  private connectedOnce = false;
  private connecting: Promise<void> | undefined;
  private idleSocketTimer: ReturnType<typeof setTimeout> | undefined;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private sleepResolve: (() => void) | undefined;
  private closed = false;
  private suspended = false;
  private drainHeld = false;
  private queue: QueuedItem[] = [];
  private sentSteers = new Map<string, { commandId: string; text: string }>();
  private draining = false;
  private drainFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryResolvedOrAttached: Promise<void> | undefined;
  private resolveRecoveryAttached: (() => void) | undefined;

  constructor(opts: GooseSessionRunnerOptions) {
    this.opts = opts;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  suspend(): void {
    this.suspended = true;
    this.clearDrainFallbackTimer();
  }

  dropQueued(): number {
    const count = this.queue.length;
    for (const item of this.queue) {
      try {
        this.opts.inflight?.delete(item.commandId);
      } catch (err) {
        this.log("goose runner: dropQueued delete failed", {
          commandId: item.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.queue = [];
    this.clearDrainFallbackTimer();
    return count;
  }

  holdDrain(): void {
    this.drainHeld = true;
  }

  releaseDrain(): void {
    this.drainHeld = false;
    this.scheduleDrain();
  }

  enqueueRecovered(row: GooseInflightRecord): void {
    this.queue.push({
      commandId: row.commandId,
      text: row.promptText,
      queuedNoticeSent: true,
    });
    this.scheduleDrain();
    this.armDrainFallbackTimer();
  }

  onRunStateChange(_view?: RunStateInfo): void {
    this.scheduleDrain();
  }

  onSteerUnconsumed(messageId: string): void {
    const steer = this.sentSteers.get(messageId);
    if (!steer) return;
    this.sentSteers.delete(messageId);

    void this.enqueue(
      steer.commandId,
      steer.text,
      "your message reached goose too late for the turn it was added to; queued",
    ).catch((err) => {
      this.log("goose runner: onSteerUnconsumed enqueue failed", {
        sessionId: this.sessionId,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  get activeTurn(): { commandId: string } | undefined {
    return this.turn ? { commandId: this.turn.commandId } : undefined;
  }

  retire(turn: { commandId: string }): void {
    try {
      this.opts.inflight?.delete(turn.commandId);
    } catch (err) {
      this.log("goose runner: could not retire inflight turn", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private notifyRecoveryResolvedOrAttached(): void {
    if (this.resolveRecoveryAttached) {
      const resolve = this.resolveRecoveryAttached;
      this.resolveRecoveryAttached = undefined;
      resolve();
    }
  }

  resume(row: GooseInflightRecord): boolean {
    if (this.turn) {
      this.log("goose runner: cannot resume turn because a turn is already active; leaving row for next boot", {
        sessionId: this.sessionId,
        activeCommandId: this.turn.commandId,
        incomingCommandId: row.commandId,
      });
      return false;
    }

    this.clearIdleSocketTimer();
    const turn: Turn = {
      commandId: row.commandId,
      startedAt: row.createdAt,
      lastActivityAt: Date.now(),
      lastAliveTouchAt: Date.now(),
      text: [],
      bytes: 0,
      truncated: false,
      settled: Promise.resolve(),
      abandoned: false,
      idleTimer: undefined,
      resent: true,
      recovered: true,
    };
    this.turn = turn;
    this.sentSteers.clear();
    this.opts.touch(this.sessionId);
    this.armIdleTimer(turn);

    try {
      this.opts.inflight?.markResumed(row.commandId, Date.now());
    } catch (err) {
      this.log("goose runner: markResumed failed", {
        sessionId: this.sessionId,
        commandId: row.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.recoveryResolvedOrAttached = new Promise<void>((resolve) => {
      this.resolveRecoveryAttached = resolve;
    });

    const recoveryBudgetMs = this.opts.honkRecoveryBudgetMs ?? DEFAULT_HONK_RECOVERY_BUDGET_MS;

    this.lastSettled = turn.settled = (async () => {
      try {
        try {
          await withDeadline(this.ensureConnected(), NON_TURN_TIMEOUT_MS, "connect");
        } catch (connectErr) {
          if (row.isHonk) {
            await this.reconnectAndResend(turn, row.promptText, connectErr, recoveryBudgetMs);
            return;
          }
          await this.finishTurn(turn, undefined, connectErr);
          return;
        }

        if (!this.opts.client.isHonk || !this.opts.client.supportsResumeOnly) {
          this.log("honkd does not advertise resume_only; cannot safely collect reply", {
            sessionId: this.sessionId,
            commandId: row.commandId,
            isHonk: this.opts.client.isHonk,
            supportsResumeOnly: this.opts.client.supportsResumeOnly,
          });
          if (this.turn === turn) this.clearTurn();
          try {
            await this.opts.postStop({
              session_id: this.sessionId,
              notification_id: `s:${this.sessionId}:${sanitiseIdPart(row.commandId)}`,
              message:
                "pigeon restarted while goose was working on this; can't safely collect the reply, nothing was resent — check the session / ask again",
              event: "Error",
              error_kind: "goose-turn-recovery-unsupported",
            });
            this.retire(turn);
          } catch (reportErr) {
            this.log("goose runner: could not report unsupported recovery notice", {
              sessionId: this.sessionId,
              commandId: row.commandId,
              error: reportErr instanceof Error ? reportErr.message : String(reportErr),
            });
          } finally {
            this.scheduleDrain();
          }
          return;
        }

        try {
          const outcome = await this.opts.client.prompt(this.backendSessionId, row.promptText, {
            clientReqId: row.commandId,
            resumeOnly: true,
          });
          await this.onPromptOutcome(turn, row.promptText, outcome);
        } catch (err) {
          if (err instanceof DisconnectedDuringTurn && this.opts.client.isHonk) {
            this.connected = false;
            await this.reconnectAndResend(turn, row.promptText, err, recoveryBudgetMs);
            return;
          }
          await this.finishTurn(turn, undefined, err);
        }
      } finally {
        this.notifyRecoveryResolvedOrAttached();
        if (this.opts.client.isHonk && !this.turn && this.connected && !this.opts.client.isClosed() && !this.closed) {
          this.armIdleSocketTimer();
        }
      }
    })().catch((err: unknown) => {
      this.log("goose runner: recovery continuation threw", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return true;
  }

  async postShutdownNotice(commandId: string): Promise<void> {
    await this.opts.postStop({
      session_id: this.sessionId,
      notification_id: `s:${this.sessionId}:${sanitiseIdPart(commandId)}`,
      message: gooseShutdownNotice(this.sessionId, false),
      event: "Error",
      error_kind: "goose-turn-cancelled-by-restart",
    });
  }

  async postNotice(body: Record<string, unknown>): Promise<void> {
    await this.opts.postStop(body);
  }

  get isHonk(): boolean {
    return Boolean(this.opts.client.isHonk);
  }

  get isHonkKnown(): boolean {
    return Boolean(this.opts.client.isHonk) || this.connectedOnce;
  }

  /**
   * PIGEON's id for this session, and the one almost everything here wants:
   * storage, `touch`, `/stop` bodies, notification ids, logs.
   */
  get sessionId(): string {
    return this.opts.session.sessionId;
  }

  /**
   * GOOSE's id for this session -- the only name goose answers to.
   *
   * Used at exactly the four ACP call sites (prompt, both steers, activeRunId)
   * and nowhere else. The two differ because goose names sessions with a
   * per-machine counter (`YYYYMMDD_N`) that collides across machines, so pigeon
   * mints its own; see SessionRecord.backendSessionId for what that collision
   * would cost. Sending pigeon's id to goose fails only against a real goose,
   * so the tests record which id each fake was called with.
   */
  private get backendSessionId(): string {
    return backendSessionIdOf(this.opts.session);
  }

  isBusy(): boolean {
    return this.turn !== undefined;
  }

  /**
   * Resolves when the most recent turn has been fully reported.
   *
   * Tracks the last turn's continuation rather than `this.turn`, because a turn
   * the watchdog abandoned is cleared from `this.turn` while its continuation is
   * still outstanding -- and that continuation can still produce a notification
   * (a late receipt is reported; see finishTurn). Reading `this.turn` here would
   * resolve immediately and report "done" for work still in flight.
   */
  async settled(): Promise<void> {
    await this.lastSettled;
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(msg, fields);
  }

  /**
   * Sends `text` to goose and returns WITHOUT waiting for the turn.
   *
   * Deliver outcome contract (Spec bead eng-agent-platform-555.17):
   * ok: true  meta.mode "prompt" | "steered" | "queued" | "already-running" | "already-queued"
   * ok: false only for permanent refusals (e.g. steer-timeout)
   * throw only before anything was saved or sent
   */
  async deliver(commandId: string, text: string): Promise<DeliverOutcome> {
    this.clearIdleSocketTimer();

    // 3a. Redelivery of the command that started the turn we are already running.
    if (this.turn?.commandId === commandId) {
      return { ok: true, meta: { mode: "already-running", runId: this.runId() } };
    }

    // 3b. commandId already queued -> ok:true meta.mode "already-queued" (no second notice).
    if (this.queue.some((item) => item.commandId === commandId)) {
      return { ok: true, meta: { mode: "already-queued" } };
    }

    // 3c. this.turn set (our turn in flight):
    // if client ownership is "own" AND a run id is known AND not a recovered turn -> steer as today
    // Otherwise (pending, unknown, foreign, or no run id yet -- this REPLACES the "no-run-id-yet" refusal
    // and also covers recovered turns) -> enqueue.
    if (this.turn) {
      const isOwn = !this.turn.recovered && this.ownsActiveRun();
      const runId = this.runId();
      if (!isOwn || !runId) {
        return this.enqueue(commandId, text);
      }

      await this.ensureConnected();

      const steeringTurn = this.turn;
      let outcome: { kind?: string; messageId?: string };
      try {
        outcome = (await withDeadline(
          this.opts.client.steer(this.backendSessionId, runId, text),
          NON_TURN_TIMEOUT_MS,
          "steer",
        )) as { kind?: string; messageId?: string };
      } catch (err) {
        try {
          await withDeadline(this.opts.client.ping(), NON_TURN_TIMEOUT_MS, "liveness ping");
          this.log("goose runner: steer timed out but the socket is alive", {
            sessionId: this.sessionId,
          });
        } catch {
          await this.abandonTurn(steeringTurn, "a steer and a liveness check both went unanswered");
        }
        return {
          ok: false,
          error: `goose did not acknowledge the steer: ${err instanceof Error ? err.message : String(err)}`,
          meta: { mode: "steer-timeout" },
        };
      }
      if (outcome?.kind === "steered") {
        this.opts.touch(this.sessionId);
        if (outcome.messageId) {
          this.sentSteers.set(outcome.messageId, { commandId, text });
        }
        return { ok: true, meta: { mode: "steered", runId } };
      }
      // `no-active-run`: the turn ended between our check and the steer. A fresh
      // prompt is now the correct action, so fall through rather than fail.
      this.log("goose steer found no active run, starting a fresh turn", {
        sessionId: this.sessionId,
      });
      this.clearTurn();
      if (this.queue.length > 0) {
        return this.enqueue(commandId, text);
      }
    }

    // 3d. no turn of ours but queue non-empty -> enqueue (order).
    if (this.queue.length > 0) {
      return this.enqueue(commandId, text);
    }

    // 3e. otherwise ensureConnected + startTurn as today.
    await this.ensureConnected();
    return this.startTurn(commandId, text);
  }

  private async enqueue(commandId: string, text: string, customMessage?: string): Promise<DeliverOutcome> {
    if (this.opts.inflight) {
      this.opts.inflight.insert({
        commandId,
        sessionId: this.sessionId,
        backendSessionId: this.backendSessionId,
        isHonk: this.isHonk,
        promptText: text,
        state: "queued",
      });
    }

    this.queue.push({ commandId, text, queuedNoticeSent: true });

    const message = customMessage ?? QUEUED_NOTICE_MESSAGE;
    try {
      await this.opts.postStop({
        session_id: this.sessionId,
        notification_id: `s:${this.sessionId}:${sanitiseIdPart(commandId)}:queued`,
        message,
        event: "Queued",
      });
    } catch (err) {
      this.log("goose runner: could not post queued notice", {
        sessionId: this.sessionId,
        commandId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.scheduleDrain();
    this.armDrainFallbackTimer();

    return { ok: true, meta: { mode: "queued" } };
  }

  private scheduleDrain(): void {
    queueMicrotask(() => {
      void this.maybeDrain().catch((err: unknown) => {
        this.log("goose runner: maybeDrain unhandled error", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async maybeDrain(): Promise<void> {
    if (this.draining) return;
    if (this.closed || this.suspended || this.drainHeld) return;
    if (this.turn) return;
    if (this.queue.length === 0) return;

    const runState = this.opts.client.runState?.(this.backendSessionId);
    if (runState === "running") {
      this.armDrainFallbackTimer();
      return;
    }

    this.draining = true;
    try {
      if (this.closed || this.suspended || this.drainHeld || this.turn || this.queue.length === 0) return;

      const item = this.queue[0];
      if (!item) return;

      try {
        await this.ensureConnected();
      } catch (err) {
        this.log("goose runner: ensureConnected failed during drain", {
          sessionId: this.sessionId,
          commandId: item.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.armDrainFallbackTimer();
        return;
      }

      // Re-check after awaiting ensureConnected:
      // closed, suspended, this.turn set, or queue head changed
      if (this.closed || this.suspended || this.turn || this.queue[0]?.commandId !== item.commandId) {
        return;
      }

      this.queue.shift();

      try {
        this.startTurn(item.commandId, item.text, { fromQueue: true });
      } catch (err) {
        this.queue.unshift(item);
        this.log("goose runner: startTurn failed during drain", {
          sessionId: this.sessionId,
          commandId: item.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.armDrainFallbackTimer();
        return;
      }

      if (this.queue.length === 0) {
        this.clearDrainFallbackTimer();
      }
    } catch (outerErr) {
      this.log("goose runner: unexpected error in maybeDrain", {
        sessionId: this.sessionId,
        error: outerErr instanceof Error ? outerErr.message : String(outerErr),
      });
    } finally {
      this.draining = false;
    }
  }

  private armDrainFallbackTimer(): void {
    if (this.closed || this.suspended) return;
    if (this.queue.length === 0 || this.turn) {
      this.clearDrainFallbackTimer();
      return;
    }
    if (this.drainFallbackTimer) return;

    const interval = this.opts.drainFallbackIntervalMs ?? DEFAULT_DRAIN_FALLBACK_INTERVAL_MS;
    this.drainFallbackTimer = setTimeout(() => {
      this.drainFallbackTimer = undefined;
      this.scheduleDrain();
      if (this.queue.length > 0 && !this.turn) {
        this.armDrainFallbackTimer();
      }
    }, interval);
    this.drainFallbackTimer.unref?.();
  }

  private clearDrainFallbackTimer(): void {
    if (this.drainFallbackTimer) {
      clearTimeout(this.drainFallbackTimer);
      this.drainFallbackTimer = undefined;
    }
  }

  /**
   * Sends the prompt and attaches the continuation.
   *
   * `client.prompt` writes to the transport synchronously before returning its
   * promise, so by the time this function returns the command HAS been sent.
   * That is what makes "throw means nothing was sent" true for callers.
   */
  private startTurn(commandId: string, text: string, options?: { fromQueue?: boolean }): DeliverOutcome {
    this.sentSteers.clear();
    this.clearIdleSocketTimer();
    this.clearDrainFallbackTimer();

    if (this.opts.inflight) {
      if (options?.fromQueue) {
        this.opts.inflight.markSent(commandId, Date.now());
      } else {
        this.opts.inflight.insert({
          commandId,
          sessionId: this.sessionId,
          backendSessionId: this.backendSessionId,
          isHonk: this.isHonk,
          promptText: text,
          state: "sent",
        });
      }
    }

    const turn: Turn = {
      commandId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      text: [],
      bytes: 0,
      truncated: false,
      settled: Promise.resolve(),
      abandoned: false,
      idleTimer: undefined,
      queuedNoticeSent: options?.fromQueue ?? false,
      fromQueue: options?.fromQueue ?? false,
    };
    this.turn = turn;
    this.opts.touch(this.sessionId);
    this.armIdleTimer(turn);

    this.lastSettled = turn.settled = (async () => {
      try {
        const outcome = await this.opts.client.prompt(this.backendSessionId, text, { clientReqId: commandId });
        await this.onPromptOutcome(turn, text, outcome);
      } catch (err) {
        if (err instanceof DisconnectedDuringTurn && this.opts.client.isHonk) {
          this.connected = false;
          const budgetMs = this.opts.honkReconnectBudgetMs ?? DEFAULT_HONK_RECONNECT_BUDGET_MS;
          await this.reconnectAndResend(turn, text, err, budgetMs);
          return;
        }
        await this.finishTurn(turn, undefined, err);
      } finally {
        if (this.opts.client.isHonk && !this.turn && this.connected && !this.opts.client.isClosed() && !this.closed) {
          this.armIdleSocketTimer();
        }
      }
    })().catch((err: unknown) => {
      // finishTurn is written not to throw. If it somehow does, this is the
      // difference between a logged anomaly and a dead daemon.
      this.log("goose runner: turn continuation threw", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { ok: true, meta: { mode: "prompt", commandId } };
  }

  private async reconnectAndResend(
    turn: Turn,
    text: string,
    cause: unknown,
    budgetMs: number,
  ): Promise<void> {
    if (this.closed || turn.abandoned || turn.cancelRequested) {
      await this.finishTurn(turn, undefined, cause);
      return;
    }
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = undefined;
    }
    this.log("honk disconnect mid-turn, retrying reconnect and resend with backoff", {
      sessionId: this.sessionId,
      commandId: turn.commandId,
    });

    const deadline = Date.now() + budgetMs;
    let delay = this.opts.honkReconnectInitialDelayMs ?? DEFAULT_HONK_RECONNECT_INITIAL_DELAY_MS;
    const maxDelay = this.opts.honkReconnectMaxDelayMs ?? DEFAULT_HONK_RECONNECT_MAX_DELAY_MS;

    while (Date.now() < deadline) {
      if (this.closed || turn.abandoned || turn.cancelRequested) {
        await this.finishTurn(turn, undefined, cause);
        return;
      }
      try {
        await withDeadline(this.ensureConnected(), NON_TURN_TIMEOUT_MS, "reconnect");
      } catch (connectErr) {
        if (this.closed || turn.abandoned || turn.cancelRequested) {
          await this.finishTurn(turn, undefined, cause);
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const waitTime = Math.min(delay, maxDelay, remaining);
        delay = Math.min(delay * 2, maxDelay);
        this.log("honk reconnect attempt failed, backing off", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          delay: waitTime,
          error: connectErr instanceof Error ? connectErr.message : String(connectErr),
        });
        await this.sleep(waitTime);
        continue;
      }

      if (this.closed || turn.abandoned || turn.cancelRequested) {
        await this.finishTurn(turn, undefined, cause);
        return;
      }

      if (!this.opts.client.isHonk || (turn.recovered && !this.opts.client.supportsResumeOnly)) {
        this.log("reconnected endpoint is not honkd or does not advertise resume_only for recovered turn", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          isHonk: this.opts.client.isHonk,
          supportsResumeOnly: this.opts.client.supportsResumeOnly,
        });
        if (turn.recovered) {
          if (this.turn === turn) this.clearTurn();
          try {
            await this.opts.postStop({
              session_id: this.sessionId,
              notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}`,
              message:
                "pigeon restarted while goose was working on this; can't safely collect the reply, nothing was resent — check the session / ask again",
              event: "Error",
              error_kind: "goose-turn-recovery-unsupported",
            });
            this.retire(turn);
          } catch (reportErr) {
            this.log("goose runner: could not report unsupported recovery notice", {
              sessionId: this.sessionId,
              commandId: turn.commandId,
              error: reportErr instanceof Error ? reportErr.message : String(reportErr),
            });
          } finally {
            this.scheduleDrain();
          }
          return;
        }
        await this.finishTurn(turn, undefined, cause);
        return;
      }

      turn.lastActivityAt = Date.now();
      this.armIdleTimer(turn);
      turn.resent = true;

      if (this.closed || turn.abandoned || turn.cancelRequested) {
        await this.finishTurn(turn, undefined, cause);
        return;
      }

      try {
        const promptOpts: { clientReqId: string; resumeOnly?: boolean } = {
          clientReqId: turn.commandId,
          ...(turn.recovered ? { resumeOnly: true } : {}),
        };
        const outcome = await this.opts.client.prompt(this.backendSessionId, text, promptOpts);
        if (this.closed || turn.abandoned || turn.cancelRequested) {
          await this.finishTurn(turn, undefined, cause);
          return;
        }
        await this.onPromptOutcome(turn, text, outcome);
        return;
      } catch (resendErr) {
        if (this.closed || turn.abandoned || turn.cancelRequested) {
          await this.finishTurn(turn, undefined, cause);
          return;
        }
        if (resendErr instanceof DisconnectedDuringTurn && this.opts.client.isHonk) {
          this.connected = false;
          if (turn.idleTimer) {
            clearTimeout(turn.idleTimer);
            turn.idleTimer = undefined;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const waitTime = Math.min(delay, maxDelay, remaining);
          delay = Math.min(delay * 2, maxDelay);
          this.log("honk resend disconnected, backing off and retrying reconnect", {
            sessionId: this.sessionId,
            commandId: turn.commandId,
            delay: waitTime,
          });
          await this.sleep(waitTime);
          continue;
        }
        this.log("honk resend failed with non-disconnect error", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          error: resendErr instanceof Error ? resendErr.message : String(resendErr),
        });
        await this.finishTurn(turn, undefined, resendErr);
        return;
      }
    }

    this.log("honk reconnect budget exhausted, reporting lost contact", {
      sessionId: this.sessionId,
      commandId: turn.commandId,
      budgetMs,
    });
    await this.finishTurn(
      turn,
      undefined,
      new Error("lost contact with honkd; the turn may still be running and its reply was not collected"),
    );
  }

  /**
   * Handles what `prompt()` actually returned, which is NOT always a receipt.
   *
   * `prompt()` resolves with `{kind:"busy", runId}` when the session already had
   * a run -- and goose does NOT persist a prompt it rejected as busy, so the
   * human's message has not been delivered at all. Treating that as a finished
   * turn (which an earlier version did, by casting it to a receipt) reported a
   * cheerful "finished with no message" while silently dropping what they typed.
   *
   * It is reachable whenever the session already has a run this connection did
   * not start: one started by another goose client on the same serve, or a run
   * of a connection pigeon just lost that goose has not finished cancelling yet
   * (unmeasured, but possible right after a half-open socket is abandoned). It
   * is NOT the "turn still finishing after a pigeon restart" case an earlier
   * note named: the restart closes the socket, and goose cancels that run.
   * Steering is the recovery, and it is safe because nothing was persisted --
   * but note that a run this connection did not start reports its receipt to
   * whoever started it, never to us, so a message steered into it gets no
   * notification here.
   */
  private async onPromptOutcome(turn: Turn, text: string, outcome: unknown): Promise<void> {
    const kind = (outcome as { kind?: string } | undefined)?.kind;
    if (kind === "unknown-request") {
      this.log("honkd reported unknown client_req_id for recovery prompt", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
      });
      if (this.turn === turn) this.clearTurn();
      try {
        await this.opts.postStop({
          session_id: this.sessionId,
          notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}`,
          message: "honkd has no record of this turn (it may never have arrived, or honkd lost it); nothing was resent.",
          event: "Error",
          error_kind: "honk-unknown-request",
        });
        this.retire(turn);
      } catch (reportErr) {
        this.log("goose runner: could not report unknown-request notice", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          error: reportErr instanceof Error ? reportErr.message : String(reportErr),
        });
      } finally {
        this.scheduleDrain();
      }
      return;
    }
    if (kind === "busy") {
      const runId = (outcome as { runId?: string }).runId;
      if (turn.recovered) {
        this.log("honkd rejected the recovery request as busy, reporting message not delivered", {
          sessionId: this.sessionId,
          runId,
        });
        if (this.turn === turn) this.clearTurn();
        try {
          await this.opts.postStop({
            session_id: this.sessionId,
            notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}`,
            message: "your message was not delivered (goose was busy); nothing was resent — send it again.",
            event: "Error",
            error_kind: "goose-busy-recovered",
          });
          this.retire(turn);
        } catch (reportErr) {
          this.log("goose runner: could not report busy-recovered notice", {
            sessionId: this.sessionId,
            commandId: turn.commandId,
            error: reportErr instanceof Error ? reportErr.message : String(reportErr),
          });
        } finally {
          this.scheduleDrain();
        }
        return;
      }
      if (turn.resent) {
        this.log("honkd rejected the resend as busy, reporting message not delivered", {
          sessionId: this.sessionId,
          runId,
        });
        await this.finishTurn(
          turn,
          undefined,
          new Error(BUSY_NOT_DELIVERED_TEXT),
        );
        return;
      }
      if (this.isHonk) {
        this.log("honkd rejected the prompt as busy; queueing turn instead of steering", {
          sessionId: this.sessionId,
          runId,
          commandId: turn.commandId,
        });
        try {
          this.opts.inflight?.markQueued(turn.commandId, Date.now());
        } catch (err) {
          this.log("goose runner: markQueued failed on busy", {
            sessionId: this.sessionId,
            commandId: turn.commandId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.turn === turn) {
          this.clearTurn();
        }
        const alreadyNoticeSent = turn.queuedNoticeSent ?? false;
        this.queue.unshift({ commandId: turn.commandId, text, queuedNoticeSent: true });
        this.armDrainFallbackTimer();

        if (!alreadyNoticeSent) {
          try {
            await this.opts.postStop({
              session_id: this.sessionId,
              notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}:queued`,
              message: QUEUED_NOTICE_MESSAGE,
              event: "Queued",
            });
          } catch (postErr) {
            this.log("goose runner: could not post queued notice on busy", {
              sessionId: this.sessionId,
              commandId: turn.commandId,
              error: postErr instanceof Error ? postErr.message : String(postErr),
            });
          }
        }
        return;
      }

      // Bare goose (client not honk): keep today's steer-after-busy (nothing tells pigeon when a foreign bare-goose run ends); a follow-up bead exists to handle bare-goose queueing.
      this.log("goose rejected the prompt as busy; steering the live turn instead", {
        sessionId: this.sessionId,
        runId,
      });
      try {
        // Bounded for the same reason as the other steer call site. This one is
        // in the detached continuation so it cannot freeze the poller, but an
        // unbounded await here leaves `this.turn` set forever -- the same wedge
        // through a different door.
        const steered = (await withDeadline(
          this.opts.client.steer(this.backendSessionId, runId ?? "", text),
          NON_TURN_TIMEOUT_MS,
          "steer",
        )) as { kind?: string };
        if (steered?.kind === "steered") {
          // The message is now inside the run that was already going. That run
          // reports its own completion, so this turn is over as a bookkeeping
          // matter and must not also report.
          if (this.turn === turn) this.clearTurn();
          this.retire(turn);
          this.scheduleDrain();
          return;
        }
      } catch (err) {
        this.log("goose steer after busy failed", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Could not steer and did not prompt: the message is genuinely lost, so
      // say so rather than reporting an empty success.
      await this.finishTurn(
        turn,
        undefined,
        new Error(BUSY_NOT_DELIVERED_TEXT),
      );
      return;
    }
    await this.finishTurn(turn, outcome as { stopReason?: string; text?: string }, undefined);
  }

  /** Feeds a `session/update` frame in. Must not throw: called from a socket callback. */
  onUpdate(update: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) return;

    // Liveness is stamped for EVERY frame, above the transcript filter below.
    // During a long tool call the only frames are tool_call/tool_call_update,
    // which contribute no transcript text at all -- so filtering first would
    // make a working turn look silent to the watchdog, which is precisely the
    // false positive that costs the human their answer.
    turn.lastActivityAt = Date.now();

    if (turn.recovered && this.runId()) {
      this.notifyRecoveryResolvedOrAttached();
    }

    const now = Date.now();
    if (!turn.lastAliveTouchAt || now - turn.lastAliveTouchAt >= TOUCH_ALIVE_INTERVAL_MS) {
      turn.lastAliveTouchAt = now;
      try {
        this.opts.inflight?.touchAlive(turn.commandId, now);
      } catch (err) {
        this.log("goose runner: touchAlive failed", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (update.sessionUpdate !== "agent_message_chunk") return;

    const text = (update.content as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || text === "") return;

    const cap = this.opts.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    if (turn.bytes >= cap) {
      turn.truncated = true;
      return;
    }
    turn.text.push(text);
    turn.bytes += text.length;
  }

  private runId(): string | undefined {
    return this.opts.client.activeRunId(this.backendSessionId);
  }

  private clearTurn(): void {
    if (this.turn?.idleTimer) clearTimeout(this.turn.idleTimer);
    this.turn = undefined;
    this.notifyRecoveryResolvedOrAttached();
    if (this.opts.client.isHonk && this.connected && !this.opts.client.isClosed() && !this.closed) {
      this.armIdleSocketTimer();
    }
    if (this.queue.length > 0) {
      this.armDrainFallbackTimer();
    }
  }

  /**
   * Arms (or re-arms) the silence timer for `turn`.
   *
   * Re-arms for the REMAINING time rather than firing on a fixed schedule, so a
   * frame that arrives at minute 29 buys another full timeout instead of being
   * rounded away by a coarse sweep. One timer per turn: no turn means no timer,
   * which is why there is no lifecycle to tear down anywhere else.
   */
  private armIdleTimer(turn: Turn): void {
    if (this.closed) return;
    const timeout = this.opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      const idleFor = Date.now() - turn.lastActivityAt;
      if (idleFor < timeout) {
        // Something arrived while we were waiting. Wait out the remainder.
        this.armIdleTimer(turn);
        return;
      }
      void this.checkStalled(turn, idleFor);
    }, timeout);
    // Never the reason the process stays alive.
    turn.idleTimer.unref?.();
  }

  /**
   * Decides whether a silent turn is dead or merely slow, by asking the socket.
   *
   * Silence alone cannot tell those apart, and the cost of guessing is
   * asymmetric but bad in both directions: abandoning a live turn loses the
   * human's answer outright, because abandoning means closing the socket the
   * answer would have come back on. A live probe replaces the guess with
   * evidence, so the timeout only has to be long enough to avoid pestering a
   * working turn -- not long enough to be SURE.
   *
   * If the socket answers, the turn is working and gets another full timeout.
   */
  private async checkStalled(turn: Turn, idleFor: number): Promise<void> {
    if (turn.abandoned || this.turn !== turn) return;

    try {
      await withDeadline(this.opts.client.ping(), NON_TURN_TIMEOUT_MS, "liveness ping");
    } catch (err) {
      await this.abandonTurn(
        turn,
        `no activity for ${Math.round(idleFor / 60_000)} minutes and the connection did not answer a liveness check`,
      );
      return;
    }

    // The turn can finish while the probe is in flight. Re-arming then would
    // leave a timer nothing can clear, because clearTurn no longer reaches it.
    if (turn.abandoned || this.turn !== turn) return;

    this.log("goose runner: turn is quiet but the socket is alive; still waiting", {
      sessionId: this.sessionId,
      commandId: turn.commandId,
      idleMinutes: Math.round(idleFor / 60_000),
    });
    // Treat the successful probe as activity: otherwise every subsequent tick
    // would re-probe immediately, once per timer interval, for the whole turn.
    turn.lastActivityAt = Date.now();
    this.armIdleTimer(turn);
  }

  /**
   * Gives up on a turn that is not talking to us, and unwedges the session.
   *
   * The runner must settle its OWN turn here. Closing the socket is not enough
   * and the inherited plan was wrong about this: `GooseAcpClient.close()` does
   * not touch its pending map, and a half-open socket may never deliver a close
   * event at all -- which is the exact case this exists for.
   *
   * Only reached when a liveness probe has already failed, so the socket is
   * known dead and the turn's result was never going to arrive over it. Closing
   * therefore costs nothing that was not already lost.
   *
   * The notice still carries a DISTINCT notification id. `/stop` dedups on that
   * id, so posting under the turn's normal one would claim it and silently eat
   * any later report for the same command -- and the late-receipt path in
   * `finishTurn` depends on that id being free.
   */
  private async abandonTurn(turn: Turn, reason: string): Promise<void> {
    if (this.suspended) {
      this.log("goose runner: turn abandoned while suspended; skipping report and keeping inflight row", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
      });
      return;
    }
    if (turn.abandoned || this.turn !== turn) return;
    turn.abandoned = true;
    this.connected = false;
    this.cancelSleep();
    try {
      this.opts.client.close();
    } catch {
      /* best effort */
    }
    this.clearTurn();
    this.clearIdleSocketTimer();

    this.log("goose runner: abandoning a stalled turn", {
      sessionId: this.sessionId,
      commandId: turn.commandId,
      reason,
    });

    try {
      const partial = turn.text.join("");
      const honkDetail = `The turn may still be running in honkd. ${honkResumeAdvice(turn.resent)}`;
      const bareDetail =
        "goose cancels a turn once it sees its connection close, so do not wait for this one: "
        + `no result is coming here. ${resumeAdvice(turn.resent)}`;
      await this.opts.postStop({
        session_id: this.sessionId,
        notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}:stalled`,
        message:
          (partial === "" ? "" : `${partial}\n\n`)
          + `goose stopped sending updates on this session (${reason}), so pigeon reset the connection. `
          + (this.opts.client.isHonk ? honkDetail : bareDetail),
        event: "Error",
        error_kind: "goose-turn-stalled",
      });
      this.retire(turn);
    } catch (reportErr) {
      this.log("goose runner: could not report a stalled turn", {
        sessionId: this.sessionId,
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      });
    } finally {
      this.scheduleDrain();
    }
  }

  /**
   * Reports the turn and clears it. MUST NOT THROW -- see the file header.
   */
  private async finishTurn(
    turn: Turn,
    receipt: { stopReason?: string; text?: string; honkReason?: string } | undefined,
    err: unknown,
  ): Promise<void> {
    if (this.turn === turn) this.clearTurn();

    if (this.suspended) {
      this.log("goose runner: turn finished while suspended; skipping report and keeping inflight row", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
      });
      return;
    }

    if (turn.cancelRequested) {
      this.log("goose runner: turn cancel was requested; skipping stop notification", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
      });
      this.retire(turn);
      this.scheduleDrain();
      return;
    }

    // A turn the watchdog already gave up on, settling late. The two cases mean
    // opposite things and are treated as such.
    if (turn.abandoned) {
      if (err !== undefined) {
        // Almost certainly the rejection caused by our own close(). The human
        // has already been told the turn stalled; a second failure notice for
        // one failure is noise.
        this.log("goose runner: abandoned turn failed as expected", {
          sessionId: this.sessionId,
          commandId: turn.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.retire(turn);
        return;
      }
      // goose was alive the whole time and has answered. The watchdog was wrong,
      // and the human still wants this -- so it is reported normally, under the
      // turn's own notification id, which the stall notice deliberately did not
      // take.
      this.log("goose runner: abandoned turn answered after all", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
      });
    }

    try {
      const stopReason = receipt?.stopReason;
      const failed = err !== undefined || (stopReason !== undefined && stopReason !== "end_turn");

      const cap = this.opts.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
      let message: string;
      let emptyReceipt = false;
      const accumulated = turn.text.join("");

      if (typeof receipt?.text === "string" && receipt.text !== "") {
        if (receipt.text.length > cap) {
          let sliceEnd = cap;
          const c = receipt.text.charCodeAt(sliceEnd - 1);
          if (c >= 0xd800 && c <= 0xdbff) {
            sliceEnd = cap - 1;
          }
          message = receipt.text.slice(0, sliceEnd) + TRUNCATION_NOTICE;
        } else {
          message = receipt.text;
        }
      } else if (receipt?.text === "") {
        // Honkd says goose ended the turn with no reply text.
        // On a recovered turn, honkd's "" is authoritative over post-restart chunks.
        // On a non-recovered turn, if the chunk accumulator has text, we trust the
        // chunks received during the live turn and warn; otherwise we report empty.
        if (!turn.recovered && accumulated !== "") {
          this.log(`honk text empty but ${accumulated.length} chars received`, {
            sessionId: this.sessionId,
            commandId: turn.commandId,
          });
          message = accumulated;
          if (turn.truncated) {
            message += TRUNCATION_NOTICE;
          }
        } else {
          emptyReceipt = true;
          message = stopReason && stopReason !== "end_turn"
            ? `goose ended the turn without a reply (stopReason: ${stopReason}).`
            : "goose ended the turn without a reply.";
        }
      } else if (turn.recovered) {
        message = accumulated
          ? `(pigeon restarted mid-turn; only output after the restart is shown)\n\n${accumulated}`
          : "goose reply text is unavailable (pigeon restarted mid-turn).";
      } else {
        message = accumulated;
        if (turn.truncated) {
          message += TRUNCATION_NOTICE;
        }
      }
      if (err instanceof DisconnectedDuringTurn) {
        // Said in the human's terms rather than as the raw error, because the
        // one thing they need to know -- that they should NOT wait for this
        // turn -- is otherwise buried after a close code and a run id.
        const advice = resumeAdvice(turn.resent);
        const detail =
          "The connection to goose dropped mid-turn, and goose cancels a turn when its connection "
          + `closes, so this turn was cancelled and will not finish. ${advice}`
          + ` (close code ${err.closeCode}${err.runId ? `, run ${err.runId}` : ""})`;
        message = message === "" || emptyReceipt ? detail : `${message}\n\n${detail}`;
      } else if (err !== undefined) {
        const detail = err instanceof Error ? err.message : String(err);
        message = message === "" || emptyReceipt ? detail : `${message}\n\n${detail}`;
      } else if (receipt?.stopReason === "cancelled" && receipt.honkReason === "not_delivered") {
        const detail = "The message was not delivered; please send it again.";
        message = message === "" || emptyReceipt ? detail : `${message}\n\n${detail}`;
      } else if (receipt?.stopReason === "cancelled" && receipt.honkReason === "upstream_restart") {
        const detail = "goose restarted and the turn was cancelled.";
        message = message === "" || emptyReceipt ? detail : `${message}\n\n${detail}`;
      } else if (receipt?.stopReason === "cancelled" && receipt.honkReason === "delivery_unknown") {
        const detail = "honkd could not confirm goose received this message; check the session before resending.";
        message = message === "" || emptyReceipt ? detail : `${message}\n\n${detail}`;
      } else if (message === "") {
        // A turn that ends with no assistant text is a real outcome (a pure tool
        // run, a refusal). Saying so beats an empty Telegram message, which the
        // human cannot distinguish from a bug in this code.
        message = `goose finished the turn with no message (stopReason: ${stopReason ?? "unknown"}).`;
      }

      await this.opts.postStop({
        session_id: this.sessionId,
        // The `/stop` route requires this exact prefix and a restricted charset;
        // an id failing either is dropped, silently taking idempotency with it.
        notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}`,
        message,
        event: failed ? "Error" : "Stop",
        ...(failed
          ? {
              error_kind:
                err instanceof DisconnectedDuringTurn
                  ? "goose-turn-disconnected"
                  : err !== undefined
                    ? "goose-turn-failed"
                    : `goose-stop-${stopReason}`,
            }
          : {}),
      });
      this.retire(turn);
    } catch (reportErr) {
      // Losing the report is bad; taking the process down with it is worse.
      this.log("goose runner: could not report finished turn", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      });
    } finally {
      this.scheduleDrain();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("goose runner is closed");
    }
    // A socket that closed under us leaves `connected` true, and sending into a
    // closed WebSocket is a SILENT no-op -- so without this the first blip would
    // wedge the session permanently (and, via an unanswerable steer, freeze
    // delivery for every session). Reconnecting is cheap and safe: a fresh
    // connection can prompt an existing goose session id and still has its
    // history, measured on 1.48.0.
    if (this.connected && this.opts.client.isClosed()) {
      this.log("goose connection closed underneath us, reconnecting", {
        sessionId: this.sessionId,
      });
      this.connected = false;
    }
    if (this.connected) return;
    // Collapse concurrent first-commands onto one handshake.
    if (!this.connecting) {
      this.connecting = withDeadline(this.opts.client.connect(), NON_TURN_TIMEOUT_MS, "handshake")
        .then(() => {
          if (this.closed) {
            try {
              this.opts.client.close();
            } catch {
              /* best effort */
            }
            throw new Error("goose runner is closed");
          }
          this.connected = true;
          this.connectedOnce = true;
        })
        .catch((err: unknown) => {
          // A handshake that timed out may have left a socket half-open. Close it
          // so a later attempt starts clean rather than inheriting a wedge, and
          // rethrow: nothing was sent, so the caller's throw is safe.
          try {
            this.opts.client.close();
          } catch {
            /* best effort */
          }
          throw err;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    await this.connecting;
  }

  private armIdleSocketTimer(): void {
    if (!this.opts.client.isHonk || this.closed) return;
    if (this.queue.length > 0) return;
    const timeout = this.opts.idleSocketTimeoutMs ?? DEFAULT_IDLE_SOCKET_TIMEOUT_MS;
    if (timeout <= 0) return;
    this.clearIdleSocketTimer();
    this.idleSocketTimer = setTimeout(() => {
      if (this.queue.length > 0) return;
      if (!this.turn && this.connected && !this.closed && this.opts.client.isHonk) {
        this.log("goose runner: closing idle socket after inactivity", {
          sessionId: this.sessionId,
        });
        this.closeSocket();
      }
    }, timeout);
    this.idleSocketTimer.unref?.();
  }

  private clearIdleSocketTimer(): void {
    if (this.idleSocketTimer) {
      clearTimeout(this.idleSocketTimer);
      this.idleSocketTimer = undefined;
    }
  }

  private closeSocket(): void {
    this.clearIdleSocketTimer();
    this.connected = false;
    try {
      this.opts.client.close();
    } catch {
      /* best effort */
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.closed) return;
    if (this.opts.sleep) {
      await new Promise<void>((resolve, reject) => {
        this.sleepResolve = resolve;
        this.opts.sleep!(ms).then(resolve, reject);
      }).finally(() => {
        this.sleepResolve = undefined;
      });
      return;
    }
    await new Promise<void>((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = undefined;
        this.sleepResolve = undefined;
        resolve();
      }, ms);
      this.sleepTimer.unref?.();
    });
  }

  private cancelSleep(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    if (this.sleepResolve) {
      const resolve = this.sleepResolve;
      this.sleepResolve = undefined;
      resolve();
    }
  }

  private sendCancel(): "sent" | "failed" {
    try {
      this.opts.client.cancel(this.backendSessionId);
      return "sent";
    } catch {
      return "failed";
    }
  }

  /**
   * Sends session/cancel to goose/honkd for this session.
   *
   * If the client is connected and not closed, sends cancel with the backend id
   * and returns "sent". Catches a throw and returns "failed".
   *
   * If not connected, connects with a bounded timeout (~3s):
   * - honkd (client.isHonk): turn may still be running; sends cancel -> "sent"
   * - bare goose: no connection means no turn; sends nothing -> "no-connection"
   * - failed or timed-out connect -> "failed"
   *
   * Leaves socket closing to close() / registry.drop().
   */
  async cancel(): Promise<"sent" | "no-connection" | "failed"> {
    if (this.turn) {
      this.turn.cancelRequested = true;
    }
    this.cancelSleep();

    if (this.connected && !this.opts.client.isClosed() && !this.closed) {
      return this.sendCancel();
    }

    try {
      await withDeadline(this.ensureConnected(), CANCEL_CONNECT_TIMEOUT_MS, "connect");
    } catch {
      return "failed";
    }

    if (this.opts.client.isHonk) {
      return this.sendCancel();
    }

    return "no-connection";
  }

  ownsActiveRun(): boolean {
    return this.opts.client.runOwnership?.(this.backendSessionId) === "own";
  }

  close(): void {
    this.closed = true;
    this.cancelSleep();
    this.clearIdleSocketTimer();
    this.clearDrainFallbackTimer();
    // The timer is unref'd, so it cannot hold the process open -- but a runner
    // dropped from the registry should not leave one running against a turn
    // nobody is listening for either.
    if (this.turn?.idleTimer) clearTimeout(this.turn.idleTimer);
    try {
      this.opts.client.close();
    } catch {
      // Closing is best-effort; a transport that is already gone is not an error.
    }
    this.connected = false;
  }
}

/** `/stop` notification ids are charset-restricted; keep ours inside it. */
export function sanitiseIdPart(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, "-");
  return cleaned === "" ? "turn" : cleaned.slice(0, 64);
}

export interface GooseRunnerRegistryOptions {
  createRunner: (session: SessionRecord) => GooseSessionRunner;
  inbox?: { markDone: (commandId: string) => void };
  inflight?: GooseInflightStore;
}

/**
 * One runner per session id.
 *
 * Turn state must not be split across two objects for the same session, or a
 * second message would start a competing turn instead of steering the live one.
 */
export class GooseRunnerRegistry {
  private readonly runners = new Map<string, GooseSessionRunner>();
  /**
   * The same runners, keyed by the id GOOSE knows them by.
   *
   * Needed because inbound `session/update` notifications come off the socket
   * carrying goose's id, which is not pigeon's (see
   * SessionRecord.backendSessionId). Kept in lockstep with `runners` --
   * every insertion and every removal touches both, or a dropped session stays
   * reachable here holding a live socket.
   */
  private readonly byBackendId = new Map<string, GooseSessionRunner>();

  constructor(private readonly opts: GooseRunnerRegistryOptions) {}

  get(session: SessionRecord): GooseSessionRunner {
    let runner = this.runners.get(session.sessionId);
    if (!runner) {
      runner = this.opts.createRunner(session);
      this.runners.set(session.sessionId, runner);
      this.byBackendId.set(backendSessionIdOf(session), runner);
    }
    return runner;
  }

  /** The live runner for a session, without creating one. */
  peek(sessionId: string): GooseSessionRunner | undefined {
    return this.runners.get(sessionId);
  }

  /**
   * The live runner for a session named by the BACKEND's id, for routing
   * inbound updates. Never creates one: an update for a session this daemon is
   * not running is not a reason to start running it.
   */
  peekByBackendId(backendSessionId: string): GooseSessionRunner | undefined {
    return this.byBackendId.get(backendSessionId);
  }

  get size(): number {
    return this.runners.size;
  }

  /** Forgets a session's runner, e.g. after /kill. */
  drop(sessionId: string): void {
    const runner = this.runners.get(sessionId);
    this.runners.delete(sessionId);
    // By identity rather than by deriving the backend id and deleting that key.
    // Deriving it would re-read the session record the runner was built with,
    // which is the one thing guaranteed to be stale if the row was ever
    // re-registered -- and a key computed from a stale record deletes nothing,
    // leaving a dropped runner reachable with a live socket. A scan cannot miss.
    // Both maps hold the same few entries, so it is free.
    if (runner) {
      for (const [backendId, r] of this.byBackendId) {
        if (r === runner) this.byBackendId.delete(backendId);
      }
    }
    runner?.close();
  }

  closeAll(): void {
    for (const runner of this.runners.values()) runner.close();
    this.runners.clear();
    this.byBackendId.clear();
  }

  /**
   * Suspends all runners on daemon shutdown (R7 ordering):
   * 1. Set suspended on all runners first so background continuations do not report or delete.
   * 2. For bare-goose runners with an active turn: post "cancelled by restart" via postStop
   *    under s:sid:cmd, then delete inflight row and inbox.markDone (R6). If postStop fails,
   *    row is kept for startup recovery.
   * 3. For honk runners with an active turn: markSuspended (clean_suspend=1, last_alive_at=now,
   *    recovery_attempts=0) and KEEP row, no notice.
   * 4. Close all runners and clear maps.
   */
  async suspendAll(opts?: {
    now?: number;
    inbox?: { markDone: (commandId: string) => void };
    inflight?: GooseInflightStore;
  }): Promise<void> {
    const now = opts?.now ?? Date.now();
    const inbox = opts?.inbox ?? this.opts.inbox;
    const inflight = opts?.inflight ?? this.opts.inflight;

    // R7: set suspended on all runners FIRST
    for (const runner of this.runners.values()) {
      runner.suspend();
    }

    // Process all active turns
    for (const runner of this.runners.values()) {
      const turn = runner.activeTurn;
      if (!turn) continue;

      const inflightRow = inflight?.get(turn.commandId);
      const isHonk = inflightRow !== undefined ? inflightRow.isHonk : runner.isHonk;

      if (isHonk) {
        // Honk runner: markSuspended and keep row, no notice
        try {
          inflight?.markSuspended(turn.commandId, now);
        } catch {
          /* best effort */
        }
      } else {
        // Bare goose runner: post notice via postStop, delete row + inbox.markDone
        try {
          await runner.postShutdownNotice(turn.commandId);
          inflight?.delete(turn.commandId);
          inbox?.markDone(turn.commandId);
        } catch {
          // If post fails, row survives and startup recovery posts the same notice under same id
        }
      }
    }

    this.closeAll();
  }

  /** Sessions with a turn in flight — used to warn the human on shutdown. */
  busySessionIds(): string[] {
    return [...this.runners.values()].filter((r) => r.isBusy()).map((r) => r.sessionId);
  }
}

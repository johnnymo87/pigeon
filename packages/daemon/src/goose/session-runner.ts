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
 *  - There is NO cancel or interrupt method on the ACP surface at all, and a turn
 *    survives a client disconnect. Once a turn starts, it finishes. That is why
 *    this module has no cancellation path: there is nothing to call.
 *  - A fresh connection can prompt an EXISTING session id and still has its
 *    history, so reconnecting is cheap and a daemon restart does not orphan a
 *    session.
 */
import type { SessionRecord } from "../storage/types.js";

/** The slice of GooseAcpClient the runner needs. Structural, so tests can fake it. */
export interface RunnerClient {
  connect(): Promise<void>;
  /** True once the socket has closed, so the runner knows to reconnect. */
  isClosed(): boolean;
  /** Round-trips a cheap request; never settles on a dead socket. */
  ping(): Promise<void>;
  prompt(sessionId: string, text: string): Promise<unknown>;
  steer(sessionId: string, expectedRunId: string, text: string): Promise<unknown>;
  activeRunId(sessionId: string): string | undefined;
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
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Transcript buffer cap. A runaway turn must not be able to exhaust memory. */
  maxTranscriptBytes?: number;
  /** Silence after which a turn is presumed dead. Defaults to 30 minutes. */
  turnIdleTimeoutMs?: number;
}

interface Turn {
  commandId: string;
  startedAt: number;
  /** Last time ANY frame arrived for this turn. The watchdog's only input. */
  lastActivityAt: number;
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
}

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024;

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
  private connecting: Promise<void> | undefined;

  constructor(opts: GooseSessionRunnerOptions) {
    this.opts = opts;
  }

  get sessionId(): string {
    return this.opts.session.sessionId;
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
   * Throws only for failures provably before anything was sent -- which is the
   * `failurePolicy: "surface"` contract's definition of a safe throw, because
   * redelivery then cannot duplicate a prompt.
   */
  async deliver(commandId: string, text: string): Promise<DeliverOutcome> {
    // Redelivery of the command that started the turn we are already running.
    // The poller redelivers whenever an ack fails; without this the human's
    // message goes into goose twice.
    if (this.turn?.commandId === commandId) {
      return { ok: true, meta: { mode: "already-running", runId: this.runId() } };
    }

    await this.ensureConnected();

    // A turn is in flight, so this message steers it rather than starting a
    // competing one. goose would reject a second prompt as busy anyway; steering
    // is what the human actually means by sending a message mid-turn.
    if (this.turn) {
      // Captured, not re-read after the awaits below. The watchdog can settle
      // and clear this turn while the steer is in flight, and TypeScript's
      // narrowing does not survive an await even though the field can change
      // under it -- so re-reading `this.turn` in the catch could hand `undefined`
      // to abandonTurn and turn a bounded steer timeout into a thrown TypeError.
      const steeringTurn = this.turn;
      const runId = this.runId();
      if (!runId) {
        // The turn is starting but has not yet announced its run id. Nothing has
        // been sent, so this is a safe permanent-shaped refusal rather than a
        // throw: a redelivery storm here would just race the same gap again.
        return {
          ok: false,
          error: "goose is starting a turn for this session; send that again in a few seconds",
          meta: { mode: "no-run-id-yet" },
        };
      }
      let outcome: { kind?: string };
      try {
        outcome = (await withDeadline(
          this.opts.client.steer(this.sessionId, runId, text),
          NON_TURN_TIMEOUT_MS,
          "steer",
        )) as { kind?: string };
      } catch (err) {
        // A steer answers in about a millisecond, so ten seconds of silence on
        // one is good evidence the socket is dead -- and it arrives the moment a
        // human touches a wedged session, rather than after the watchdog's thirty
        // minutes. But the same rule applies here as in checkStalled: silence is
        // not proof, and abandoning a live turn costs the human their answer. So
        // confirm with a liveness probe before giving up, and merely decline if
        // the socket answers.
        try {
          await withDeadline(this.opts.client.ping(), NON_TURN_TIMEOUT_MS, "liveness ping");
          this.log("goose runner: steer timed out but the socket is alive", {
            sessionId: this.sessionId,
          });
        } catch {
          await this.abandonTurn(steeringTurn, "a steer and a liveness check both went unanswered");
        }
        // Deliberately ok:false rather than a throw. A throw would redeliver and
        // could steer twice; more importantly the alternative to bounding this at
        // all is a frozen poller, which costs every other session on the machine.
        return {
          ok: false,
          error: `goose did not acknowledge the steer: ${err instanceof Error ? err.message : String(err)}`,
          meta: { mode: "steer-timeout" },
        };
      }
      if (outcome?.kind === "steered") {
        this.opts.touch(this.sessionId);
        return { ok: true, meta: { mode: "steered", runId } };
      }
      // `no-active-run`: the turn ended between our check and the steer. A fresh
      // prompt is now the correct action, so fall through rather than fail.
      this.log("goose steer found no active run, starting a fresh turn", {
        sessionId: this.sessionId,
      });
      this.clearTurn();
    }

    return this.startTurn(commandId, text);
  }

  /**
   * Sends the prompt and attaches the continuation.
   *
   * `client.prompt` writes to the transport synchronously before returning its
   * promise, so by the time this function returns the command HAS been sent.
   * That is what makes "throw means nothing was sent" true for callers.
   */
  private startTurn(commandId: string, text: string): DeliverOutcome {
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
    };
    this.turn = turn;
    this.opts.touch(this.sessionId);
    this.armIdleTimer(turn);

    this.lastSettled = turn.settled = this.opts.client
      .prompt(this.sessionId, text)
      .then(
        (outcome) => this.onPromptOutcome(turn, text, outcome),
        (err: unknown) => this.finishTurn(turn, undefined, err),
      )
      .catch((err: unknown) => {
        // finishTurn is written not to throw. If it somehow does, this is the
        // difference between a logged anomaly and a dead daemon.
        this.log("goose runner: turn continuation threw", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return { ok: true, meta: { mode: "prompt", commandId } };
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
   * It is reachable on the ordinary path: pigeon restarts, a turn is still
   * running on goose's side, and the next message opens a fresh connection that
   * knows nothing about it. Steering is the correct recovery, and it is safe
   * precisely because nothing was persisted.
   */
  private async onPromptOutcome(turn: Turn, text: string, outcome: unknown): Promise<void> {
    const kind = (outcome as { kind?: string } | undefined)?.kind;
    if (kind === "busy") {
      const runId = (outcome as { runId?: string }).runId;
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
          this.opts.client.steer(this.sessionId, runId ?? "", text),
          NON_TURN_TIMEOUT_MS,
          "steer",
        )) as { kind?: string };
        if (steered?.kind === "steered") {
          // The message is now inside the run that was already going. That run
          // reports its own completion, so this turn is over as a bookkeeping
          // matter and must not also report.
          if (this.turn === turn) this.clearTurn();
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
        new Error(
          "goose was already running a turn and pigeon could not add this message to it. "
            + "It was NOT delivered -- please send it again once the current turn finishes.",
        ),
      );
      return;
    }
    await this.finishTurn(turn, outcome as { stopReason?: string }, undefined);
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
    return this.opts.client.activeRunId(this.sessionId);
  }

  private clearTurn(): void {
    if (this.turn?.idleTimer) clearTimeout(this.turn.idleTimer);
    this.turn = undefined;
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
    if (turn.abandoned || this.turn !== turn) return;
    turn.abandoned = true;
    this.clearTurn();

    this.log("goose runner: abandoning a stalled turn", {
      sessionId: this.sessionId,
      commandId: turn.commandId,
      reason,
    });

    // Drop the socket so the next delivery reconnects onto a live one. Safe to
    // do before reporting: the transport callbacks are fenced on identity, so
    // this socket's eventual close cannot disturb the connection that replaces it.
    try {
      this.opts.client.close();
    } catch {
      /* best effort */
    }
    this.connected = false;

    try {
      const partial = turn.text.join("");
      await this.opts.postStop({
        session_id: this.sessionId,
        notification_id: `s:${this.sessionId}:${sanitiseIdPart(turn.commandId)}:stalled`,
        message:
          (partial === "" ? "" : `${partial}\n\n`)
          + `goose stopped sending updates on this session (${reason}), so pigeon reset the connection. `
          + "goose cannot be interrupted, so if that turn is still running it will finish on goose's side -- "
          + "but its result will NOT appear here, because the connection it would have come back on is gone. "
          + "The session history is intact, so send a message to pick it up.",
        event: "Error",
        error_kind: "goose-turn-stalled",
      });
    } catch (reportErr) {
      this.log("goose runner: could not report a stalled turn", {
        sessionId: this.sessionId,
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      });
    }
  }

  /**
   * Reports the turn and clears it. MUST NOT THROW -- see the file header.
   */
  private async finishTurn(
    turn: Turn,
    receipt: { stopReason?: string } | undefined,
    err: unknown,
  ): Promise<void> {
    if (this.turn === turn) this.clearTurn();

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

      let message = turn.text.join("");
      if (turn.truncated) {
        message += "\n\n[... truncated: the turn produced more output than pigeon buffers]";
      }
      if (err !== undefined) {
        const detail = err instanceof Error ? err.message : String(err);
        message = message === "" ? detail : `${message}\n\n${detail}`;
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
          ? { error_kind: err !== undefined ? "goose-turn-failed" : `goose-stop-${stopReason}` }
          : {}),
      });
    } catch (reportErr) {
      // Losing the report is bad; taking the process down with it is worse.
      this.log("goose runner: could not report finished turn", {
        sessionId: this.sessionId,
        commandId: turn.commandId,
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      });
    }
  }

  private async ensureConnected(): Promise<void> {
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
          this.connected = true;
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

  close(): void {
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
function sanitiseIdPart(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, "-");
  return cleaned === "" ? "turn" : cleaned.slice(0, 64);
}

export interface GooseRunnerRegistryOptions {
  createRunner: (session: SessionRecord) => GooseSessionRunner;
}

/**
 * One runner per session id.
 *
 * Turn state must not be split across two objects for the same session, or a
 * second message would start a competing turn instead of steering the live one.
 */
export class GooseRunnerRegistry {
  private readonly runners = new Map<string, GooseSessionRunner>();

  constructor(private readonly opts: GooseRunnerRegistryOptions) {}

  get(session: SessionRecord): GooseSessionRunner {
    let runner = this.runners.get(session.sessionId);
    if (!runner) {
      runner = this.opts.createRunner(session);
      this.runners.set(session.sessionId, runner);
    }
    return runner;
  }

  /** The live runner for a session, without creating one. */
  peek(sessionId: string): GooseSessionRunner | undefined {
    return this.runners.get(sessionId);
  }

  get size(): number {
    return this.runners.size;
  }

  /** Forgets a session's runner, e.g. after /kill. */
  drop(sessionId: string): void {
    const runner = this.runners.get(sessionId);
    this.runners.delete(sessionId);
    runner?.close();
  }

  closeAll(): void {
    for (const runner of this.runners.values()) runner.close();
    this.runners.clear();
  }

  /** Sessions with a turn in flight — used to warn the human on shutdown. */
  busySessionIds(): string[] {
    return [...this.runners.values()].filter((r) => r.isBusy()).map((r) => r.sessionId);
  }
}

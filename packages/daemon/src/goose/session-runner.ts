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
}

interface Turn {
  commandId: string;
  startedAt: number;
  text: string[];
  bytes: number;
  truncated: boolean;
  settled: Promise<void>;
}

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024;

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

  /** Resolves when the in-flight turn (if any) has been fully reported. */
  async settled(): Promise<void> {
    await this.turn?.settled;
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
      text: [],
      bytes: 0,
      truncated: false,
      settled: Promise.resolve(),
    };
    this.turn = turn;
    this.opts.touch(this.sessionId);

    turn.settled = this.opts.client
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
        const steered = (await this.opts.client.steer(this.sessionId, runId ?? "", text)) as {
          kind?: string;
        };
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
    this.turn = undefined;
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

/**
 * A supervised ACP client for a `goose serve` session.
 *
 * WHY THIS EXISTS, AND WHY IT LOOKS NOTHING LIKE `OpencodeClient`
 * ---------------------------------------------------------------
 * opencode's `prompt_async` returns HTTP 204 immediately and tells you nothing
 * about the turn, so pigeon SYNTHESISES a receipt afterwards by reading the
 * transcript (`swarm/delivery-watchdog.ts`, ~1650 lines). goose does not need
 * that: measured against a real serve (SDD §17), `session/prompt` does not
 * return until the turn ENDS, and its result carries `stopReason`. The receipt
 * is in the protocol.
 *
 * Four measured facts shape this class. Each is a fact, not an inference:
 *
 * 1. THE CALL IS THE TURN (§17 Q1). Observed returns of 3.7s-13.3s for toy
 *    prompts; real lane turns run minutes. So there is deliberately NO
 *    client-side deadline here. `OpencodeClient` caps every call at 30s
 *    (`opencode-client.ts:50`) because a never-settling promise wedges a
 *    per-target slot -- correct there, fatal here, since a timeout is
 *    classified retryable and would resend a prompt whose turn is still
 *    running. "Still running" must read as healthy.
 *
 * 2. BUSY IS EXPLICIT AND CLEAN (§17 Q2, Q4). Prompting a busy session is
 *    refused in ~1ms with the active run id, and the refused payload is NOT
 *    persisted. So busy is not a failure, it is a routing signal, and it can
 *    never duplicate. It is returned as a value, not thrown.
 *
 * 3. STEER IS COMPARE-AND-SWAP (§17.3). `expectedRunId` is a CAS token, so a
 *    steer cannot land in a different turn than the one observed. A stale token
 *    is refused with "no active run to steer" -- also a value, not a throw,
 *    because losing the race is an ordinary outcome.
 *
 * 4. DISCONNECT IS SILENT LOSS (§17 Q6, hazard R1). This is the dangerous one.
 *    When the socket drops mid-turn, goose keeps the user message in the
 *    session's history and never runs it -- the same shape as opencode's
 *    founding bug, and a pigeon restart mid-turn is a ROUTINE event, not an
 *    exotic one. So it gets its own error class rather than a generic throw,
 *    and it says out loud that the payload may already exist without a turn.
 *    Nothing here retries automatically: a blind replay is exactly how that
 *    persisted-but-unrun message becomes a duplicate. Retry is the caller's
 *    decision, made with the row state in front of it.
 */

export interface AcpTransport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(): void;
}

export type AcpTransportFactory = (url: string) => AcpTransport | Promise<AcpTransport>;

/** Turn finished; `stopReason` is goose's own report of how. */
export interface GooseReceipt {
  kind: "receipt";
  stopReason: string;
  usage?: unknown;
}
/** Session already has a run; use {@link GooseAcpClient.steer} with this id. */
export interface GooseBusy {
  kind: "busy";
  runId: string;
}
/** Steer landed inside the running turn. */
export interface GooseSteered {
  kind: "steered";
  runId: string;
  messageId: string;
}
/** The turn we meant to steer had already ended. Ordinary, not exceptional. */
export interface GooseNoActiveRun {
  kind: "no-active-run";
}

export type PromptOutcome = GooseReceipt | GooseBusy;
export type SteerOutcome = GooseSteered | GooseNoActiveRun;

/**
 * The socket dropped while a turn was outstanding (hazard R1).
 *
 * Carries the ids a caller needs to decide what to do, and deliberately does
 * NOT decide for them. The prompt may already be sitting in goose's session
 * history with no run behind it, so "send it again" and "leave it" are both
 * defensible and only the delivery row's state can choose between them.
 */
export class DisconnectedDuringTurn extends Error {
  readonly sessionId: string;
  readonly runId: string | undefined;
  readonly closeCode: number;
  constructor(sessionId: string, runId: string | undefined, closeCode: number) {
    super(
      `goose connection closed (code ${closeCode}) while a turn was outstanding for session ${sessionId}` +
        (runId ? ` (run ${runId})` : "") +
        `; the prompt may already be persisted in the session with no turn behind it, so it is NOT resent automatically`,
    );
    this.name = "DisconnectedDuringTurn";
    this.sessionId = sessionId;
    this.runId = runId;
    this.closeCode = closeCode;
  }
}

/** A JSON-RPC error that is not one of the modelled protocol outcomes. */
export class GooseProtocolError extends Error {
  readonly code: number;
  readonly data: string | undefined;
  constructor(code: number, message: string, data?: string) {
    super(data ? `${message}: ${data}` : message);
    this.name = "GooseProtocolError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Chooses an option for a mid-turn `session/request_permission` (hazard R6).
 * An UNANSWERED request stalls the turn indefinitely, so this always answers.
 */
export type PermissionPolicy = (params: PermissionParams) => string | undefined;

export interface PermissionParams {
  sessionId?: string;
  options: Array<{ optionId?: string; name?: string; kind?: string }>;
  toolCall?: unknown;
}

export interface GooseAcpClientOptions {
  url: string;
  transportFactory: AcpTransportFactory;
  /**
   * Defaults to REFUSING. The lane's whole safety model is about what the agent
   * may do unattended, so a client that silently allowed anything a serve asked
   * for would quietly relocate that decision into a transport class. Callers
   * that want auto-approval must say so.
   */
  permissionPolicy?: PermissionPolicy;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  onTurnLost?: (err: DisconnectedDuringTurn) => void;
}

interface Pending {
  resolve: (v: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  sessionId?: string;
  isTurn: boolean;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
  method?: string;
  params?: Record<string, unknown>;
}

const BUSY_RUN_ID = /session already has active run `(run_[^`]+)`/;
const NO_ACTIVE_RUN = /no active run to steer/i;

export class GooseAcpClient {
  private readonly opts: GooseAcpClientOptions;
  private transport: AcpTransport | undefined;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  /** Last run id observed for a session, learned from a busy rejection. */
  private runIds = new Map<string, string>();

  constructor(opts: GooseAcpClientOptions) {
    this.opts = opts;
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(msg, fields);
  }

  async connect(): Promise<void> {
    const transport = await this.opts.transportFactory(this.opts.url);
    this.transport = transport;
    transport.onMessage((data) => this.onMessage(data));
    transport.onClose((code, reason) => this.onClose(code, reason));
    await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.log("goose acp connected", { url: this.opts.url });
  }

  /** Opens a new session and returns its id. */
  async newSession(cwd: string): Promise<string> {
    const res = await this.call("session/new", { cwd, mcpServers: [] });
    const sid = res.result?.sessionId;
    if (typeof sid !== "string") {
      throw new GooseProtocolError(-1, "session/new returned no sessionId");
    }
    return sid;
  }

  /**
   * Sends a prompt and waits for the TURN to end. May take minutes; that is
   * normal and is not a stall (see fact 1 in the file header).
   */
  async prompt(sessionId: string, text: string): Promise<PromptOutcome> {
    const res = await this.call(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { sessionId, isTurn: true },
    );
    if (res.error) {
      const busy = BUSY_RUN_ID.exec(res.error.data ?? "");
      if (busy) {
        const runId = busy[1]!;
        this.runIds.set(sessionId, runId);
        this.log("goose session busy", { sessionId, runId });
        return { kind: "busy", runId };
      }
      throw new GooseProtocolError(res.error.code, res.error.message, res.error.data);
    }
    const stopReason = res.result?.stopReason;
    if (typeof stopReason !== "string") {
      throw new GooseProtocolError(-1, "session/prompt returned no stopReason");
    }
    this.runIds.delete(sessionId);
    return { kind: "receipt", stopReason, usage: res.result?.usage };
  }

  /** Injects into the RUNNING turn identified by `expectedRunId` (CAS). */
  async steer(sessionId: string, expectedRunId: string, text: string): Promise<SteerOutcome> {
    const res = await this.call(
      "_goose/unstable/session/steer",
      { sessionId, expectedRunId, prompt: [{ type: "text", text }] },
      { sessionId, isTurn: false },
    );
    if (res.error) {
      if (NO_ACTIVE_RUN.test(res.error.data ?? "")) {
        this.runIds.delete(sessionId);
        return { kind: "no-active-run" };
      }
      throw new GooseProtocolError(res.error.code, res.error.message, res.error.data);
    }
    return {
      kind: "steered",
      runId: String(res.result?.runId ?? expectedRunId),
      messageId: String(res.result?.messageId ?? ""),
    };
  }

  close(): void {
    this.transport?.close();
  }

  private call(
    method: string,
    params: Record<string, unknown>,
    meta: { sessionId?: string; isTurn: boolean } = { isTurn: false },
  ): Promise<JsonRpcResponse> {
    const transport = this.transport;
    if (!transport) throw new Error("goose acp client is not connected");
    const id = String(++this.nextId);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sessionId: meta.sessionId, isTurn: meta.isTurn });
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private onMessage(data: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data) as JsonRpcResponse;
    } catch {
      this.log("goose acp: unparseable frame", { bytes: data.length });
      return;
    }

    // Server->client REQUEST (has both id and method). Must be answered or the
    // turn stalls forever -- hazard R6.
    if (msg.id !== undefined && msg.method) {
      this.answerServerRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        this.pending.delete(String(msg.id));
        p.resolve(msg);
      }
      return;
    }
    // Notification: progress only. Deliberately not surfaced as delivery
    // evidence -- the receipt is the return value, and treating chunks as
    // proof-of-life is how the opencode watchdog grew to 1650 lines.
  }

  private answerServerRequest(msg: JsonRpcResponse): void {
    const params = (msg.params ?? {}) as unknown as PermissionParams;
    const options = Array.isArray(params.options) ? params.options : [];
    const chosen = this.opts.permissionPolicy
      ? this.opts.permissionPolicy(params)
      : refuse(options);
    const optionId = chosen ?? refuse(options);
    this.log("goose acp: answered server request", { method: msg.method, optionId });
    this.transport?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: optionId ? { outcome: { outcome: "selected", optionId } } : {},
      }),
    );
  }

  private onClose(code: number, reason: string): void {
    this.log("goose acp closed", { code, reason, outstanding: this.pending.size });
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, p] of entries) {
      if (p.isTurn && p.sessionId) {
        const err = new DisconnectedDuringTurn(p.sessionId, this.runIds.get(p.sessionId), code);
        this.opts.onTurnLost?.(err);
        p.reject(err);
      } else {
        p.reject(new GooseProtocolError(-1, `connection closed (code ${code}) before reply`));
      }
    }
  }
}

/** Prefer an explicit reject option; fall back to the last (conventionally the
 * most restrictive) rather than the first, which is conventionally "allow". */
function refuse(options: PermissionParams["options"]): string | undefined {
  const rejectish = options.find((o) => /reject|deny|no/i.test(o.optionId ?? o.name ?? ""));
  return rejectish?.optionId ?? options[options.length - 1]?.optionId;
}

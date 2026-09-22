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

/**
 * An extension to load into a session, in goose's `session/new` wire shape
 * (v1.48.0 goose-sdk-types/src/custom_requests.rs:326, serde `tag = "type"`).
 *
 * `available_tools` is goose's per-extension tool ALLOWLIST -- snake_case on
 * the wire, because serde's `rename_all = "camelCase"` applies to the variant
 * TAG and not to variant fields. It is not used by pigeon today and is surfaced
 * only so that narrowing below whole-extension granularity does not require
 * changing this type later.
 *
 * Note the empty array does NOT mean "no tools": goose `unwrap_or_default`s it
 * and an empty allowlist permits everything (v1.48.0
 * acp/server/extensions.rs:312,332). Omit it or list tools; never pass `[]`
 * expecting a deny.
 */
export type GooseExtensionSpec =
  | { type: "builtin"; name: string; available_tools?: string[] }
  | { type: "platform"; name: string; available_tools?: string[] };

/**
 * The extensions a session gets beyond the serve's floor: NONE.
 *
 * Not a restatement of the floor, deliberately. Under `goose serve --builtins X`
 * goose puts X in `explicit` and leaves `defaults` EMPTY (v1.48.0
 * acp/server.rs:301), so `developer` is then not in the floor at all -- and a
 * client that "helpfully" restated it would re-add shell/edit/write to a
 * session the operator had deliberately narrowed. `[]` is the only request that
 * can never widen one.
 */
export const DEFAULT_SESSION_EXTENSIONS: GooseExtensionSpec[] = [];

/**
 * What a bare `goose serve` loads unconditionally, and therefore what the
 * verification below must not mistake for surplus.
 *
 * This is a claim about the SERVE PROCESS, which lives in a systemd unit in
 * another repo -- the client cannot read its flags, only be told what to
 * expect. That is on purpose: if the two ever disagree, session/new fails
 * loudly instead of silently widening.
 */
export const DEFAULT_SERVE_FLOOR = ["developer"];

/**
 * goose reports each extension's `name()`, which for ONE extension differs from
 * the key used by config and by the wire: `extensionmanager` reports itself as
 * "Extension Manager" (v1.48.0 platform_extensions/ext_manager.rs:20). Every
 * other extension reports something key-shaped -- `tom` is "tom", not "Top Of
 * Mind" -- so this is a single special case rather than a general display-name
 * convention, and a caller should still request extensions by KEY.
 *
 * MEASURED: a live serve returned exactly "Extension Manager" in
 * `extensionResults`. Comparing the two forms raw would both miss surplus and
 * reject a legitimate request, so both sides of every comparison go through
 * this.
 */
function normaliseExtensionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface GooseAcpClientOptions {
  url: string;
  transportFactory: AcpTransportFactory;
  /**
   * Extensions to load beyond the serve's floor. Defaults to NONE.
   *
   * Session creation is a containment decision, not a transport detail: goose
   * 1.48.0 (acp/server.rs:581-611) treats a `session/new` with no recipe and no
   * `_meta.enabledExtensions` as permission to load the HOST's entire
   * config.yaml -- which on the machine this was written for meant handing
   * every session `summon` (the `delegate` tool, whose subagents get no hook
   * policy at all), `Extension Manager` (which can enable further extensions at
   * runtime), and `scheduler`. Bead eng-agent-platform-li6.
   *
   * So this defaults closed, for the same reason `permissionPolicy` does. A
   * floor-only default is not pigeon choosing a policy; it is the ABSENCE of a
   * widening decision. Every widening is authored by a caller who can be asked
   * why.
   *
   * Note this cannot narrow below the floor -- extensions are additive under
   * ACP and nothing a client sends subtracts (bead eng-agent-platform-jio).
   * Floor-only still ships `shell`, `edit` and `write`; it closes the policy
   * escape and the self-widening, not the session's teeth.
   */
  sessionExtensions?: GooseExtensionSpec[];
  /**
   * What the serve loads unconditionally, so the post-create check can tell
   * surplus from floor. Override when the serve runs with `--builtins`.
   */
  serveFloor?: string[];
  /**
   * Defaults to REFUSING. The lane's whole safety model is about what the agent
   * may do unattended, so a client that silently allowed anything a serve asked
   * for would quietly relocate that decision into a transport class. Callers
   * that want auto-approval must say so.
   */
  permissionPolicy?: PermissionPolicy;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  onTurnLost?: (err: DisconnectedDuringTurn) => void;
  /**
   * Called for every `session/update` notification, which is goose's ONLY
   * streaming surface: assistant text (`agent_message_chunk`), tool activity
   * (`tool_call`, `tool_call_update`), token usage, and the run id.
   *
   * Deliberately NOT delivery evidence — the receipt is still `prompt()`'s
   * return value, for the reason the fall-through in `onMessage` gives. This is
   * for showing the human what is happening and for liveness.
   *
   * Runs inside the transport's message callback, so it MUST NOT throw; this
   * client guards it anyway, because the guard is cheap and the failure it
   * prevents (an exception escaping into a socket handler, surfacing as an
   * unhandled rejection, killing the process for every session) is not.
   */
  onSessionUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
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
  /**
   * Set when the socket has closed under us.
   *
   * Load-bearing, because a closed WebSocket's `send()` DOES NOT THROW (verified
   * on node 22.22.2: readyState 3, silent no-op). Without this flag a caller
   * that believed it was still connected would write frames into a void and wait
   * forever for a reply that cannot arrive -- and since delivery is serial, one
   * such wait freezes command delivery for every session on the machine.
   */
  private closed = false;
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

  /** True once the socket has closed; the caller should discard this client. */
  isClosed(): boolean {
    return this.closed;
  }

  async connect(): Promise<void> {
    const transport = await this.opts.transportFactory(this.opts.url);
    this.transport = transport;
    this.closed = false;
    // Both callbacks are fenced on transport identity. A socket we have replaced
    // can still fire -- a half-open one sits in CLOSING until the kernel gives up
    // on the unacked close frame, which is minutes -- and an unfenced listener
    // would then reject the CURRENT connection's turn as DisconnectedDuringTurn
    // and clear its run ids, telling the human a healthy turn was lost. The
    // zombie has nothing to say about the connection that replaced it.
    transport.onMessage((data) => {
      if (this.transport !== transport) return;
      this.onMessage(data);
    });
    transport.onClose((code, reason) => {
      if (this.transport !== transport) return;
      this.onClose(code, reason);
    });
    await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.log("goose acp connected", { url: this.opts.url });
  }

  /**
   * Round-trips a cheap request to prove the socket is still alive.
   *
   * Silence on a turn cannot distinguish a dead socket from a tool call that is
   * simply taking a long time, and guessing wrong in either direction is
   * expensive: abandon a live turn and the human loses the answer, keep faith in
   * a dead one and the session is wedged forever. This asks.
   *
   * `initialize` is the probe because it is already on the allowlist, is
   * side-effect free, and -- measured against goose 1.48.0 -- answers in ~1ms
   * mid-turn without disturbing the run in flight (the turn still completed with
   * stopReason end_turn afterwards). The RESULT is ignored entirely; an error
   * reply would prove liveness just as well as a success. Only the round trip
   * matters.
   *
   * Callers must impose their own deadline: there is deliberately no timeout in
   * this client (see fact 1 in the header), and on a dead socket this never
   * settles at all, which is precisely the signal being looked for.
   */
  async ping(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  }

  /**
   * Opens a new session and returns its id.
   *
   * Sends `_meta.enabledExtensions` ALWAYS, including when it is empty, because
   * absent is the dangerous value: goose keys off presence, and both `undefined`
   * and `null` select the fall-back-to-host-config branch
   * (v1.48.0 acp/server/new_session.rs:327, acp/server.rs:599-607).
   *
   * Then VERIFIES what actually loaded rather than trusting that the request was
   * honoured. A serve on another version, or one started with `--builtins
   * summon`, would otherwise reintroduce li6 silently -- the request would look
   * right in the diff and the session would be wide open. The response carries
   * `_meta.extensionResults` for exactly this (acp/response_builder.rs:80-94).
   *
   * `mcpServers` stays in the params because ACP's schema declares it, but goose
   * IGNORES it whenever `_meta.enabledExtensions` is present: `add_mcp_servers`
   * is reached only from the else branch (acp/server.rs:607). MCP servers would
   * travel as `enabledExtensions` entries of `type: "mcp"`. It is left empty and
   * deliberately not exposed as an option, so nothing can come to depend on a
   * parameter that silently does nothing.
   */
  async newSession(cwd: string): Promise<string> {
    const requested = this.opts.sessionExtensions ?? DEFAULT_SESSION_EXTENSIONS;
    const res = await this.call("session/new", {
      cwd,
      mcpServers: [],
      _meta: { enabledExtensions: requested },
    });
    const sid = res.result?.sessionId;
    if (typeof sid !== "string") {
      throw new GooseProtocolError(-1, "session/new returned no sessionId");
    }
    this.assertNoSurplusExtensions(sid, requested, res.result);
    return sid;
  }

  /**
   * Refuses a session that loaded anything beyond floor + what was asked for.
   *
   * Throws rather than warns. The session does exist on the serve at this point
   * and is left behind, but it is never prompted and so never runs a turn --
   * an inert row in goose's session list is a much smaller problem than a live
   * session holding `delegate`.
   *
   * A `success: false` surplus still counts. It was ATTEMPTED; that it failed
   * this time says nothing about the next serve restart.
   */
  private assertNoSurplusExtensions(
    sessionId: string,
    requested: GooseExtensionSpec[],
    result: Record<string, any> | undefined,
  ): void {
    const reported = result?._meta?.extensionResults;
    if (!Array.isArray(reported)) {
      // Fail closed. A serve that does not report cannot be shown to be narrow,
      // and "assumed narrow" is the state this bead exists to end.
      throw new GooseProtocolError(
        -1,
        `session/new (${sessionId}) returned no _meta.extensionResults, so the session's ` +
          `extension set could not be verified; refusing it rather than assuming it is contained`,
      );
    }
    const allowed = new Set(
      [...(this.opts.serveFloor ?? DEFAULT_SERVE_FLOOR), ...requested.map((e) => e.name)].map(
        normaliseExtensionName,
      ),
    );
    const surplus = reported
      .map((r) => String(r?.name ?? ""))
      .filter((name) => name && !allowed.has(normaliseExtensionName(name)))
      .sort();
    if (surplus.length > 0) {
      throw new GooseProtocolError(
        -1,
        `session/new (${sessionId}) loaded ${surplus.length} extension(s) that were not requested ` +
          `and are not in the declared serve floor: ${surplus.join(", ")}. ` +
          `The serve is wider than this client believes -- check its --builtins flag and version.`,
      );
    }
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
    this.closed = true;
    this.transport?.close();
  }

  private call(
    method: string,
    params: Record<string, unknown>,
    meta: { sessionId?: string; isTurn: boolean } = { isTurn: false },
  ): Promise<JsonRpcResponse> {
    const transport = this.transport;
    if (!transport) throw new Error("goose acp client is not connected");
    // Fail loudly rather than writing into a closed socket, which is silent.
    if (this.closed) throw new GooseProtocolError(-1, "goose acp connection is closed");
    const id = String(++this.nextId);
    // Enforced, not merely declared: see ALLOWED_ACP_METHODS for why a
    // tool-execution method must never appear here.
    if (!(ALLOWED_ACP_METHODS as readonly string[]).includes(method)) {
      throw new Error(
        `goose acp client refused to send disallowed method ${method} `
          + `(see ALLOWED_ACP_METHODS -- adding a tool-execution method is a trust `
          + `boundary decision, not a code change)`,
      );
    }
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
    // Notification. Still NOT delivery evidence -- the receipt is the return
    // value, and treating chunks as proof-of-life is how the opencode watchdog
    // grew to 1650 lines. But `session/update` is the only streaming surface
    // goose has, so it is forwarded to a subscriber that wants it for OUTPUT
    // and for liveness, which are different claims from "the turn landed".
    if (msg.method === "session/update") {
      this.onSessionUpdate(msg.params ?? {});
    }
  }

  /**
   * The run id of the session's in-flight turn, if one has been observed.
   *
   * Measured on goose 1.48.0: `session_info_update` carries this in
   * `_meta.goose.activeRunId` as soon as a turn starts. That matters because the
   * only other way to learn it is to regex it out of a "session already has
   * active run" REJECTION -- which requires issuing a competing `session/prompt`
   * first, i.e. doing the very thing the id is needed to avoid.
   */
  activeRunId(sessionId: string): string | undefined {
    return this.runIds.get(sessionId);
  }

  private onSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = (params.update ?? {}) as Record<string, unknown>;
    if (!sessionId) return;

    if (update.sessionUpdate === "session_info_update") {
      const runId = (update._meta as { goose?: { activeRunId?: unknown } } | undefined)?.goose
        ?.activeRunId;
      if (typeof runId === "string" && runId !== "") {
        this.runIds.set(sessionId, runId);
      }
    }

    // The subscriber is caller code on the socket's callback stack. A throw here
    // would escape the transport entirely; see the option's doc comment.
    try {
      this.opts.onSessionUpdate?.(sessionId, update);
    } catch (err) {
      this.log("goose acp: session/update subscriber threw", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Answer a server->client request. This method must not be able to fail.
   *
   * A goose turn parked on an unanswered `session/request_permission` is
   * UNBOUNDED: there is no server-side timeout, and it cannot be cancelled
   * either, because goose only applies a recorded cancel once the turn's stream
   * yields an event and the permission phase is the one phase with no event
   * source. Measurement against a real serve also showed the obligation is
   * weaker than it looks -- ANY reply clears the request: a correct optionId,
   * an unknown optionId, a bare `result: {}`, even a JSON-RPC error. The rule
   * is "reply to the frame", not "reply correctly".
   *
   * Which makes an unguarded throw the whole hazard, and the injected policy is
   * CALLER code. A policy that throws would propagate out of the transport
   * callback and send nothing at all -- a wedge introduced by our side of the
   * boundary rather than by goose. So every step degrades instead of throwing:
   * policy, then the refusal we would have made with no policy, then a bare
   * result. Refusing is the right direction to fail in for an unattended agent.
   */
  private answerServerRequest(msg: JsonRpcResponse): void {
    const params = (msg.params ?? {}) as unknown as PermissionParams;
    const options = Array.isArray(params.options) ? params.options : [];

    let optionId: string | undefined;
    try {
      const chosen = this.opts.permissionPolicy
        ? this.opts.permissionPolicy(params)
        : refuse(options);
      optionId = chosen ?? refuse(options);
    } catch (err) {
      // Deliberately falls back to the DEFAULT REFUSAL rather than to nothing:
      // a policy that cannot decide must not become a policy that allows.
      try {
        optionId = refuse(options);
      } catch {
        optionId = undefined;
      }
      this.log("goose acp: permission policy threw, falling back to refusal", {
        method: msg.method,
        optionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.log("goose acp: answered server request", { method: msg.method, optionId });
    try {
      this.transport?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: optionId ? { outcome: { outcome: "selected", optionId } } : {},
        }),
      );
    } catch (err) {
      // Last resort: a bare result is measured to clear the request. If even
      // this throws the transport is gone, which onClose already handles as a
      // disconnect -- and a disconnect at least ENDS the turn rather than
      // parking it forever.
      this.log("goose acp: failed to send permission answer, retrying bare", {
        method: msg.method,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      } catch {
        this.log("goose acp: could not answer permission request at all", { method: msg.method });
      }
    }
  }

  private onClose(code: number, reason: string): void {
    this.log("goose acp closed", { code, reason, outstanding: this.pending.size });
    this.closed = true;
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
    // AFTER the rejections above, which read runIds to name the lost run in the
    // error -- clearing first silently stripped that id and made a disconnect
    // quiet again, which an existing test caught.
    //
    // Cleared at all because a run id learned on a dead connection is worse than
    // no run id: it would send a later message to STEER a run nobody can reach,
    // and a steer waits for a reply that cannot come.
    this.runIds.clear();
  }
}

/** Prefer an explicit reject option; fall back to the last (conventionally the
 * most restrictive) rather than the first, which is conventionally "allow". */
function refuse(options: PermissionParams["options"]): string | undefined {
  const rejectish = options.find((o) => /reject|deny|no/i.test(o.optionId ?? o.name ?? ""));
  return rejectish?.optionId ?? options[options.length - 1]?.optionId;
}

/**
 * Every JSON-RPC method this client is permitted to send to goose.
 *
 * THIS IS A TRUST-BOUNDARY DECLARATION, not documentation, and it is pinned by
 * a test that fails if the set grows.
 *
 * Measured on goose 1.48.0: the ACP endpoint `_goose/unstable/tools/call`
 * dispatches straight to the extension manager with no mode check, no
 * permission inspection, and NO `run_pre_tool_hooks` call at all. A tool
 * executed that way runs with the hook chain not merely permissive but
 * UNINVOKED. Confirmed by side effect against a serve whose deny hook was
 * proven live by a control in the same session.
 *
 * Two consequences, and the second is the one that matters most here:
 *
 *  - `PreToolUse` deny rules do not see the call. The lane's own hook source is
 *    explicit that those rules are "DRIFT PROTECTION, NOT ENFORCEMENT" against
 *    the agent, so this is not a new adversarial hole — but it IS a path that
 *    needs no evasion to take.
 *  - `PostToolUse` does not fire either, and that hook is how a merge reaches
 *    the human's visibility feed. An action taken through this endpoint is
 *    therefore INVISIBLE, and visibility is the entire point of the lane. A
 *    silent merge is worse for this project than a blocked one.
 *
 * The `extensions:` allowlist does still bind on that endpoint (verified: with
 * `developer` disabled the call is refused), so the reachable surface is
 * bounded — but `shell` is inside the lane's allowlist, which is exactly why
 * bounded is not the same as safe.
 *
 * So this client stays on the session-oriented surface and never acquires a
 * tool-execution capability. If a future change needs one, that is a trust
 * boundary decision for a human, not a diff.
 */
export const ALLOWED_ACP_METHODS = [
  "initialize",
  "session/new",
  "session/prompt",
  "_goose/unstable/session/steer",
] as const;

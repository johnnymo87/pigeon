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
 * 4. DISCONNECT CANCELS THE TURN (§17 Q6, hazard R1). This is the dangerous one.
 *    When a WebSocket closes, bare goose shuts that connection's agent down, which
 *    drops the in-flight `session/prompt` and CANCELS its run (goose's
 *    `ActiveRunDropGuard`). Re-measured on patched-1.54.0.3, 2026-10-12, with a
 *    run parked in a `sleep` tool call: after the close the model was never
 *    called again, and the session history held the user message and nothing
 *    else -- not even the tool call that had started. Same result for a clean
 *    close and for the client process exiting. Through honkd (a durable ACP relay),
 *    turns survive a disconnect and continue running.
 *    Against bare goose, nothing here retries automatically: the prompt is still
 *    in goose's history, so a blind replay puts it there twice. Retry is the human's
 *    decision. Against honkd (when isHonk is true), pigeon reconnects once and
 *    resends with the same client_req_id, which honkd attaches to the in-flight turn.
 */

import { randomUUID } from "node:crypto";

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
  /** Authoritative full turn text from honkd (`_meta.honk.text`) when present. */
  text?: string;
  /** Honk cancel reason from `_meta.honk.reason` when present. */
  honkReason?: string;
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
/** honkd has no record of this client_req_id on a resume_only request (-32004). */
export interface GooseUnknownRequest {
  kind: "unknown-request";
}

export type PromptOutcome = GooseReceipt | GooseBusy | GooseUnknownRequest;
export type SteerOutcome = GooseSteered | GooseNoActiveRun;

export type RunState = "unknown" | "idle" | "running";

/**
 * WHY RUN OWNERSHIP EXISTS, AND WHAT EACH STATE AUTHORIZES
 * --------------------------------------------------------
 * honkd is a durable multi-client relay: several viewers can attach to the same
 * session, and honkd maintains a queue of parked prompts. Pigeon must track
 * whether the currently active run is OUR OWN so it knows whether it is
 * authorized to steer or report the turn:
 *
 *  - "own": honkd sent a synthesized echo carrying one of our outstanding
 *    client_req_ids, or bare goose started a run during our prompt.
 *  - "pending": our prompt is outstanding but its echo has not been seen yet;
 *    the run may be ours (delayed delivery path) or our prompt may be parked
 *    behind another client's prompt. Authorizes nothing.
 *  - "foreign": the run was started by another client (or our prompt settled
 *    without matching the run, or a busy rejection named the run).
 *  - "unknown": no live evidence for the session (e.g. untracked session, or
 *    after reconnect/restart, since honk-aware viewers get no synthesized run
 *    state on attach). Also authorizes nothing.
 */
export type RunOwnership = "own" | "pending" | "foreign" | "unknown";

export interface RunStateInfo {
  state: RunState;
  runId?: string;
  ownership: RunOwnership;
}

/**
 * The socket dropped while a turn was outstanding (hazard R1).
 *
 * Against bare goose, goose cancels the run when the connection closes (see
 * fact 4 above), so the turn is over and will never produce a receipt. The prompt
 * stays in goose's session history unanswered, which is why bare goose does not
 * resend it: "send it again" and "say continue" are both defensible, and only
 * the human knows which they want.
 *
 * Connected through honkd (`client.isHonk`), turns survive a disconnect;
 * GooseSessionRunner reconnects once and resends with the same clientReqId.
 */
export class DisconnectedDuringTurn extends Error {
  readonly sessionId: string;
  readonly runId: string | undefined;
  readonly closeCode: number;
  constructor(sessionId: string, runId: string | undefined, closeCode: number) {
    super(
      `goose connection closed (code ${closeCode}) while a turn was outstanding for session ${sessionId}` +
        (runId ? ` (run ${runId})` : "") +
        `; goose cancels a run when its connection closes, so the turn was cancelled. The prompt stays in the ` +
        `session's history unanswered, and it is NOT resent automatically`,
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
export type PermissionDecision =
  | { answer: string | undefined; defer?: never }
  | { defer: true; answer?: never };

export type PermissionPolicy = (
  params: PermissionParams,
  ctx: { ownership: RunOwnership; isHonk: boolean },
) => PermissionDecision | string | undefined;

export const HELD_REQUESTS_CAP = 50;

/**
 * Goose 1.48+ measured option set for session/request_permission.
 *
 * NOTE: allow_always rewrites ~/.config/goose/permission.yaml host-wide,
 * which the running serve honours immediately. It must never be selected
 * by an unattended client (bead eng-agent-platform-1o9).
 */
export const MEASURED_GOOSE_PERMISSION_OPTIONS = [
  { optionId: "allow_always", kind: "allow_always", name: "Always Allow" },
  { optionId: "allow_once", kind: "allow_once", name: "Allow" },
  { optionId: "reject_once", kind: "reject_once", name: "Deny" },
  { optionId: "reject_always", kind: "reject_always", name: "Always Deny" },
];

/**
 * Policy helper for unattended goose runs (beads eng-agent-platform-555.18 & 1o9):
 *  - ownership "own" (honk or bare): choose option with kind === "allow_once"
 *    (fall back to optionId === "allow_once"); if none, refuse.
 *    NEVER choose allow_always (guarded and converted to refuse).
 *  - bare goose: treat as own regardless of tracked ownership.
 *  - honk, ownership foreign: defer (do not answer).
 *  - honk, ownership pending or unknown: defer and hold.
 */
export function ownRunPolicy(
  params: PermissionParams,
  ctx: { ownership: RunOwnership; isHonk: boolean },
): PermissionDecision {
  const isOwn = !ctx.isHonk || ctx.ownership === "own";
  if (!isOwn) {
    return { defer: true };
  }

  const options = Array.isArray(params.options) ? params.options : [];
  const allowOnce =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.optionId === "allow_once");

  if (allowOnce) {
    if (allowOnce.kind === "allow_always" || allowOnce.optionId === "allow_always") {
      return { answer: refuse(options) };
    }
    return { answer: allowOnce.optionId };
  }

  return { answer: refuse(options) };
}

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
 * The extensions every session requests: developer, analyze, todo, skills.
 *
 * Decided 2026-09-23 -- eng-agent-platform
 * docs/plans/2026-09-22-goose-extension-defaults-design.md (5-7.1, 9), bead
 * eng-agent-platform-8jk. That doc judges each goose 1.48.0 extension; the short
 * version is that these four neither widen the session, act outside it, nor
 * read more than `shell` already can, while summon (`delegate`), orchestrator,
 * scheduler, Extension Manager and code_execution each fail at least one of
 * those tests.
 *
 * `developer` is REQUESTED, not left to the serve's floor. With no
 * `--with-builtin`, goose loads its default developer only if config.yaml does
 * not say `enabled: false` (v1.48.0 acp/server.rs:568-577); an explicit request
 * loads it unconditionally. Relying on the default made a session with no shell
 * possible after an ordinary `goose configure`.
 *
 * This REVERSES the earlier rule of sending `[]` ("restating the floor can
 * widen"). That rule protected a serve deliberately narrowed with
 * `--with-builtin`, which the chosen design never does: the serve runs bare and
 * this list is the single place the default lives. If someone does narrow the
 * serve, they must change this list too -- the exact-match check below will not
 * notice a restated developer, because it was asked for.
 */
export const DEFAULT_SESSION_EXTENSIONS: GooseExtensionSpec[] = [
  { type: "platform", name: "developer" },
  { type: "platform", name: "analyze" },
  { type: "platform", name: "todo" },
  { type: "platform", name: "skills" },
];

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
   * Extensions to request. Defaults to DEFAULT_SESSION_EXTENSIONS.
   *
   * Session creation is a containment decision, not a transport detail: goose
   * 1.48.0 (acp/server.rs:581-611) treats a `session/new` with no recipe and no
   * `_meta.enabledExtensions` as permission to load the HOST's entire
   * config.yaml -- which on the machine this was written for meant handing
   * every session `summon` (the `delegate` tool, whose subagents get no hook
   * policy at all), `Extension Manager` (which can enable further extensions at
   * runtime), and `scheduler`. Bead eng-agent-platform-li6.
   *
   * So pigeon always names the set itself, and a caller that wants something
   * different must say so.
   *
   * Note this cannot narrow below the floor -- extensions are additive under
   * ACP and nothing a client sends subtracts (bead eng-agent-platform-jio).
   * Floor-only still ships `shell`, `edit` and `write`; it closes the policy
   * escape and the self-widening, not the session's teeth.
   */
  sessionExtensions?: GooseExtensionSpec[];
  /**
   * What the serve loads unconditionally, so the post-create check can tell
   * surplus from floor. Override when the serve runs with `--with-builtin`.
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
  /**
   * Called when honkd notifies that an accepted steer was never consumed by the model.
   */
  onSteerUnconsumed?: (sessionId: string, messageId: string) => void;
  /**
   * Called whenever a session's (state, runId, ownership) changes outside replay,
   * and at replay_done.
   */
  onRunStateChange?: (sessionId: string, state: RunStateInfo) => void;
  /**
   * Called when a permission request is deferred (foreign run) or held (pending/unknown run).
   */
  onPermissionDeferred?: (
    sessionId: string,
    detail: { held: boolean; ownership: RunOwnership },
  ) => void;
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

interface SessionTrack {
  state: RunState;
  runId?: string;
  ownership: RunOwnership;
  /**
   * Echo usually precedes the run-start frame (`session_info_update`), but
   * delayed delivery paths can send it after the run start. Buffered here so
   * whichever arrives first can be matched against the other.
   */
  lastEchoCrid?: string;
  /**
   * honkd pushes unsolicited history replays to honk-aware viewers between
   * `_honk/reset` and `_honk/replay_done`. Forwarding them to onSessionUpdate
   * would put old history into the current turn's reply text.
   */
  replaying: boolean;
}

interface HeldPermissionRequest {
  id: unknown;
  msg: JsonRpcResponse;
  params: PermissionParams;
}

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
  private honk = false;
  private honkFeatures: string[] = [];
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private tracks = new Map<string, SessionTrack>();
  private ourCrids = new Map<string, Set<string>>();
  private lastNotified = new Map<string, RunStateInfo>();
  private nextSentinelId = 0;
  private heldRequests = new Map<string, HeldPermissionRequest[]>();

  constructor(opts: GooseAcpClientOptions) {
    this.opts = opts;
  }

  private getOrCreateTrack(sessionId: string): SessionTrack {
    let track = this.tracks.get(sessionId);
    if (!track) {
      track = {
        state: "unknown",
        ownership: "unknown",
        replaying: false,
      };
      this.tracks.set(sessionId, track);
    }
    return track;
  }

  private notifyRunStateChange(sessionId: string, track: SessionTrack): void {
    const info: RunStateInfo = {
      state: track.state,
      runId: track.runId,
      ownership: track.ownership,
    };
    this.lastNotified.set(sessionId, info);
    try {
      this.opts.onRunStateChange?.(sessionId, info);
    } catch (err) {
      this.log("goose acp: onRunStateChange subscriber threw", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private updateRunState(
    sessionId: string,
    track: SessionTrack,
    update: { state: RunState; runId?: string; ownership: RunOwnership },
  ): void {
    const changed =
      track.state !== update.state ||
      track.runId !== update.runId ||
      track.ownership !== update.ownership;

    if (update.ownership === "foreign") {
      this.dropHeldRequests(sessionId, "ownership_foreign");
    } else if (
      track.runId !== undefined &&
      update.runId !== undefined &&
      update.runId !== track.runId
    ) {
      this.dropHeldRequests(sessionId, "run_changed");
    }

    track.state = update.state;
    track.runId = update.runId;
    track.ownership = update.ownership;
    if (changed && !track.replaying) {
      this.notifyRunStateChange(sessionId, track);
      if (track.ownership === "own") {
        this.drainHeldRequests(sessionId);
      }
    }
  }

  private resetAllTracks(): void {
    const sessionIds = new Set<string>([
      ...this.tracks.keys(),
      ...this.lastNotified.keys(),
    ]);
    for (const sessionId of sessionIds) {
      const notified = this.lastNotified.get(sessionId);
      const wasKnown =
        notified &&
        (notified.state !== "unknown" ||
          notified.runId !== undefined ||
          notified.ownership !== "unknown");
      const track = this.tracks.get(sessionId);
      const trackWasKnown =
        track &&
        (track.state !== "unknown" ||
          track.runId !== undefined ||
          track.ownership !== "unknown");
      if (wasKnown || trackWasKnown) {
        try {
          this.opts.onRunStateChange?.(sessionId, {
            state: "unknown",
            runId: undefined,
            ownership: "unknown",
          });
        } catch (err) {
          this.log("goose acp: onRunStateChange subscriber threw", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (track) {
        track.replaying = false;
      }
    }
    this.dropAllHeldRequests("reset_tracks");
    this.tracks.clear();
    this.ourCrids.clear();
    this.lastNotified.clear();
  }

  private sendPermissionAnswer(
    id: unknown,
    method: string | undefined,
    decision: PermissionDecision,
    options: PermissionParams["options"],
    sessionId: string | undefined,
    ownership: RunOwnership,
  ): void {
    let optionId = decision.answer ?? refuse(options);

    const safeOptions = Array.isArray(options) ? options : [];
    const chosenOption = safeOptions.find((o) => o?.optionId === optionId);
    if (
      optionId === "allow_always" ||
      chosenOption?.kind === "allow_always" ||
      chosenOption?.optionId === "allow_always"
    ) {
      this.log("goose acp: allow_always requested by policy converted to refusal", {
        method,
        id,
        optionId,
        ownership,
        sessionId,
      });
      optionId = refuse(options);
    }

    this.log("goose acp: answered server request", {
      method,
      id,
      optionId,
      ownership,
      sessionId,
    });
    try {
      this.transport?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: optionId ? { outcome: { outcome: "selected", optionId } } : {},
        }),
      );
    } catch (err) {
      this.log("goose acp: failed to send permission answer, retrying bare", {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      } catch {
        this.log("goose acp: could not answer permission request at all", { method });
      }
    }
  }

  private drainHeldRequests(sessionId: string): void {
    const list = this.heldRequests.get(sessionId);
    if (!list || list.length === 0) return;
    this.heldRequests.delete(sessionId);

    const track = this.tracks.get(sessionId);
    const ownership = track?.ownership ?? "own";
    const ctx = { ownership, isHonk: this.isHonk };

    for (const req of list) {
      const options = Array.isArray(req.params.options) ? req.params.options : [];
      let decision: PermissionDecision;
      try {
        const res = this.opts.permissionPolicy
          ? this.opts.permissionPolicy(req.params, ctx)
          : { answer: refuse(options) };
        if (typeof res === "string" || res === undefined) {
          decision = { answer: res ?? refuse(options) };
        } else if ("defer" in res && res.defer) {
          decision = { defer: true };
        } else {
          decision = { answer: res.answer };
        }
      } catch (err) {
        // Honk own run: falls back to refusal
        decision = { answer: refuse(options) };
        this.log("goose acp: permission policy threw while draining held request, falling back to refusal", {
          id: req.id,
          method: req.msg.method,
          sessionId,
          ownership,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (decision.defer) {
        this.log("goose acp: deferred server request", {
          method: req.msg.method,
          id: req.id,
          sessionId,
          ownership,
          held: false,
        });
        continue;
      }

      this.sendPermissionAnswer(
        req.id,
        req.msg.method,
        decision,
        req.params.options,
        sessionId,
        ownership,
      );
    }
  }

  private dropHeldRequests(sessionId: string, reason: string): void {
    const list = this.heldRequests.get(sessionId);
    if (!list || list.length === 0) return;
    this.heldRequests.delete(sessionId);
    const track = this.tracks.get(sessionId);
    const ownership = track?.ownership ?? "unknown";
    for (const req of list) {
      this.log("goose acp: dropped held server request", {
        method: req.msg.method,
        id: req.id,
        sessionId,
        ownership,
        reason,
      });
    }
  }

  private dropAllHeldRequests(reason: string): void {
    for (const sessionId of [...this.heldRequests.keys()]) {
      this.dropHeldRequests(sessionId, reason);
    }
  }

  private addOurCrid(sessionId: string, crid: string): void {
    let set = this.ourCrids.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.ourCrids.set(sessionId, set);
    }
    set.add(crid);
  }

  private removeOurCrid(sessionId: string, crid: string): void {
    const set = this.ourCrids.get(sessionId);
    if (set) {
      set.delete(crid);
      if (set.size === 0) {
        this.ourCrids.delete(sessionId);
      }
    }
    const remaining = this.ourCrids.get(sessionId)?.size ?? 0;
    if (remaining === 0) {
      const track = this.tracks.get(sessionId);
      if (track && track.state === "running" && track.ownership === "pending") {
        this.updateRunState(sessionId, track, {
          state: track.state,
          runId: track.runId,
          ownership: "foreign",
        });
      }
    }
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(msg, fields);
  }

  /** True once the socket has closed; the caller should discard this client. */
  isClosed(): boolean {
    return this.closed;
  }

  /** True when the connected peer is honkd (learned from initialize _meta.honk). */
  get isHonk(): boolean {
    return this.honk;
  }

  get supportsResumeOnly(): boolean {
    return this.honk && this.honkFeatures.includes("resume_only");
  }

  get features(): readonly string[] {
    return this.honkFeatures;
  }

  async connect(): Promise<void> {
    const previous = this.transport;
    this.transport = undefined;
    try {
      previous?.close();
    } catch {
      /* best effort */
    }
    this.resetAllTracks();
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
    const initRes = await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      // honkd's viewer.rs: makes pigeon a honk-aware viewer so it receives the synth_<crid> echo; bare goose ignores _meta
      _meta: { honk: {} },
    });
    const honkMeta = (initRes.result?._meta as { honk?: unknown } | undefined)?.honk;
    this.honk = Boolean(honkMeta);
    if (honkMeta && typeof honkMeta === "object" && Array.isArray((honkMeta as { features?: unknown }).features)) {
      this.honkFeatures = ((honkMeta as { features: unknown[] }).features)
        .filter((f): f is string => typeof f === "string");
    } else {
      this.honkFeatures = [];
    }
    this.log("goose acp connected", { url: this.opts.url, isHonk: this.honk, features: this.honkFeatures });
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
      // honkd's viewer.rs: makes pigeon a honk-aware viewer so it receives the synth_<crid> echo; bare goose ignores _meta
      _meta: { honk: {} },
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
   * honoured. A serve on another version, or one started with `--with-builtin
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
    this.assertExactExtensions(sid, requested, res.result);
    return sid;
  }

  /**
   * Refuses a session whose loaded set is not EXACTLY floor + requested.
   *
   * Surplus: something loaded that nobody asked for -- the li6 bug. A
   * `success: false` surplus still counts; it was ATTEMPTED, and that it failed
   * this time says nothing about the next serve restart.
   *
   * Missing: something expected did not load, or reported `success: false`.
   * Without this a session with no `developer` is accepted and dies on its first
   * real command (bead eng-agent-platform-8jk).
   *
   * Throws rather than warns. The session does exist on the serve at this point
   * and is left behind, but it is never prompted and so never runs a turn.
   */
  private assertExactExtensions(
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
    const expectedNames = [
      ...(this.opts.serveFloor ?? DEFAULT_SERVE_FLOOR),
      ...requested.map((e) => e.name),
    ];
    const expected = new Set(expectedNames.map(normaliseExtensionName));
    const loaded = new Set(
      reported
        .filter((r) => r?.success !== false)
        .map((r) => normaliseExtensionName(String(r?.name ?? ""))),
    );
    const surplus = reported
      .map((r) => String(r?.name ?? ""))
      .filter((name) => name && !expected.has(normaliseExtensionName(name)))
      .sort();
    const missing = [...new Set(expectedNames)]
      .filter((name) => !loaded.has(normaliseExtensionName(name)))
      .sort();
    if (surplus.length === 0 && missing.length === 0) return;

    const parts: string[] = [];
    if (surplus.length > 0) {
      parts.push(
        `loaded ${surplus.length} extension(s) that were not requested and are not in the ` +
          `declared serve floor: ${surplus.join(", ")}`,
      );
    }
    if (missing.length > 0) {
      parts.push(
        `is missing ${missing.length} expected extension(s) (not loaded, or success:false): ` +
          `${missing.join(", ")}`,
      );
    }
    throw new GooseProtocolError(
      -1,
      `session/new (${sessionId}) ${parts.join("; and ")}. The serve does not match what this ` +
        `client expects -- check its --with-builtin flags, ~/.config/goose/config.yaml, and version.`,
    );
  }

  /**
   * Sends a prompt and waits for the TURN to end. May take minutes; that is
   * normal and is not a stall (see fact 1 in the file header).
   */
  async prompt(
    sessionId: string,
    text: string,
    options?: { clientReqId?: string; resumeOnly?: boolean },
  ): Promise<PromptOutcome> {
    const params: Record<string, unknown> = {
      sessionId,
      prompt: [{ type: "text", text }],
    };
    let crid: string;
    if (this.honk) {
      crid = options?.clientReqId ?? `pigeon-${randomUUID()}`;
      params._meta = {
        honk: {
          client_req_id: crid,
          ...(options?.resumeOnly ? { resume_only: true } : {}),
        },
      };
    } else {
      crid = options?.clientReqId ?? `__sentinel_${++this.nextSentinelId}`;
    }
    this.addOurCrid(sessionId, crid);
    let res: JsonRpcResponse;
    try {
      res = await this.call(
        "session/prompt",
        params,
        { sessionId, isTurn: true },
      );
    } finally {
      this.removeOurCrid(sessionId, crid);
    }
    if (res.error) {
      if (res.error.code === -32004) {
        this.log("honkd resume_only rejected as unknown client_req_id", {
          sessionId,
          clientReqId: options?.clientReqId,
        });
        return { kind: "unknown-request" };
      }
      const busy = BUSY_RUN_ID.exec(res.error.data ?? "");
      if (busy) {
        const runId = busy[1]!;
        const track = this.getOrCreateTrack(sessionId);
        if (!(track.state === "running" && track.runId === runId && track.ownership === "own")) {
          this.updateRunState(sessionId, track, {
            state: "running",
            runId,
            ownership: "foreign",
          });
        }
        this.log("goose session busy", { sessionId, runId });
        return { kind: "busy", runId };
      }
      throw new GooseProtocolError(res.error.code, res.error.message, res.error.data);
    }
    const stopReason = res.result?.stopReason;
    if (typeof stopReason !== "string") {
      throw new GooseProtocolError(-1, "session/prompt returned no stopReason");
    }
    // For a honk peer, receipt must NOT reset run state: honkd may already have
    // started the next parked prompt and sent its echo + run id before our reply
    // arrives. Bare goose has no parked queue, so receipt means the turn is over.
    if (!this.honk) {
      const track = this.getOrCreateTrack(sessionId);
      track.lastEchoCrid = undefined;
      this.updateRunState(sessionId, track, {
        state: "idle",
        runId: undefined,
        ownership: "unknown",
      });
    }
    const honk = (res.result?._meta as { honk?: { text?: unknown; reason?: unknown } } | undefined)?.honk;
    const honkText = honk?.text;
    const honkReason = honk?.reason;
    return {
      kind: "receipt",
      stopReason,
      usage: res.result?.usage,
      ...(typeof honkText === "string" ? { text: honkText } : {}),
      ...(typeof honkReason === "string" ? { honkReason } : {}),
    };
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
        const track = this.getOrCreateTrack(sessionId);
        track.lastEchoCrid = undefined;
        this.dropHeldRequests(sessionId, "no_active_run");
        this.updateRunState(sessionId, track, {
          state: "idle",
          runId: undefined,
          ownership: "unknown",
        });
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

  /**
   * Sends a session/cancel notification frame to cancel an in-flight turn.
   * Throws if the client is not connected or closed, like call().
   */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  private ensureTransport(method: string): AcpTransport {
    const transport = this.transport;
    if (!transport) throw new Error("goose acp client is not connected");
    // Fail loudly rather than writing into a closed socket, which is silent.
    if (this.closed) throw new GooseProtocolError(-1, "goose acp connection is closed");
    // Enforced, not merely declared: see ALLOWED_ACP_METHODS for why a
    // tool-execution method must never appear here.
    if (!(ALLOWED_ACP_METHODS as readonly string[]).includes(method)) {
      throw new Error(
        `goose acp client refused to send disallowed method ${method} `
          + `(see ALLOWED_ACP_METHODS -- adding a tool-execution method is a trust `
          + `boundary decision, not a code change)`,
      );
    }
    return transport;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const transport = this.ensureTransport(method);
    transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private call(
    method: string,
    params: Record<string, unknown>,
    meta: { sessionId?: string; isTurn: boolean } = { isTurn: false },
  ): Promise<JsonRpcResponse> {
    const transport = this.ensureTransport(method);
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
    // Notification. Still NOT delivery evidence -- the receipt is the return
    // value, and treating chunks as proof-of-life is how the opencode watchdog
    // grew to 1650 lines. But `session/update` is the only streaming surface
    // goose has, so it is forwarded to a subscriber that wants it for OUTPUT
    // and for liveness, which are different claims from "the turn landed".
    if (msg.method === "session/update") {
      this.onSessionUpdate(msg.params ?? {});
      return;
    }
    if (msg.method === "_honk/reset") {
      this.onHonkReset(msg.params ?? {});
      return;
    }
    if (msg.method === "_honk/replay_done") {
      this.onHonkReplayDone(msg.params ?? {});
      return;
    }
    if (msg.method === "_honk/steer_unconsumed") {
      this.onHonkSteerUnconsumed(msg.params ?? {});
      return;
    }
  }

  /**
   * The run id of the session's in-flight turn, if one has been observed.
   * Returns runId only when state is running.
   */
  activeRunId(sessionId: string): string | undefined {
    const track = this.tracks.get(sessionId);
    return track?.state === "running" ? track.runId : undefined;
  }

  runState(sessionId: string): RunState {
    return this.tracks.get(sessionId)?.state ?? "unknown";
  }

  runOwnership(sessionId: string): RunOwnership {
    return this.tracks.get(sessionId)?.ownership ?? "unknown";
  }

  private onHonkReset(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) return;
    const track = this.getOrCreateTrack(sessionId);
    track.state = "unknown";
    track.runId = undefined;
    track.ownership = "unknown";
    track.lastEchoCrid = undefined;
    track.replaying = true;
    this.dropHeldRequests(sessionId, "honk_reset");
  }

  private onHonkReplayDone(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) return;
    const track = this.getOrCreateTrack(sessionId);
    track.replaying = false;
    this.notifyRunStateChange(sessionId, track);
    if (track.ownership === "own") {
      this.drainHeldRequests(sessionId);
    }
  }

  private onHonkSteerUnconsumed(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const messageId = typeof params.messageId === "string" ? params.messageId : undefined;
    if (!sessionId || !messageId) return;
    try {
      this.opts.onSteerUnconsumed?.(sessionId, messageId);
    } catch (err) {
      this.log("goose acp: onSteerUnconsumed subscriber threw", {
        sessionId,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = (params.update ?? {}) as Record<string, unknown>;
    if (!sessionId) return;

    const track = this.getOrCreateTrack(sessionId);

    if (update.sessionUpdate === "user_message_chunk") {
      const honkSource = (update._meta as { honk?: { source?: { client_req_id?: unknown } } } | undefined)?.honk?.source;
      const c = typeof honkSource?.client_req_id === "string" ? honkSource.client_req_id : undefined;
      if (c !== undefined) {
        if (track.state === "running" && track.ownership === "pending") {
          const ourCrids = this.ourCrids.get(sessionId);
          const ownership: RunOwnership = ourCrids && ourCrids.has(c) ? "own" : "foreign";
          this.updateRunState(sessionId, track, {
            state: track.state,
            runId: track.runId,
            ownership,
          });
        } else {
          track.lastEchoCrid = c;
        }
      }
    } else if (update.sessionUpdate === "session_info_update") {
      const activeRunId = (update._meta as { goose?: { activeRunId?: unknown } } | undefined)?.goose
        ?.activeRunId;
      if (typeof activeRunId === "string" && activeRunId !== "") {
        if (track.state === "running" && track.runId === activeRunId) {
          // idempotent repeat: no change
        } else {
          let ownership: RunOwnership;
          const ourCrids = this.ourCrids.get(sessionId);
          if (this.isHonk) {
            if (track.lastEchoCrid !== undefined) {
              ownership = ourCrids && ourCrids.has(track.lastEchoCrid) ? "own" : "foreign";
            } else if (ourCrids && ourCrids.size > 0) {
              ownership = "pending";
            } else {
              ownership = "foreign";
            }
          } else {
            ownership = ourCrids && ourCrids.size > 0 ? "own" : "foreign";
          }
          track.lastEchoCrid = undefined;
          this.updateRunState(sessionId, track, {
            state: "running",
            runId: activeRunId,
            ownership,
          });
        }
      } else if (activeRunId === null) {
        track.lastEchoCrid = undefined;
        this.dropHeldRequests(sessionId, "run_ended");
        this.updateRunState(sessionId, track, {
          state: "idle",
          runId: undefined,
          ownership: "unknown",
        });
      }
    }

    if (track.replaying) {
      return;
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
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const ownership: RunOwnership = sessionId ? this.runOwnership(sessionId) : "unknown";
    const ctx = { ownership, isHonk: this.isHonk };

    let decision: PermissionDecision;
    try {
      const res = this.opts.permissionPolicy
        ? this.opts.permissionPolicy(params, ctx)
        : { answer: refuse(options) };
      if (typeof res === "string" || res === undefined) {
        decision = { answer: res ?? refuse(options) };
      } else if ("defer" in res && res.defer) {
        decision = { defer: true };
      } else {
        decision = { answer: res.answer };
      }
    } catch (err) {
      if (this.isHonk && ownership !== "own") {
        decision = { defer: true };
      } else {
        decision = { answer: refuse(options) };
      }
      this.log("goose acp: permission policy threw, falling back", {
        method: msg.method,
        ownership,
        sessionId,
        fallback: decision.defer ? "defer" : "refuse",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (decision.defer) {
      const held = this.isHonk && (ownership === "pending" || ownership === "unknown");
      if (held && sessionId) {
        let list = this.heldRequests.get(sessionId);
        if (!list) {
          list = [];
          this.heldRequests.set(sessionId, list);
        }
        if (!list.some((r) => r.id === msg.id)) {
          if (list.length >= HELD_REQUESTS_CAP) {
            const evicted = list.shift()!;
            this.log("goose acp: evicted oldest held request (cap reached)", {
              sessionId,
              id: evicted.id,
              method: evicted.msg.method,
              ownership,
              cap: HELD_REQUESTS_CAP,
            });
          }
          list.push({ id: msg.id, msg, params });
        }
        this.log("goose acp: held server request", {
          method: msg.method,
          id: msg.id,
          ownership,
          sessionId,
        });
      } else {
        this.log("goose acp: deferred server request", {
          method: msg.method,
          id: msg.id,
          ownership,
          sessionId,
          held: false,
        });
      }

      if (sessionId && msg.method === "session/request_permission") {
        try {
          this.opts.onPermissionDeferred?.(sessionId, { held, ownership });
        } catch (err) {
          this.log("goose acp: onPermissionDeferred subscriber threw", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    this.sendPermissionAnswer(
      msg.id,
      msg.method,
      decision,
      options,
      sessionId,
      ownership,
    );
  }

  private onClose(code: number, reason: string): void {
    this.log("goose acp closed", { code, reason, outstanding: this.pending.size });
    this.closed = true;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, p] of entries) {
      if (p.isTurn && p.sessionId) {
        const runId = this.activeRunId(p.sessionId) ?? this.tracks.get(p.sessionId)?.runId;
        const err = new DisconnectedDuringTurn(p.sessionId, runId, code);
        try {
          this.opts.onTurnLost?.(err);
        } catch (subErr) {
          this.log("goose acp: onTurnLost subscriber threw", {
            sessionId: p.sessionId,
            error: subErr instanceof Error ? subErr.message : String(subErr),
          });
        }
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
    this.resetAllTracks();
  }
}

/** Prefer an explicit reject option; fall back to the last (conventionally the
 * most restrictive) rather than the first, which is conventionally "allow".
 * Never selects allow_always. Tolerates non-array options. */
export function refuse(options: PermissionParams["options"]): string | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const safeOptions = options.filter(
    (o) => o && o.kind !== "allow_always" && o.optionId !== "allow_always",
  );
  const rejectish = safeOptions.find((o) => /reject|deny|no/i.test(o?.optionId ?? o?.name ?? ""));
  return rejectish?.optionId ?? safeOptions[safeOptions.length - 1]?.optionId;
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
 *
 * Human decision (2026-10-12): Added `session/cancel` to ALLOWED_ACP_METHODS.
 * It cancels a turn and executes nothing. /kill on a goose session sends
 * `session/cancel` against both honkd and bare goose, then closes the socket.
 */
export const ALLOWED_ACP_METHODS = [
  "initialize",
  "session/new",
  "session/prompt",
  "_goose/unstable/session/steer",
  "session/cancel",
] as const;

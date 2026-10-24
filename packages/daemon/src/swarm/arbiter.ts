import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
/**
 * The ONLY capability the arbiter may exercise on a serve (pigeon-0gxy).
 *
 * Deliberately narrower than `OpencodeClient`, which also carries
 * `abortSession`. The turn-preemption policy says delivery latency never
 * justifies killing a peer's running turn, and the arbiter IS the delivery
 * path — so it must not be able to abort at all. The watchdog's half of that
 * invariant is guarded by ~25 "never called" assertions; the arbiter's half is
 * guarded structurally here, because it has no such assertions. Widening this
 * back to `OpencodeClient` re-arms the exact preemption the policy forbids.
 */
export interface ArbiterClient {
  sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void>;
}
import { renderEnvelope, PermanentDeliveryError } from "./envelope";
import { isOpencodeRoutable } from "../routing/opencode-routable";
import type { Locality } from "../routing/locality";
import { directoryMissing } from "./directory-check";
import type { RelayMessageBody, RelaySendAnswer } from "../worker/relay-client";
import { formatRelayRefusalReason } from "./relay-notice";
import { displayName } from "../notification-service";
import { DELIVERY_FAILED_KIND, notifySenderOfFailure } from "./notify-sender";
import {
  isOutageFailure,
  TargetUnavailableError,
  isSuppressedFromRecovery,
  formatWakePayloadAlert,
} from "./delivery-policy";

export { DELIVERY_FAILED_KIND };

/** The worker's record of which machine a session is registered to. */
export interface SessionOwner {
  machineId: string;
  /**
   * Epoch ms of the worker row's `updated_at`: bumped by registration and also by
   * notifications and Telegram routing, from any machine. "Last active", not
   * "last registered".
   */
  lastSeen: number;
}

/**
 * The sender-facing notice for a remote target. Not `formatFailureNotice`: its
 * not-received branch ends "safe to resend", and a resend fails identically, so
 * an agent following it burns a turn per retry. Keeps NOT RECEIVED (true: nothing
 * was written anywhere) and says what to do instead.
 */
export function formatRemoteFailureNotice(msgId: string, target: string, reason: string): string {
  return (
    `DELIVERY FAILED: your swarm message ${msgId} to ${target} was NOT received. ` +
    `Reason: ${reason}. Do not resend it via swarm; it will fail the same way. ` +
    `Reach the target another way.`
  );
}

/** Length of an opencode session id: `ses_` + 26 alphanumerics. */
export const OPENCODE_SESSION_ID_LENGTH = 30;

const GSE_ID = /^gse_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Does `target` look like a mangled id rather than a real one (pigeon-k0qn.14)? True for
 * `ses_` + alphanumerics of the wrong length, and for `gse_` + hex/dashes that is not a whole
 * uuid, which is what truncating or over-copying a real id produces. Ids with other
 * characters (fixed pull-lane ids such as `ses_lane_maven_renovate`) are never called
 * incomplete.
 */
export function looksLikeIncompleteId(target: string): boolean {
  if (/^ses_[A-Za-z0-9]+$/.test(target)) return target.length !== OPENCODE_SESSION_ID_LENGTH;
  if (/^gse_[0-9a-f-]+$/.test(target)) return !GSE_ID.test(target);
  return false;
}

/**
 * A target nobody has: no serve here knows it, the worker has no owner for it, and either its
 * shape is wrong or a local session id starts with it (pigeon-k0qn.14). Unlike a remote
 * target, resending with the right id WORKS, so the notice must not say "do not resend".
 */
export class IncompleteTargetIdError extends PermanentDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteTargetIdError";
  }
}

export function formatIncompleteTargetReason(
  target: string,
  selfMachineId: string | undefined,
  candidates: string[],
): string {
  const here = selfMachineId ? `this machine (${selfMachineId})` : "this machine";
  const shape = target.startsWith("gse_")
    ? "; it is not a complete gse_<uuid> id"
    : `; it is ${target.length} characters long and an opencode session id is ${OPENCODE_SESSION_ID_LENGTH}`;
  // Named, never delivered to: a guessed target is a misroute, which is worse than a failure.
  const hint =
    candidates.length === 1
      ? `. Did you mean ${candidates[0]}? It is a session on ${here} whose id starts with ${target}`
      : candidates.length > 1
        ? `. ${candidates.length >= 3 ? "3 or more" : candidates.length} sessions on ${here} start with it`
        : "";
  return (
    `no session ${target} exists on ${here} and the worker has no record of it (or could not be asked)` +
    `${shape}, so the id is probably incomplete${hint}`
  );
}

export function formatIncompleteTargetNotice(msgId: string, target: string, reason: string): string {
  return (
    `DELIVERY FAILED: your swarm message ${msgId} to ${target} was NOT received. ` +
    `Reason: ${reason}. Check the id and resend with the complete one.`
  );
}

/** Bound on the owner lookup. It runs inside the target's in-flight slot. */
export const OWNER_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * A swarm target this machine provably does not have (pigeon-k0qn.2). Permanent:
 * retrying cannot make another machine's session local, and the retry loop it
 * replaces spent minutes failing against a session no serve here has heard of.
 */
export class RemoteTargetError extends PermanentDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTargetError";
  }
}

/**
 * The worker refused a relay permanently (pigeon-k0qn.7). A RemoteTargetError, so the sender
 * gets the same "do not resend via swarm" notice: every permanent answer fails identically again.
 */
export class RelayRefusedError extends RemoteTargetError {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RelayRefusedError";
  }
}

/** A sender id the worker's relay route accepts. Byte-exact with the worker's SENDER_ID. */
const RELAY_SENDER_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
/**
 * A target id the worker's relay route accepts (its TARGET_ID). Anything else would come back
 * `400 invalid`; it keeps the Phase 1 path instead, whose incomplete-id check gives the sender the
 * right advice ("check the id and resend") for a short, truncated id.
 */
const RELAY_TARGET_ID = /^(ses|gse)_[A-Za-z0-9_-]{8,128}$/;

/**
 * Sender-facing reason for a remote target. The owner is DECORATION: it comes from
 * the worker's last-registrant-wins row and may be absent or stale, so the wording
 * claims only what the locality check proved (not on this machine) and attributes
 * the rest to the worker.
 */
export function formatRemoteTargetReason(
  target: string,
  selfMachineId: string | undefined,
  owner: SessionOwner | null,
): string {
  const here = selfMachineId ? `this machine (${selfMachineId})` : "this machine";
  if (owner && selfMachineId && owner.machineId === selfMachineId) {
    // The worker still lists the session under us, but no serve here has it:
    // a deleted or stale session, not a cross-machine one.
    return (
      `target ${target} was not found on ${here}; the worker still lists it here ` +
      `(last active ${new Date(owner.lastSeen).toISOString()}), so it was probably deleted`
    );
  }
  const where = owner
    ? `; the worker has it registered to ${owner.machineId} ` +
      `(last active ${new Date(owner.lastSeen).toISOString()})`
    : "";
  return (
    `target ${target} is not on ${here}${where}. ` +
    `Cross-machine swarm delivery is not supported`
  );
}

export interface ArbiterOptions {
  storage: StorageDb;
  clientForSession: (sessionId: string) => ArbiterClient | undefined;   // replaces opencodeClient
  directoryForSession: (sessionId: string) => Promise<string | undefined>; // replaces registry
  /**
   * Working-directory preflight (pigeon-0ay7). Injected for testability, and
   * doubling as the escape hatch if serves ever stop sharing the daemon's
   * filesystem: pass `() => false` and the preflight disappears.
   */
  directoryMissing?: (dir: string) => boolean;
  /**
   * Tri-state target locality (pigeon-k0qn.2), evaluated BEFORE
   * `clientForSession`. Absent = every target is local (the old behaviour).
   */
  localityOf?: (sessionId: string) => Promise<Locality>;
  /** Owner lookup for the remote-failure text. Decoration; bounded; may be absent. */
  ownerOf?: (sessionId: string, signal?: AbortSignal) => Promise<SessionOwner | null>;
  /** This daemon's machine id, for the remote-failure text. */
  selfMachineId?: string;
  /**
   * Cross-machine relay (pigeon-k0qn.7, `PIGEON_SWARM_RELAY_SEND=1`). Present: a remote target
   * is POSTed to the worker instead of failed. Absent: Phase 1 behaviour.
   */
  relay?: (body: RelayMessageBody) => Promise<RelaySendAnswer>;
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const MAX_ATTEMPTS = 10;
const BACKOFF_SCHEDULE = [1_000, 2_000, 5_000, 15_000, 60_000];

/**
 * Fixed retry delay for failures that never reached the serve (see
 * {@link isOutageFailure}). Deliberately flat rather than escalating: during an
 * outage the cost of a retry is one refused TCP connect, and the row's
 * `expires_at` already bounds the total. Escalating here would buy nothing and
 * would need a second counter column to avoid corrupting the attempt budget.
 */
const OUTAGE_RETRY_DELAY_MS = 30_000;

function backoffFor(attempts: number): number {
  return (
    BACKOFF_SCHEDULE[Math.min(attempts, BACKOFF_SCHEDULE.length - 1)] ?? 60_000
  );
}

export class SwarmArbiter {
  private readonly storage: StorageDb;
  private readonly clientForSession: (sessionId: string) => ArbiterClient | undefined;
  private readonly directoryForSession: (sessionId: string) => Promise<string | undefined>;
  private readonly directoryMissing: (dir: string) => boolean;
  private readonly localityOf: ((sessionId: string) => Promise<Locality>) | undefined;
  private readonly ownerOf:
    | ((sessionId: string, signal?: AbortSignal) => Promise<SessionOwner | null>)
    | undefined;
  private readonly selfMachineId: string | undefined;
  private readonly relay: ((body: RelayMessageBody) => Promise<RelaySendAnswer>) | undefined;
  private readonly nowFn: () => number;
  private readonly log: (
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;

  // One in-flight promise per target session — collapses concurrent processOnce
  // calls into a single per-target queue.
  private readonly inflight = new Map<string, Promise<void>>();
  /**
   * Set by drain(). Draining a target is a LOOP, so without this the loop
   * would keep pulling the next queued row and shutdown would take as long as
   * the backlog. Checked at the top of each iteration so the delivery already
   * in flight still completes its terminal write.
   */
  private draining = false;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ArbiterOptions) {
    this.storage = opts.storage;
    this.clientForSession = opts.clientForSession;
    this.directoryForSession = opts.directoryForSession;
    this.directoryMissing = opts.directoryMissing ?? directoryMissing;
    this.localityOf = opts.localityOf;
    this.ownerOf = opts.ownerOf;
    this.selfMachineId = opts.selfMachineId;
    this.relay = opts.relay;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log =
      opts.log ?? ((m, f) => console.log(`[swarm-arbiter] ${m}`, f ?? ""));
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce().catch((err) => {
        this.log("processOnce unhandled error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stop taking new work and wait for in-flight deliveries to reach their
   * terminal write. Call this from a SIGTERM handler before exiting.
   *
   * WHY (pigeon-8aob): `sendPrompt` is awaited and only THEN is `markHandedOff`
   * committed. A process death in that window leaves the row `queued`, so the
   * next daemon redelivers and the target is woken TWICE. The per-target
   * in-flight guard is an in-memory Map, so it cannot outlive the process that
   * owns it. Draining closes that window for every restart we initiate --
   * which is the deploy case, and deploys are the restarts we actually cause.
   *
   * WHAT THIS IS NOT. It does not make delivery exactly-once and must not be
   * described as if it did. A hard crash (OOM, SIGKILL, power loss) runs no
   * handler and is unaffected. Duplicate-on-ambiguity also remains ACCEPTED
   * POLICY elsewhere on this path: a timed-out send is a COUNTED attempt and
   * is resent, precisely because a timeout may mean the request WAS processed
   * (delivery-policy.ts, `isOutageFailure`). This method narrows one duplicate
   * window; it does not remove the class.
   *
   * Bounded on purpose: a wedged `sendPrompt` must not hold the process open
   * until systemd escalates to SIGKILL, because being killed mid-write is the
   * very outcome this exists to avoid.
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    // LOAD-BEARING, and not merely for the sends. `draining` is checked inside
    // drainTargetInner only; `processOnce` also runs `sweepExpired`, which is
    // NOT gated by it and writes to the DB (expiring rows, notifying senders,
    // enqueuing alerts). Without this call the 500ms tick keeps firing and
    // keeps expiring rows after we have decided to exit. Pinned by the
    // "does not keep expiring rows after drain" test.
    this.stop();
    this.draining = true;

    const pending = Array.from(this.inflight.values());
    if (pending.length === 0) return { drained: true, pending: 0 };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.allSettled(pending).then(() => "done" as const),
        deadline,
      ]);
      return { drained: outcome === "done", pending: this.inflight.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async processOnce(): Promise<void> {
    const now = this.nowFn();
    this.sweepExpired(now);
    const targets = this.storage.swarm.listTargetsWithReady(now);
    await Promise.all(targets.map((t) => this.drainTarget(t)));
  }

  /**
   * Transitions one expired row out of `queued` and tells the sender.
   *
   * The notification is NOT optional. This whole feature exists because a
   * message was dropped silently; expiring a wake without saying so would just
   * move the silent drop from delivery time to expiry time.
   *
   * Returns whether this call was the one that expired the row — `markExpired`
   * is guarded on `state = 'queued'`, so a row already taken by cancel or by a
   * concurrent sweep produces no second notification.
   */
  private expireAndNotify(row: SwarmMessageRecord, now: number): boolean {
    return this.storage.db.transaction(() => {
      if (!this.storage.swarm.markExpired(row.msgId, now)) return false;
      this.log("expired", { msgId: row.msgId, target: row.toSession ?? row.channel });
      const scheduledIso = new Date(row.deliverAt ?? row.createdAt).toISOString();
      const reason =
        `expired before delivery (scheduled for ${scheduledIso}, ` +
        `expired at ${new Date(now).toISOString()})`;
      notifySenderOfFailure(this.storage, row, reason, now);
      if (isSuppressedFromRecovery(row)) {
        this.storage.alerts.enqueue({
          source: "wake-expired",
          refMsgId: row.msgId,
          text: formatWakePayloadAlert(row, reason, "expired before delivery"),
          severity: "error",
          now,
        });
      }
      return true;
    })();
  }

  /**
   * Marks rows whose `expires_at` has passed.
   *
   * This sweep is load-bearing, not housekeeping: `getReadyForTarget` and
   * `listTargetsWithReady` both filter expired rows out, so nothing else would
   * ever observe them and they would sit in `queued` forever.
   *
   * That filtering is itself deliberate — the ready queue orders by
   * `created_at ASC`, so an expired 13h-old wake would otherwise sort first and
   * wedge every later message to the same target behind a row that can never
   * deliver.
   *
   * processOnce runs every 500ms with NO reentrancy guard and awaits
   * sweepExpired BEFORE drainTarget. With the old inline alerts, N expired
   * rows meant up to N×10s of Telegram latency inside the sweep, stalling live
   * deliveries behind it and stacking ~20 overlapping processOnce calls per
   * wedged send. Making the sweep synchronous removes that structurally.
   */
  private sweepExpired(now: number): void {
    for (const row of this.storage.swarm.listExpired(now)) {
      try {
        this.expireAndNotify(row, now);
      } catch (err) {
        this.log("sweepExpired error for row", {
          msgId: row.msgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async drainTarget(target: string): Promise<void> {
    const existing = this.inflight.get(target);
    if (existing) {
      await existing;
      return;
    }
    const work = this.drainTargetInner(target).finally(() =>
      this.inflight.delete(target),
    );
    this.inflight.set(target, work);
    return work;
  }

  /** Owner for the failure text, or null. Never throws, never exceeds the bound. */
  private async lookupOwner(target: string): Promise<SessionOwner | null> {
    if (!this.ownerOf) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, OWNER_LOOKUP_TIMEOUT_MS);
    });
    try {
      // Raced as well as signalled: a lookup that ignores its signal must not
      // hold the target's in-flight slot.
      let lookup: Promise<SessionOwner | null>;
      try {
        lookup = this.ownerOf(target, controller.signal).catch(() => null);
      } catch {
        return null;
      }
      return await Promise.race([lookup, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The relay record for a row that arrived by relay, matched on sender and target too. */
  private inboundFor(row: SwarmMessageRecord) {
    const inbound = this.storage.relayInbound.get(row.msgId);
    return inbound && inbound.fromSession === row.fromSession && inbound.toSession === row.toSession ? inbound : null;
  }

  /**
   * POSTs one row to the worker for the machine that owns its target (design §3.1). Returns on
   * success; throws the arbiter's own error types otherwise, so the existing permanent/transient
   * handling and retry budget apply unchanged.
   */
  private async relayRow(row: SwarmMessageRecord, target: string): Promise<void> {
    const sender = this.storage.sessions.get(row.fromSession);
    const answer = await this.relay!({
      msg_id: row.msgId,
      from: row.fromSession,
      to: target,
      kind: row.kind,
      priority: row.priority,
      reply_to: row.replyTo,
      payload: row.payload,
      deliver_at: row.deliverAt,
      expires_at: row.expiresAt,
      ref: row.ref,
      from_label: sender
        ? displayName({ title: sender.title, label: sender.label, sessionId: row.fromSession })
        : null,
    });
    if (answer.kind === "accepted") {
      const now = this.nowFn();
      let marked = this.storage.swarm.markRelayed(row.msgId, now);
      if (!marked && this.storage.swarm.getByMsgId(row.msgId)?.state === "cancelled") {
        // A cancel landed during the POST and lost: the message WAS relayed.
        marked = this.storage.swarm.markRelayed(row.msgId, now, true);
        this.log("relayed mid-flight race (cancel lost to relay)", { msgId: row.msgId, target });
      }
      this.log("relayed", { msgId: row.msgId, target, toMachine: answer.toMachine, duplicate: answer.duplicate, marked });
      return;
    }
    if (answer.kind === "transient") {
      throw new TargetUnavailableError(`relay of ${row.msgId} to ${target} not accepted yet: ${answer.detail}`);
    }
    if (answer.code === "same_machine" || answer.code === "sender_not_yours" || answer.code === "invalid") {
      // Each means two of our own views disagree (locality vs D1, session registry vs D1, our
      // body vs the worker's validator). Worth a loud line, not only the sender's notice.
      console.error(`[swarm-arbiter] relay refused (${answer.code}) for ${row.msgId} to ${target}: ${answer.detail}`);
    }
    if (answer.code === "unknown_session" && looksLikeIncompleteId(target)) {
      throw new IncompleteTargetIdError(
        formatIncompleteTargetReason(target, this.selfMachineId, this.storage.sessions.idsWithPrefix(target)),
      );
    }
    throw new RelayRefusedError(formatRelayRefusalReason(target, answer.code, answer.detail), answer.code);
  }

  private async drainTargetInner(target: string): Promise<void> {
    while (true) {
      // Shutting down: leave the remaining backlog `queued` for the next
      // process rather than starting a send we may not live to record. The
      // delivery already in flight is NOT interrupted -- it is awaited by
      // drain(), which is the entire point.
      if (this.draining) return;

      const now = this.nowFn();
      const next = this.storage.swarm.getReadyForTarget(target, now, 1)[0];
      if (!next) return;

      // Belt and braces. `getReadyForTarget` already excludes expired rows, so
      // this only fires when `expires_at` passes between that SELECT and here —
      // narrow, but reachable, because draining a target is a loop with an
      // await in it. Cheap to check and the alternative is delivering a wake
      // the caller already declared worthless.
      if (next.expiresAt !== null && next.expiresAt <= now) {
        this.expireAndNotify(next, now);
        continue;
      }

      try {
        // LOCALITY FIRST (pigeon-k0qn.2). Must precede clientForSession: for an id
        // with no local row that call reaches the router's ensureRouted, which
        // WRITES a session_assignment and lease for it. A remote id must never get
        // that far. "unknown" is an outage (retried), never a remote verdict.
        if (this.localityOf) {
          const locality = await this.localityOf(target);
          if (locality === "remote") {
            // HOP RULE, absolute (design §3.1): a row that ARRIVED by relay is never relayed
            // again. It fails here, and notifySenderOfFailure reports it back to the worker.
            const inbound = this.inboundFor(next);
            if (inbound) {
              throw new RemoteTargetError(
                `target ${target} is not on this machine (${this.selfMachineId ?? "unknown"}); ` +
                  `the message was relayed here from ${inbound.fromMachine}, and relayed messages are never relayed again`,
              );
            }
            // `pigeon` notices and goose senders cannot be relayed (the worker's validator takes
            // ses_ senders only); they keep the Phase 1 failure.
            if (this.relay && RELAY_SENDER_ID.test(next.fromSession) && RELAY_TARGET_ID.test(target)) {
              await this.relayRow(next, target);
              continue;
            }
            const owner = await this.lookupOwner(target);
            // Shape first, and only then a "did you mean": a well-formed id with no known owner
            // may simply be on a machine the worker could not be asked about, and pointing its
            // sender at a local look-alike would invite a misroute.
            if (!owner && looksLikeIncompleteId(target)) {
              throw new IncompleteTargetIdError(
                formatIncompleteTargetReason(
                  target,
                  this.selfMachineId,
                  this.storage.sessions.idsWithPrefix(target),
                ),
              );
            }
            throw new RemoteTargetError(formatRemoteTargetReason(target, this.selfMachineId, owner));
          }
          if (locality === "unknown") {
            throw new TargetUnavailableError(
              `target ${target} locality unknown: no serve on this machine answered the session lookup`,
            );
          }
        }

        const client = this.clientForSession(target);
        if (!client) {
          // clientForSession also refuses sessions the opencode pool must not
          // own (goose, or a registration with no backend). Naming those as a
          // serve outage would send the sender hunting for one.
          const row = this.storage.sessions.get(target);
          throw new TargetUnavailableError(
            row && !isOpencodeRoutable(row)
              ? `target ${target} not routable: it has no opencode backend (backend_kind=${row.backendKind ?? "none"})`
              : `target ${target} not routable: no healthy serve available`,
          );
        }
        const directory = await this.directoryForSession(target);
        if (!directory) {
          throw new TargetUnavailableError(`target ${target} not resolvable: directory lookup returned empty`);
        }
        const prompt = renderEnvelope(
          {
            v: "1",
            kind: next.kind,
            from: next.fromSession,
            to: next.toSession,
            channel: next.channel,
            msgId: next.msgId,
            replyTo: next.replyTo,
            priority: next.priority,
            scheduledFor: next.deliverAt,
            deliveredLateMs:
              next.deliverAt !== null
                ? Math.max(0, now - next.deliverAt)
                : null,
            ref: next.ref,
            fromMachine: this.inboundFor(next)?.fromMachine ?? null,
          },
          next.payload,
        );

        // WORKING-DIRECTORY PREFLIGHT (pigeon-0ay7).
        //
        // MEASURED 2026-08-10 on cloudbox, and the measurement is the whole
        // reason this blocks rather than merely annotating: prompt_async against
        // a session whose directory has been deleted returns HTTP 204. The serve
        // does NOT validate the directory. The turn then fails internally
        // (PlatformError: NotFound: FileSystem.realPath) on the plugin's event
        // stream only — never as an HTTP error.
        //
        // BE PRECISE ABOUT THE HARM PREVENTED. It is NOT a false success:
        // `handed_off` truthfully records a handoff (the 204 did happen), and
        // pigeon-s9d already stopped such a row being stamped verified. The harm
        // is that the row can never reach an END, which is this roadmap's whole
        // subject:
        //   - the prompt is BURNED into a turn that can never run;
        //   - the deleted-directory turn leaves an assistant row at
        //     parts=0 / completed=null FOREVER (measured, pigeon-s9d), which is
        //     the SILENT-IN-FLIGHT branch — the one branch that by axiom may
        //     never gain a terminal, and where the one permanently-trapped
        //     production row already sits. nudges-exhausted is unreachable
        //     there, since it lives in the idle branch;
        //   - the SENDER is told nothing, ever.
        // Refusing to send keeps the row in `queued` instead: bounded, recorded,
        // and with exits that alert.
        //
        // WHY THIS IS ALLOWED TO DRIVE STATE, when the watchdog asks the same
        // filesystem question and is explicitly forbidden from doing so (see
        // "Task 2: Working-directory corroboration" in delivery-watchdog.ts;
        // that one is an existsSync used for alert prose only).
        // Two independent reasons, and BOTH are required:
        //   1. SUBJECT. The watchdog's stat is evidence about a turn already
        //      dispatched — a past remote event, where gone-now does not imply
        //      gone-then. This stat is a precondition on an action NOT YET
        //      TAKEN. The record it produces ("refused to send; directory
        //      missing") is a true statement about our own behaviour even if
        //      the stat is wrong. A wrong stat here makes the DECISION wrong;
        //      it can never make the RECORD false. The axiom forbids false
        //      records.
        //   2. REVERSIBILITY. This throws TargetUnavailableError, which
        //      isOutageFailure classifies as an outage, so the row stays
        //      `queued` and retryable. No terminal is minted here. Terminals
        //      still arrive only via the existing expiry sweep or attempt
        //      budget, both already RECORDED transitions that alert.
        // The rule, stated so it survives paraphrase: this stat may REFUSE A
        // FUTURE SEND; it may never RE-INTERPRET A DISPATCHED TURN.
        //
        // WHERE THE CAUSE ACTUALLY REACHES A HUMAN, stated exactly because it is
        // asymmetric and it is tempting to claim more:
        //   - rows with NO expires_at (ordinary /swarm/send): the budget applies,
        //     and this message text reaches the sender via notifySenderOfFailure
        //     and the wake-max-attempts alert. The cause IS named.
        //   - rows WITH expires_at (every scheduled wake — parseScheduleTime
        //     always defaults it): isOutageFailure makes the retries UNCOUNTED,
        //     so max-attempts is unreachable and expiry is the only terminal.
        //     `markRetryUncounted` persists no error and swarm_messages has no
        //     last_error column, so the wake-expired alert says only "expired
        //     before delivery" and THIS CAUSE IS LOST to the daemon log.
        // Carrying it into the expiry terminal needs somewhere to persist it —
        // filed as a follow-up rather than smuggled in here.
        //
        // Ordering is deliberate: renderEnvelope runs FIRST so a
        // PermanentDeliveryError (a fact about the payload, true regardless of
        // the filesystem) fails fast instead of being masked behind an
        // outage-retry loop that only ends at expiry. Pinned by test 6.
        //
        // ASSUMPTION: daemon and serve share a filesystem. True on this host,
        // not structural. If serves go remote this silently answers about the
        // wrong machine — inject `directoryMissing: () => false` at the wiring
        // in index.ts to switch the preflight off rather than editing here.
        if (this.directoryMissing(directory)) {
          throw new TargetUnavailableError(
            `target ${target} working directory missing: ${directory} ` +
              `(stat on daemon filesystem; assumes daemon and serve are co-located)`,
          );
        }

        await client.sendPrompt(target, directory, prompt);
        const handedOff = this.storage.swarm.markHandedOff(next.msgId, this.nowFn());
        if (!handedOff) {
          const current = this.storage.swarm.getByMsgId(next.msgId);
          this.log("delivered mid-flight race (cancel lost to delivery)", {
            msgId: next.msgId,
            target,
            currentState: current?.state,
          });
          if (current?.state === "cancelled") {
            this.storage.swarm.markHandedOffAfterCancel(next.msgId, this.nowFn());
          }
        } else {
          this.log("delivered", { msgId: next.msgId, target });
        }
      } catch (err) {
        // Permanent errors can never succeed on retry (e.g. the payload
        // contains the literal close tag). Fail fast instead of burning
        // MAX_ATTEMPTS retries over ~6 minutes.
        if (err instanceof PermanentDeliveryError) {
          const now = this.nowFn();
          let marked = false;
          this.storage.db.transaction(() => {
            if (!this.storage.swarm.markFailed(next.msgId, now)) return;
            marked = true;
            notifySenderOfFailure(
              this.storage,
              next,
              String(err),
              now,
              "unobserved",
              err instanceof RemoteTargetError
                ? formatRemoteFailureNotice(next.msgId, target, err.message)
                : err instanceof IncompleteTargetIdError
                  ? formatIncompleteTargetNotice(next.msgId, target, err.message)
                  : undefined,
              // Only consulted for a row that arrived by relay (the hop rule above).
              err instanceof RemoteTargetError ? "not_on_receiver" : undefined,
            );
            if (isSuppressedFromRecovery(next)) {
              this.storage.alerts.enqueue({
                source: "wake-permanent",
                refMsgId: next.msgId,
                text: formatWakePayloadAlert(
                  next,
                  `permanent delivery error (${String(err)})`,
                ),
                severity: "error",
                now,
              });
            }
          })();
          if (marked) {
            this.log("failed (permanent)", {
              msgId: next.msgId,
              error: String(err),
            });
          }
          return; // stop draining this target until next tick
        }

        // An outage failure only escapes the attempt budget when the row has
        // ANOTHER terminal clock. `expires_at` is exactly that, and the
        // predicate is deliberately the presence of that clock rather than
        // anything about what the message is FOR:
        //
        //   scheduled row -> has expires_at (guaranteed: parseScheduleTime
        //     defaults it to deliver_at + 6h), so uncounted retries still end
        //     at expiry. Bounded.
        //   ordinary /swarm/send row -> no expires_at, so MAX_ATTEMPTS is the
        //     ONLY bound. Exempting it would retry a message to a permanently
        //     dead session forever.
        //
        // So it fails CLOSED: no terminal clock, budget applies.
        //
        // Do NOT rewrite this as `isWakeKind(next.kind)` — POST /swarm/schedule
        // only DEFAULTS kind to "wake" and otherwise takes the caller's string
        // verbatim, so that guard is dodgeable (this is the W3 review finding,
        // reapplied). Do NOT use `deliverAt !== null` either: deliver_at is a
        // START clock and says nothing about whether the row is bounded.
        const skipBudget = isOutageFailure(err) && next.expiresAt !== null;

        if (skipBudget) {
          this.storage.swarm.markRetryUncounted(
            next.msgId,
            this.nowFn(),
            OUTAGE_RETRY_DELAY_MS,
          );
          this.log("retry scheduled (uncounted)", {
            msgId: next.msgId,
            error: String(err),
          });
        } else {
          const after = this.storage.swarm.getByMsgId(next.msgId);
          const attempts = (after?.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            const now = this.nowFn();
            let marked = false;
            this.storage.db.transaction(() => {
              if (!this.storage.swarm.markFailed(next.msgId, now)) return;
              marked = true;
              notifySenderOfFailure(this.storage, next, String(err), now);
              if (isSuppressedFromRecovery(next)) {
                this.storage.alerts.enqueue({
                  source: "wake-max-attempts",
                  refMsgId: next.msgId,
                  text: formatWakePayloadAlert(
                    next,
                    `max attempts exhausted (${String(err)})`,
                  ),
                  severity: "error",
                  now,
                });
              }
            })();
            if (marked) {
              this.log("failed (max attempts)", {
                msgId: next.msgId,
                error: String(err),
              });
            }
          } else {
            this.storage.swarm.markRetry(
              next.msgId,
              this.nowFn(),
              backoffFor(attempts),
            );
            this.log("retry scheduled", {
              msgId: next.msgId,
              attempts,
              error: String(err),
            });
          }
        }
        return; // stop draining this target until next tick
      }
    }
  }
}

/**
 * Serve outcome classification and the SHADOW-MODE sensor (bead pigeon-f2a).
 *
 * This is increment 1's second half: the sensor for the outcome-based verdict
 * that lands in `pigeon-886`, shipped ahead of the verdict itself and wired to
 * nothing that makes decisions.
 *
 * ── WHY SHADOW MODE FIRST ────────────────────────────────────────────────────
 *
 * Increment 2 needs a threshold: "N consecutive serve-directed failures within a
 * window means suspect". Nobody can choose N honestly today, because nothing has
 * ever recorded how many refused/5xx a HEALTHY serve emits in normal operation.
 * Picking a number blind and then enforcing it against live routing is how you
 * get either a useless alert or an outage. So: count and log now, enforce later.
 *
 * NOTHING HERE INFLUENCES ROUTING. When increment 2 wires this up it must honour
 * amendment A of docs/plans/2026-07-27-serve-serviceability-design.md 5.1: the
 * verdict goes into `listHealthy` / `resolveProspectiveRoute` ONLY, never into
 * `isServeHealthy`/`resolveRoute`, because `placeSession` has no live-lease guard
 * (router.ts:163-200) and would steal live leases via acquireCAS's
 * higher-generation-wins branch, killing in-flight turns.
 *
 * ── THE TWO EXCLUSIONS THAT ARE EASY TO GET WRONG ────────────────────────────
 *
 * 1. TIMEOUTS NEVER COUNT (rule C). The intuitive grouping is "transport
 *    failure = ECONNREFUSED + timeout + 5xx", and it is exactly wrong. A serve
 *    running a CPU-heavy turn delays even the cheap `prompt_async` accept, so
 *    counting timeouts marks BUSY serves unserviceable — the false-positive
 *    class behind the June 2026 flapping that killed four in-flight turns.
 *    Accept-but-hang is deliberately left to the systemd canary, which restarts
 *    a frozen loop at ~8 minutes. hangs -> canary; refused + fast-5xx -> here.
 *
 * 2. 4xx IS NOT ILL-HEALTH (rule B). A 404 means the session is gone; the serve
 *    answered correctly. Counting it would make ordinary session lifecycle look
 *    like serve failure.
 *
 * Also excluded structurally, by attribution: the plugin's direct channel. It
 * targets an ephemeral port the PLUGIN binds, so its failures report plugin
 * death, not serve death — counting them would mark the whole pool suspect every
 * morning after the nightly workspace reset. Because that port never appears in
 * the serve registry, `resolve()` returns undefined and the observation is
 * dropped. That is the mechanism, and it is why attribution is a lookup rather
 * than a label the caller supplies.
 */

/** Thrown when our own AbortController fires. Never counts toward the verdict. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly url: string,
  ) {
    // Message kept byte-identical to the pre-existing string form (pigeon-h21)
    // so any consumer matching on text keeps working; the class exists so
    // classification is type-based rather than a fragile substring match.
    super(`request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "RequestTimeoutError";
  }
}

export type ServeOutcome =
  | "success"
  /** Connection refused — the port is closed. Counts. */
  | "refused"
  /** 5xx — answered, and answered wrongly. The class this arc exists for. Counts. */
  | "server_error"
  /** Our own abort fired. NEVER counts (rule C). */
  | "timeout"
  /** 4xx — the serve answered correctly about a client problem. Never counts. */
  | "client_error"
  /** Unrecognised. Never counts; we do not manufacture suspicion from noise. */
  | "unknown";

export interface OutcomeObservation {
  /** HTTP status, when a response was actually received. */
  status?: number;
  /** Thrown error, when the request failed before producing a response. */
  error?: unknown;
}

/** Node's fetch wraps transport failures as `TypeError` with a `cause` carrying `code`. */
function transportCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function classifyServeOutcome(obs: OutcomeObservation): ServeOutcome {
  if (obs.error !== undefined) {
    if (obs.error instanceof RequestTimeoutError) {
      return "timeout";
    }
    // Deliberately narrow. ECONNRESET/EPIPE/EHOSTUNREACH are left `unknown`
    // rather than lumped in with refused: they can arise mid-response from
    // causes that are not "this serve is not listening", and over-suspicion is
    // the expensive direction. Widen only with data — which is what shadow mode
    // is for.
    return transportCode(obs.error) === "ECONNREFUSED" ? "refused" : "unknown";
  }

  const status = obs.status;
  if (status === undefined) {
    return "unknown";
  }
  if (status >= 500) {
    return "server_error";
  }
  if (status >= 400) {
    return "client_error";
  }
  return "success";
}

/**
 * The single definition of "this observation is evidence a serve cannot serve".
 *
 * Kept as one exported predicate so increment 2 cannot accidentally widen the
 * signal by reimplementing the rule at its call site.
 */
export function countsTowardVerdict(outcome: ServeOutcome): boolean {
  return outcome === "refused" || outcome === "server_error";
}

/** Attribution of an endpoint to the pool slot and process currently behind it. */
export interface ServeAttribution {
  serveId: string;
  instanceUuid: string;
}

export interface ServeOutcomeTally extends ServeAttribution {
  success: number;
  refused: number;
  serverError: number;
  timeout: number;
  clientError: number;
  unknown: number;
  /** refused + serverError — what increment 2 will threshold on. */
  counting: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type OutcomeLogger = (msg: string, fields?: Record<string, unknown>) => void;

export interface ServeOutcomeSensorOptions {
  /**
   * Endpoint -> current slot/process, resolved AT RECORD TIME against the
   * registry. Deliberately not a value captured when a client was constructed:
   * clients are cached per endpoint and a serve that restarts keeps its endpoint
   * but gets a fresh `instance_uuid`, so a captured value would silently
   * attribute a new process's outcomes to the dead one.
   *
   * Returning undefined drops the observation, which is how the plugin's
   * ephemeral direct-channel port is excluded (rule B).
   */
  resolve: (endpoint: string) => ServeAttribution | undefined;
  log?: OutcomeLogger;
  nowFn?: () => number;
}

export class ServeOutcomeSensor {
  private readonly resolve: (endpoint: string) => ServeAttribution | undefined;
  private readonly log: OutcomeLogger;
  private readonly nowFn: () => number;

  /** Keyed `serveId\u0000instanceUuid` — amendment D's (serve_id, instance_uuid). */
  private readonly tallies = new Map<string, ServeOutcomeTally>();

  /**
   * Observations we could not attribute to a pool serve (MINOR-6).
   *
   * Almost all of these are the plugin's ephemeral direct channel, which is
   * correct and expected. Counting them anyway converts "the tally is empty, so
   * the pool must be quiet" into a checkable statement: if drops are climbing
   * while tallies stay empty, attribution is broken, not the traffic. Silence
   * that has not been verified is not evidence.
   */
  private dropped = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ServeOutcomeSensorOptions) {
    this.resolve = opts.resolve;
    this.log = opts.log ?? ((msg, fields) => {
      console.log(`[serve-outcome] ${msg}`, fields ? JSON.stringify(fields) : "");
    });
    this.nowFn = opts.nowFn ?? (() => Date.now());
  }

  /**
   * Record one daemon->serve HTTP outcome.
   *
   * Called from the request path of the live daemon, so it cannot throw and
   * cannot be slow. Everything is in-memory; losing it on restart is fine,
   * because this is a base-rate estimate, not an accounting record.
   */
  record(endpoint: string, obs: OutcomeObservation): void {
    try {
      const attr = this.resolve(endpoint);
      if (!attr) {
        this.dropped++; // Not a pool serve — plugin direct channel, or stale client.
        return;
      }

      const outcome = classifyServeOutcome(obs);
      const now = this.nowFn();
      const key = `${attr.serveId}\u0000${attr.instanceUuid}`;

      let t = this.tallies.get(key);
      if (!t) {
        t = {
          ...attr,
          success: 0,
          refused: 0,
          serverError: 0,
          timeout: 0,
          clientError: 0,
          unknown: 0,
          counting: 0,
          firstSeenAt: now,
          lastSeenAt: now,
        };
        this.tallies.set(key, t);
      }

      t.lastSeenAt = now;
      switch (outcome) {
        case "success": t.success++; break;
        case "refused": t.refused++; break;
        case "server_error": t.serverError++; break;
        case "timeout": t.timeout++; break;
        case "client_error": t.clientError++; break;
        case "unknown": t.unknown++; break;
      }
      if (countsTowardVerdict(outcome)) {
        t.counting++;
      }
    } catch {
      // Observability must never break a request. See class docstring.
    }
  }

  snapshot(): ServeOutcomeTally[] {
    return [...this.tallies.values()];
  }

  /**
   * Emit the accumulated base rate. Says SHADOW loudly: someone reading this in
   * journalctl must not conclude the daemon is acting on it, because it is not.
   */
  reportNow(): void {
    const tallies = this.snapshot();

    // Emitted even when empty (MINOR-6). An empty tally with a rising `dropped`
    // means attribution is broken; an empty tally with zero drops means the pool
    // genuinely saw no daemon traffic. Those are very different, and returning
    // early made them look identical.
    this.log("shadow-mode serve outcome tally (recorded only — routing unaffected)", {
      note: "base rate for the pigeon-886 verdict; no serve is evicted on this",
      unattributedObservations: this.dropped,
      serves: tallies.map((t) => ({
        serveId: t.serveId,
        instanceUuid: t.instanceUuid,
        success: t.success,
        refused: t.refused,
        serverError: t.serverError,
        wouldCount: t.counting,
        excludedTimeouts: t.timeout,
        excludedClientErrors: t.clientError,
        unknown: t.unknown,
        // Counters are cumulative, so a reader needs the time base to turn them
        // into a rate — and to notice a daemon restart reset them (MINOR-5).
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
      })),
    });
  }

  start(intervalMs: number): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      try {
        this.reportNow();
      } catch {
        // Never let a reporting bug kill the daemon's event loop.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

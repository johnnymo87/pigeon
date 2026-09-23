import type { OcTagsRunner } from "./worker/oc-tags";

/**
 * Caches each session's effective oc-tags tag for the notification footer.
 *
 * The tag is resolved by shelling out to `oc-tags which <session>`, which owns
 * the precedence rules (session tag > longest matching directory glob >
 * `auto:` fallback). Pigeon deliberately implements none of that — a second
 * implementation would drift, and the tag beside a session would eventually
 * disagree with the tag its dollars are charted under.
 *
 * The shape here exists because of WHERE it is called from. Notifications are
 * formatted inside request handlers: `POST /question-asked` is awaited by the
 * plugin under a 3s timeout, and `POST /stop` is on the delivery path. A
 * subprocess on either is a latency risk for a decorative line, so `get()` is
 * synchronous and answers only from cache, while refreshes happen off to the
 * side. A session whose tag is not cached yet renders without it.
 */

/** Long enough that a stop burst costs one spawn; short enough that a `/tag` shows up soon. */
const DEFAULT_TTL_MS = 10 * 60_000;
/** Shorter, because the common negative is "not tagged yet" and tagging is what we want to reflect. */
const DEFAULT_NEGATIVE_TTL_MS = 2 * 60_000;
/** ~1 KB/entry. Bounds a daemon that has seen thousands of sessions since boot. */
const DEFAULT_MAX_ENTRIES = 512;

/**
 * A session id is passed as argv, so shell metacharacters are inert. The
 * hazard is ARGUMENT injection — an id beginning with `-` would be read by
 * argparse as an option — so anything not starting alphanumeric is refused.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface CacheEntry {
  tag: string | null;
  expiresAt: number;
}

export interface SessionTagResolverOptions {
  /** null when oc-tags is not installed on this machine: the resolver is then inert. */
  runner: OcTagsRunner | null;
  nowFn?: () => number;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  log?: (message: string) => void;
}

export class SessionTagResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly warned = new Set<string>();
  /**
   * Bumped by every invalidation. A refresh captures it on entry and discards
   * its own result if it changed, so a lookup that started before `oc-tags set`
   * committed cannot write the pre-tag answer back over the invalidation that
   * followed it.
   */
  private generation = 0;
  private readonly runner: OcTagsRunner | null;
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly log: (message: string) => void;

  constructor(opts: SessionTagResolverOptions) {
    this.runner = opts.runner;
    this.nowFn = opts.nowFn ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.log = opts.log ?? (msg => console.warn(msg));
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * The cached tag, or null. Never blocks, never throws.
   *
   * A stale entry is returned as-is while its refresh runs: the tag of a
   * session changes rarely, so blanking the line during every refresh would
   * make it flicker for no gain.
   */
  get(sessionId: string): string | null {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.expiresAt <= this.nowFn()) {
      void this.refresh(sessionId);
    }
    return entry?.tag ?? null;
  }

  /**
   * Fire-and-forget warm-up for a session that has just started.
   *
   * Deliberately does NOT cache a negative. A session created by `/launch --tag`
   * or by `opencode-launch` is tagged AFTER it is created and prompted, so a
   * warm-up racing that window sees an untagged session — and caching that
   * answer would hide the tag from the session's first notification, which is
   * the one a user reads right after being told `🏷 Tagged ...`. A positive is
   * cached normally; a negative just leaves the miss for a later read.
   */
  warm(sessionId: string): void {
    void this.refresh(sessionId, { cacheNegative: false });
  }

  forget(sessionId: string): void {
    this.generation += 1;
    this.cache.delete(sessionId);
    this.warned.delete(sessionId);
  }

  /** Drop the cached answer and immediately fetch the new one. */
  refreshNow(sessionId: string): void {
    this.forget(sessionId);
    void this.refresh(sessionId);
  }

  /**
   * Drops every cached tag.
   *
   * Used after `/tag dir <glob> <tag>`, which is retroactive: it can change the
   * effective tag of sessions nobody named, so there is no smaller set to
   * invalidate.
   */
  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.warned.clear();
  }

  /** Resolves when every in-flight refresh has settled. Test seam. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }

  /**
   * Runs the lookup and updates the cache. Resolves even on failure — a tag
   * line is decoration, and a rejection here would surface as an unhandled
   * rejection on a fire-and-forget path.
   */
  async refresh(sessionId: string, opts: { cacheNegative?: boolean } = {}): Promise<void> {
    if (!this.runner) return;
    if (!SESSION_ID_RE.test(sessionId)) return;

    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    const task = this.run(sessionId, opts.cacheNegative ?? true).finally(() => {
      this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, task);
    return task;
  }

  private async run(sessionId: string, cacheNegative: boolean): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    const generation = this.generation;
    try {
      const res = await runner(["which", sessionId]);
      if (res.code !== 0) {
        this.warnOnce(sessionId, `oc-tags which exited ${res.code}: ${lastLine(res.stderr)}`);
        this.store(sessionId, null, generation, cacheNegative);
        return;
      }
      this.store(sessionId, parseWhich(res.stdout), generation, cacheNegative);
    } catch (err) {
      this.warnOnce(sessionId, `oc-tags which failed: ${err instanceof Error ? err.message : String(err)}`);
      this.store(sessionId, null, generation, cacheNegative);
    }
  }

  private warnOnce(sessionId: string, message: string): void {
    // The failure is usually permanent for the life of the daemon (binary
    // absent, DB locked), and this runs per session per TTL; one line each is
    // a signal, one per notification is a log flood.
    if (this.warned.has(sessionId)) return;
    this.warned.add(sessionId);
    this.log(`[tag-resolver] ${sessionId}: ${message}`);
  }

  private store(sessionId: string, tag: string | null, generation: number, cacheNegative: boolean): void {
    // Something invalidated while this lookup was in flight, so its answer is
    // known-stale rather than merely old: drop it.
    if (generation !== this.generation) return;
    if (tag === null && !cacheNegative) return;
    const ttl = tag === null ? this.negativeTtlMs : this.ttlMs;
    // Re-insert rather than update so Map iteration order is insertion order,
    // which is what makes the eviction below evict the oldest.
    this.cache.delete(sessionId);
    this.cache.set(sessionId, { tag, expiresAt: this.nowFn() + ttl });
    // FIFO by write, not LRU: a read does not reorder. Evicting a hot session
    // needs 512 other writes inside its 10m TTL, and costs one tagless line
    // plus one spawn — not worth an access-order structure.
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
      // Keep `warned` from being the thing that grows without bound instead.
      this.warned.delete(oldest.value);
    }
  }
}

export interface WhichLine {
  tag: string;
  /** `manual` (a session tag OR a directory glob) or `auto`. */
  source: string;
  rootSessionId: string;
  /**
   * `session`, `dir` or `auto` — which rule produced the tag. Column 4, added
   * after the first three, so an older oc-tags omits it and this is undefined.
   * Callers that need to tell a session tag from a directory glob must treat
   * undefined as "unknown", never as `session`.
   */
  kind?: string;
}

/**
 * Parse `oc-tags which`: `tag\tsource\troot_session_id[\tkind]` on one line.
 * null when the line is missing, has fewer than three columns, or has no tag.
 */
export function parseWhichLine(stdout: string): WhichLine | null {
  const line = stdout.split("\n", 1)[0]?.trim();
  if (!line) return null;
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const tag = parts[0]!.trim();
  if (!tag) return null;
  const kind = parts[3]?.trim();
  return {
    tag,
    source: parts[1]!.trim(),
    rootSessionId: parts[2]!.trim(),
    ...(kind ? { kind } : {}),
  };
}

/**
 * The footer's view of `oc-tags which`: the tag, or null.
 *
 * Only `manual` renders. Every session always has a tag, and an untagged one
 * falls back to `auto:<dir>` — which says nothing the footer's own cwd line
 * does not already say, so showing it would be noise on every notification.
 */
export function parseWhich(stdout: string): string | null {
  const parsed = parseWhichLine(stdout);
  if (!parsed || parsed.source !== "manual") return null;
  return parsed.tag;
}

function lastLine(stderr: string): string {
  const lines = stderr.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

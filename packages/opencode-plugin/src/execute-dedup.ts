import { createHash } from "node:crypto"
import type { ExecuteCommandEnvelope } from "../../daemon/src/opencode-direct/contracts"
import type { ExecuteResult } from "./direct-channel"

export interface ExecuteDedupOptions {
  /** How long a dedup entry lives. Must exceed the daemon's bounded-retry window. */
  ttlMs?: number
  /** Injectable clock for testing. */
  now?: () => number
  /** Loud, operator-visible logger (defaults to console.warn). */
  log?: (message: string, data?: unknown) => void
}

type DedupEntry =
  | { status: "in_flight"; promise: Promise<ExecuteResult>; payloadHash: string; expiresAt: number }
  | { status: "succeeded"; result: ExecuteResult; payloadHash: string; expiresAt: number }

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1h

/**
 * Stable hash over the *semantic delivery content* (what actually gets injected
 * into the session). Deliberately excludes volatile metadata (issuedAt, request
 * routing) so legitimate retries of the same logical command hash identically.
 */
function hashPayload(request: ExecuteCommandEnvelope): string {
  const h = createHash("sha256")
  h.update(request.sessionId ?? "")
  h.update("\0")
  h.update(request.command ?? "")
  if (request.media) {
    h.update("\0")
    h.update(request.media.mime ?? "")
    h.update("\0")
    h.update(request.media.filename ?? "")
    h.update("\0")
    h.update(request.media.url ?? "")
  }
  return h.digest("hex")
}

/**
 * Wrap an execute handler so a given `commandId` injects at most once.
 *
 * This is the Phase 2 "linchpin": the plugin is the sink that performs the
 * non-idempotent injection (`prompt_async`), so it is the only place that can
 * recognise "I already injected commandId X" when the daemon retries an
 * ambiguous timeout. A daemon-side ledger cannot, because the revive fallback
 * bypasses the plugin entirely.
 *
 * At-least-once invariant: only *successful* results are cached and deduped.
 * Failures and thrown errors are NOT cached, so a retry re-attempts delivery.
 * In-memory only — a shield, not the source of truth (lost on restart).
 *
 * See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2a).
 */
export function withExecuteDedup(
  onExecute: (request: ExecuteCommandEnvelope) => Promise<ExecuteResult>,
  options: ExecuteDedupOptions = {},
): (request: ExecuteCommandEnvelope) => Promise<ExecuteResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string, data?: unknown) => console.warn(`[execute-dedup] ${message}`, data ?? ""))
  const cache = new Map<string, DedupEntry>()

  function evictExpired(t: number): void {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= t) cache.delete(key)
    }
  }

  return (request: ExecuteCommandEnvelope): Promise<ExecuteResult> => {
    const key = request.commandId
    // Without a commandId we cannot dedup; always execute (at-least-once).
    if (!key) return onExecute(request)

    const payloadHash = hashPayload(request)
    const t = now()
    evictExpired(t)

    const existing = cache.get(key)
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        // commandId reuse with a DIFFERENT payload — "should never happen" (the
        // worker mints unique ids). Treat the two as genuinely distinct messages
        // and deliver this one anyway: never-drop outranks the dedup invariant.
        // Surface loudly so the upstream id-reuse bug gets found and fixed.
        log("commandId reused with a different payload — delivering both (id-minting bug?)", {
          commandId: key,
          cachedHash: existing.payloadHash,
          incomingHash: payloadHash,
        })
        return onExecute(request)
      }
      if (existing.status === "succeeded") {
        // Already injected: return the cached success without re-injecting.
        return Promise.resolve({ ...existing.result, output: "duplicate" })
      }
      // In-flight: piggyback on the original call — no second injection.
      return existing.promise
    }

    // Record the in-flight entry SYNCHRONOUSLY before invoking onExecute, so two
    // concurrent duplicate requests can't both inject.
    let resolveOuter!: (result: ExecuteResult) => void
    let rejectOuter!: (error: unknown) => void
    const promise = new Promise<ExecuteResult>((resolve, reject) => {
      resolveOuter = resolve
      rejectOuter = reject
    })
    cache.set(key, { status: "in_flight", promise, payloadHash, expiresAt: t + ttlMs })

    // Invoke onExecute synchronously (so concurrent duplicates coalesce on the
    // in-flight entry), but guard against a *synchronous* throw — otherwise it
    // would escape this function and leave the in-flight entry permanently stuck
    // until TTL eviction, hanging every duplicate in the meantime.
    let execution: Promise<ExecuteResult>
    try {
      execution = onExecute(request)
    } catch (error) {
      cache.delete(key)
      rejectOuter(error)
      return promise
    }

    execution.then(
      (result) => {
        if (result.success) {
          cache.set(key, { status: "succeeded", result, payloadHash, expiresAt: now() + ttlMs })
        } else {
          // Don't cache failures: a retry must be able to re-attempt.
          cache.delete(key)
        }
        resolveOuter(result)
      },
      (error) => {
        cache.delete(key)
        rejectOuter(error)
      },
    )

    return promise
  }
}

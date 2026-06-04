import type { ExecuteCommandEnvelope } from "../../daemon/src/opencode-direct/contracts"
import type { ExecuteResult } from "./direct-channel"

export interface ExecuteDedupOptions {
  /** How long a dedup entry lives. Must exceed the daemon's bounded-retry window. */
  ttlMs?: number
  /** Injectable clock for testing. */
  now?: () => number
}

type DedupEntry =
  | { status: "in_flight"; promise: Promise<ExecuteResult>; expiresAt: number }
  | { status: "succeeded"; result: ExecuteResult; expiresAt: number }

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1h

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

    const t = now()
    evictExpired(t)

    const existing = cache.get(key)
    if (existing) {
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
    cache.set(key, { status: "in_flight", promise, expiresAt: t + ttlMs })

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
          cache.set(key, { status: "succeeded", result, expiresAt: now() + ttlMs })
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

/**
 * swarm_schedule — opencode tool that schedules a swarm message for future delivery
 * via the pigeon daemon.
 *
 * Dominant use case: waking yourself at a scheduled time or after a delay.
 * Self-wake defaults `to` to the calling session (ctx.sessionID).
 *
 * NOTE on naming: like swarm_read/swarm_send, the registration name must satisfy
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods).
 */

import { randomUUID } from "node:crypto"
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"

/**
 * Registration name for the swarm schedule tool. Must satisfy Anthropic's
 * tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods/slashes/spaces).
 */
export const SWARM_SCHEDULE_TOOL_NAME = "swarm_schedule" as const

export const SWARM_SCHEDULE_MAX_ATTEMPTS = 6 // 1 initial try + 5 retries
export const SWARM_SCHEDULE_INITIAL_BACKOFF_MS = 500
export const SWARM_SCHEDULE_BACKOFF_FACTOR = 2
export const SWARM_SCHEDULE_MAX_BACKOFF_MS = 8000

export class ScheduleRejectedError extends Error {
  constructor(daemonError: string) {
    super(
      `swarm_schedule REJECTED — the wake was NOT scheduled and will never fire: ${daemonError}`,
    )
    this.name = "ScheduleRejectedError"
  }
}

export interface SwarmScheduleOptions {
  daemonBaseUrl: string // e.g. http://127.0.0.1:4731
  sessionId: string // injected from ToolContext; becomes default `to` and `from`
  fetchFn?: typeof fetch
  /** Injectable sleep (tests pass a no-op recorder). Defaults to setTimeout. */
  sleepFn?: (ms: number) => Promise<void>
  /**
   * Injectable msg_id generator (tests pass a fixed id to assert idempotency
   * across retries). Defaults to the daemon's `msg_<base36>_<8hex>` format.
   */
  makeMsgId?: () => string
}

export interface SwarmScheduleArgs {
  message: string
  to?: string
  at?: string
  after?: string
  kind?: string
  priority?: string
  expires_in?: string
  ref?: string
}

export interface SwarmScheduleResult {
  msg_id: string
  to: string
  deliver_at: number
  expires_at: number
  attempts?: number
  already_banked?: boolean
}

function defaultMakeMsgId(): string {
  return `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempt: number): number {
  return Math.min(
    SWARM_SCHEDULE_INITIAL_BACKOFF_MS *
      SWARM_SCHEDULE_BACKOFF_FACTOR ** (attempt - 1),
    SWARM_SCHEDULE_MAX_BACKOFF_MS,
  )
}

function isTransientStatus(status: number): boolean {
  return (status >= 500 && status !== 503) || status === 429
}

/**
 * Pure helper: POSTs to /swarm/schedule and returns the minted msg_id and delivery timestamps.
 * Exported separately so unit tests can exercise it without going through the opencode tool runtime.
 */
export async function swarmSchedule(
  opts: SwarmScheduleOptions,
  args: SwarmScheduleArgs,
): Promise<SwarmScheduleResult> {
  const hasAt = typeof args.at === "string" && args.at.trim().length > 0
  const hasAfter = typeof args.after === "string" && args.after.trim().length > 0

  if ((hasAt && hasAfter) || (!hasAt && !hasAfter)) {
    throw new Error("Exactly one of 'at' or 'after' must be provided.")
  }

  const fetchFn = opts.fetchFn ?? fetch
  const sleepFn = opts.sleepFn ?? defaultSleep
  const makeMsgId = opts.makeMsgId ?? defaultMakeMsgId
  const url = new URL("/swarm/schedule", opts.daemonBaseUrl)

  const to = args.to ?? opts.sessionId
  const kind = args.kind ?? "chat"
  const priority = args.priority ?? "normal"

  const msgId = makeMsgId()

  const body: Record<string, unknown> = {
    from: opts.sessionId,
    to,
    kind,
    priority,
    payload: args.message,
    msg_id: msgId,
  }

  if (hasAt) body.at = args.at
  if (hasAfter) body.after = args.after
  if (args.expires_in) body.expires_in = args.expires_in
  if (args.ref) body.ref = args.ref

  const bodyJson = JSON.stringify(body)

  let token = resolveDaemonToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  let lastError: Error | undefined
  let authRetried = false

  for (let attempt = 1; attempt <= SWARM_SCHEDULE_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === SWARM_SCHEDULE_MAX_ATTEMPTS

    let res: Response
    try {
      res = await fetchFn(url.toString(), {
        method: "POST",
        headers,
        body: bodyJson,
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (isLast) {
        throw new Error(
          `swarm_schedule failed after ${attempt} attempts (daemon unreachable): ${lastError.message}`,
        )
      }
      await sleepFn(backoffMs(attempt))
      continue
    }

    if (res.ok) {
      try {
        const data = (await res.json()) as {
          accepted: boolean
          msg_id: string
          deliver_at: number
          expires_at: number
        }
        return {
          msg_id: data.msg_id,
          to,
          deliver_at: data.deliver_at,
          expires_at: data.expires_at,
          attempts: attempt,
        }
      } catch {
        return {
          msg_id: msgId,
          to,
          deliver_at: 0,
          expires_at: 0,
          attempts: attempt,
        }
      }
    }

    // `let`, not `const`: the 401 re-auth branch below REPLACES `res`, and the
    // 409, transient and permanent paths all report or PARSE `text`. Leaving it
    // bound to the first response pairs the retry's status with the 401's body.
    let text = await res.text().catch(() => "")

    // Special-case 503: Daemon scheduler is not running (a configuration problem).
    // MUST NOT be retried — retrying cannot help and merely wastes time on a configuration problem that cannot resolve itself.
    if (res.status === 503) {
      let daemonError = text
      try {
        const json = JSON.parse(text) as { error?: string }
        if (json && typeof json.error === "string") daemonError = json.error
      } catch {}
      throw new ScheduleRejectedError(daemonError)
    }

    if (res.status === 401 && !authRetried) {
      authRetried = true
      invalidateDaemonToken()
      const retryToken = resolveDaemonToken()
      if (retryToken) {
        headers["Authorization"] = `Bearer ${retryToken}`
      } else {
        delete headers["Authorization"]
      }
      try {
        res = await fetchFn(url.toString(), {
          method: "POST",
          headers,
          body: bodyJson,
        })
        if (res.ok) {
          try {
            const data = (await res.json()) as {
              accepted: boolean
              msg_id: string
              deliver_at: number
              expires_at: number
            }
            return {
              msg_id: data.msg_id,
              to,
              deliver_at: data.deliver_at,
              expires_at: data.expires_at,
              attempts: attempt,
            }
          } catch {
            return {
              msg_id: msgId,
              to,
              deliver_at: 0,
              expires_at: 0,
              attempts: attempt,
            }
          }
        }
        // Re-auth did not cure it. Adopt THIS response's body once, here, so
        // every path below (503, the 409 idempotency parse, transient and
        // permanent) describes the same response its status came from.
        text = await res.text().catch(() => "")
        if (res.status === 503) {
          let daemonError = text
          try {
            const json = JSON.parse(daemonError) as { error?: string }
            if (json && typeof json.error === "string") daemonError = json.error
          } catch {}
          throw new ScheduleRejectedError(daemonError)
        }
      } catch (err) {
        if (err instanceof ScheduleRejectedError) {
          throw err
        }
        lastError = err instanceof Error ? err : new Error(String(err))
        if (isLast) {
          throw new Error(
            `swarm_schedule failed after ${attempt} attempts (daemon unreachable): ${lastError.message}`,
          )
        }
        await sleepFn(backoffMs(attempt))
        continue
      }
    }

    if (res.status === 409 && attempt >= 2) {
      let returnedMsgId: string | undefined
      let deliverAt: number | undefined
      let expiresAt: number | undefined
      try {
        const json = JSON.parse(text) as {
          msg_id?: unknown
          deliver_at?: unknown
          expires_at?: unknown
        }
        if (typeof json.msg_id === "string") returnedMsgId = json.msg_id
        if (typeof json.deliver_at === "number") deliverAt = json.deliver_at
        if (typeof json.expires_at === "number") expiresAt = json.expires_at
      } catch {}

      if (returnedMsgId === undefined || returnedMsgId === msgId) {
        // STRUCTURAL ARGUMENT: msgId is a freshly-minted UUID-suffixed value unique
        // to this invocation. Therefore, a pre-existing row bearing this msg_id on
        // the daemon can only have been created by an earlier attempt of this exact
        // same call (e.g. attempt 1 reached the daemon and committed, but the network
        // response was lost before reaching us). That property holds structurally
        // even if the daemon or network misbehaves.
        return {
          msg_id: returnedMsgId ?? msgId,
          to,
          deliver_at: deliverAt ?? 0,
          expires_at: expiresAt ?? 0,
          attempts: attempt,
          already_banked: true,
        }
      }
    }

    if (isTransientStatus(res.status)) {
      lastError = new Error(`swarm_schedule failed: ${res.status} ${text}`)
      if (isLast) {
        throw new Error(
          `swarm_schedule failed after ${attempt} attempts: ${res.status} ${text}`,
        )
      }
      await sleepFn(backoffMs(attempt))
      continue
    }

    // Permanent (non-transient 4xx)
    throw new Error(`swarm_schedule failed: ${res.status} ${text}`)
  }

  throw lastError ?? new Error("swarm_schedule failed: exhausted retries")
}

export function formatScheduleResult(result: SwarmScheduleResult): string {
  const deliverIso = new Date(result.deliver_at).toISOString()
  const expiresIso = new Date(result.expires_at).toISOString()
  const base =
    `Scheduled ${result.msg_id} for ${result.to}. ` +
    `Delivery at ${deliverIso} (expires at ${expiresIso}).`

  if (result.already_banked) {
    return `${base} (Already banked by an earlier attempt.)`
  }

  if (result.attempts && result.attempts > 1) {
    return (
      `${base} (Accepted after ${result.attempts} attempts — transient ` +
      `daemon errors were retried.)`
    )
  }
  return base
}

export function createSwarmScheduleTool(daemonBaseUrl: string): ToolDefinition {
  return tool({
    description:
      "Schedule a swarm message for future delivery. The dominant use is waking yourself later at a scheduled time or after a delay. " +
      "The message MUST be self-contained and carry a durable pointer (such as a beads ID, PR number, or file path) — do NOT write vague messages like 'continue what you were doing', because the receiving session may have compacted away the context that motivated the wake. " +
      "Prefer `after` (a relative delay like '13h') — it is unambiguous and needs no timezone reasoning. " +
      "Example: after: '13h', message: 'Resume pigeon-c68: run bd show pigeon-c68, then continue W4 in .worktrees/wake-w4.'. " +
      "Use `at` only for a true wall-clock deadline, and note it requires a FULL RFC3339 timestamp with an offset or 'Z' " +
      "(e.g. '2026-08-02T09:00:00-04:00'); a bare time like '09:00' is REJECTED. " +
      "Messages under 40 chars are rejected. " +
      "A scheduled message expires if undelivered, defaulting to 6 hours after its delivery time (override with expires_in). " +
      "Use ref as an optional durable pointer rendered as an envelope attribute (e.g. bd:pigeon-mx2).",
    args: {
      message: tool.schema
        .string()
        .describe(
          "Self-contained raw message text (minimum 40 chars). Must include durable pointers (beads ID, PR#, file path). Do NOT include <swarm_message> tags.",
        ),
      to: tool.schema
        .string()
        .optional()
        .describe(
          "Recipient opencode session id (defaults to calling session for self-wake).",
        ),
      at: tool.schema
        .string()
        .optional()
        .describe(
          "Absolute delivery time as a FULL RFC3339 timestamp with a mandatory UTC offset or 'Z' " +
            "(e.g. '2026-08-02T09:00:00-04:00' or '2026-08-02T13:00:00Z'). A bare wall-clock time " +
            "like '09:00' is rejected as ambiguous — use 'after' instead for relative delays. " +
            "Exactly one of 'at' or 'after' is required.",
        ),
      after: tool.schema
        .string()
        .optional()
        .describe(
          "Relative delay spec for delivery (e.g. '30m', '2h', '1d'). Exactly one of 'at' or 'after' is required.",
        ),
      kind: tool.schema
        .string()
        .optional()
        .describe("Message kind (default 'chat')."),
      priority: tool.schema
        .string()
        .optional()
        .describe("Priority: 'urgent', 'normal' (default), or 'low'."),
      expires_in: tool.schema
        .string()
        .optional()
        .describe(
          "Expiration duration after delivery time (default '6h', e.g. '12h').",
        ),
      ref: tool.schema
        .string()
        .optional()
        .describe(
          "Optional durable pointer rendered as envelope attribute (e.g. 'bd:pigeon-mx2').",
        ),
    },
    async execute(args, ctx) {
      const result = await swarmSchedule(
        {
          daemonBaseUrl,
          sessionId: ctx.sessionID,
        },
        {
          message: args.message,
          to: args.to,
          at: args.at,
          after: args.after,
          kind: args.kind,
          priority: args.priority,
          expires_in: args.expires_in,
          ref: args.ref,
        },
      )
      ctx.metadata({
        title: `swarm schedule -> ${result.to}`,
        metadata: {
          msg_id: result.msg_id,
          to: result.to,
          deliver_at: result.deliver_at,
          expires_at: result.expires_at,
        },
      })
      return formatScheduleResult(result)
    },
  })
}

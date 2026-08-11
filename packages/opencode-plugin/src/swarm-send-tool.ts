/**
 * swarm_send — opencode tool that sends a swarm message to another session
 * via the pigeon daemon. The counterpart to swarm_read: read the inbox with
 * swarm_read, send with swarm_send.
 *
 * The calling session is used as `from` (taken from ToolContext), so the
 * sender identity can't be spoofed or typo'd. The `message` arg is RAW text —
 * pigeon wraps it in the <swarm_message> envelope on delivery, so callers must
 * NOT include envelope tags themselves (doing so is rejected by the daemon).
 *
 * NOTE on naming: like swarm_read, the registration name must satisfy
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods), so it is
 * an underscore-joined identifier.
 */

import { randomUUID } from "node:crypto"
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"

/**
 * Registration name for the swarm send tool. Must satisfy Anthropic's
 * tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods/slashes/spaces).
 */
export const SWARM_SEND_TOOL_NAME = "swarm_send" as const

/**
 * Bounded transient-retry policy for the sender-side POST. A routine
 * `pigeon-daemon` restart (the failure that motivated this) is brief (~2s);
 * the schedule below sleeps 500ms, 1s, 2s, 4s, 8s between attempts (~15.5s
 * total) — roughly 7x the expected downtime — before surfacing the error
 * inline instead of silently dropping the message.
 */
export const SWARM_SEND_MAX_ATTEMPTS = 6 // 1 initial try + 5 retries
export const SWARM_SEND_INITIAL_BACKOFF_MS = 500
export const SWARM_SEND_BACKOFF_FACTOR = 2
export const SWARM_SEND_MAX_BACKOFF_MS = 8000

export interface SwarmSendOptions {
  daemonBaseUrl: string // e.g. http://127.0.0.1:4731
  sessionId: string // injected from ToolContext; becomes the message `from`
  fetchFn?: typeof fetch
  /** Injectable sleep (tests pass a no-op recorder). Defaults to setTimeout. */
  sleepFn?: (ms: number) => Promise<void>
  /**
   * Injectable msg_id generator (tests pass a fixed id to assert idempotency
   * across retries). Defaults to the daemon's `msg_<base36>_<8hex>` format.
   */
  makeMsgId?: () => string
}

export interface SwarmSendArgs {
  to: string
  message: string
  kind?: string
  priority?: string
  reply_to?: string
}

export interface SwarmSendResult {
  msg_id: string
  to: string
  kind: string
  priority: string
  /** Number of POST attempts that were made (1 = succeeded on the first try). */
  attempts?: number
}

/**
 * Mirror of the daemon's `makeMsgId` (packages/daemon/src/ids.ts): a base36
 * timestamp prefix plus a short random suffix. We mint it on the SENDER side so
 * the same id is reused across retries; the daemon's `INSERT OR IGNORE` then
 * dedups a re-POST of an already-persisted row (effectively-once delivery even
 * though the transport is at-least-once).
 */
function defaultMakeMsgId(): string {
  return `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Backoff before the attempt AFTER `attempt` (1-indexed): exponential, capped.
 * attempt 1 -> 500, 2 -> 1000, 3 -> 2000, 4 -> 4000, 5 -> 8000 (capped).
 */
function backoffMs(attempt: number): number {
  return Math.min(
    SWARM_SEND_INITIAL_BACKOFF_MS *
      SWARM_SEND_BACKOFF_FACTOR ** (attempt - 1),
    SWARM_SEND_MAX_BACKOFF_MS,
  )
}

/**
 * A non-2xx status is transient (worth retrying) only for 5xx and 429. Every
 * other 4xx (e.g. the 400 for a literal </swarm_message> close tag, or a bad
 * `ses_` shape) is permanent — retrying would just burn time and still fail.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/**
 * Pure helper: POSTs to /swarm/send and returns the minted msg_id plus the
 * resolved routing fields. Exported separately so unit tests can exercise it
 * without going through the opencode tool runtime.
 *
 * The POST is wrapped in a bounded retry-with-backoff so a brief daemon outage
 * (e.g. a routine `pigeon-daemon` restart) does not silently drop the message.
 * We retry only TRANSIENT failures: a fetch rejection (ECONNREFUSED / "fetch
 * failed" / network reset / DNS / timeout), an HTTP 5xx, or a 429. Permanent
 * failures (other 4xx — notably the 400 for a literal </swarm_message> close
 * tag) throw immediately with the daemon's status + body so the caller sees the
 * real reason inline, exactly as before.
 *
 * A client-side msg_id is minted once and reused across attempts; the daemon's
 * `INSERT OR IGNORE` dedups it so a retried POST of an already-persisted row
 * never duplicates the message.
 */
export async function swarmSend(
  opts: SwarmSendOptions,
  args: SwarmSendArgs,
): Promise<SwarmSendResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const sleepFn = opts.sleepFn ?? defaultSleep
  const makeMsgId = opts.makeMsgId ?? defaultMakeMsgId
  const url = new URL("/swarm/send", opts.daemonBaseUrl)

  const kind = args.kind ?? "chat"
  const priority = args.priority ?? "normal"

  const token = resolveDaemonToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const body: Record<string, unknown> = {
    from: opts.sessionId,
    to: args.to,
    kind,
    priority,
    payload: args.message,
    msg_id: makeMsgId(), // stable idempotency key across retries
  }
  if (args.reply_to) body.reply_to = args.reply_to
  const bodyJson = JSON.stringify(body)

  let lastError: Error | undefined
  let authRetried = false
  // Distinct from `authRetried`, which is a BUDGET and is deliberately handed
  // back when the retry never reached the daemon. This one is a HISTORY flag:
  // once a refreshed token has actually been JUDGED AND REJECTED, say so in the
  // error, because "stale token, now fixed" and "the rotated token is also
  // wrong" are the same message otherwise.
  //
  // Deliberately set ONLY for a 401/403 on the retry, not for any non-ok
  // status. A re-auth that comes back 503 tells us nothing about the token, and
  // the outer loop can then burn its remaining attempts on an unrelated outage;
  // tagging that final "500 after 6 attempts" with "(re-auth attempted)" would
  // point a human at an auth fault that is not there -- the same misdirection
  // this marker exists to remove.
  let reauthAttempted = false

  for (let attempt = 1; attempt <= SWARM_SEND_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === SWARM_SEND_MAX_ATTEMPTS

    let res: Response
    try {
      res = await fetchFn(url.toString(), {
        method: "POST",
        headers,
        body: bodyJson,
      })
    } catch (err) {
      // A fetch rejection is a network-layer problem (connection refused/reset,
      // DNS, timeout) — always transient.
      lastError = err instanceof Error ? err : new Error(String(err))
      if (isLast) {
        throw new Error(
          `swarm_send failed after ${attempt} attempts (daemon unreachable): ${lastError.message}`,
        )
      }
      await sleepFn(backoffMs(attempt))
      continue
    }

    if (res.ok) {
      const data = (await res.json()) as { accepted: boolean; msg_id: string }
      return { msg_id: data.msg_id, to: args.to, kind, priority, attempts: attempt }
    }

    // `let`, not `const`: the 401 re-auth branch below REPLACES `res`, and every
    // error path after it reports `${res.status} ${text}`. Leaving this bound to
    // the first response's body pairs the retry's status with the original 401's
    // text -- e.g. a retry that 400s was reported as `400 Unauthorized`, which
    // sends a human looking for an auth fault that is not there.
    let text = await res.text().catch(() => "")

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
          const data = (await res.json()) as { accepted: boolean; msg_id: string }
          return { msg_id: data.msg_id, to: args.to, kind, priority, attempts: attempt }
        }
        // Re-auth did not cure it. Adopt THIS response's body so the status and
        // the text below describe the same response.
        text = await res.text().catch(() => "")
        if (res.status === 401 || res.status === 403) reauthAttempted = true
      } catch (err) {
        // A rejection here is the network layer, not auth -- and `res` still
        // holds the original 401, which is NOT transient, so falling through
        // would throw permanently and blame an auth failure we just cured.
        // Re-enter the outer loop instead: a token rotation and a daemon
        // restart are often the same event, and riding out that window is
        // exactly what the backoff budget is for.
        lastError = err instanceof Error ? err : new Error(String(err))
        // Give the one-shot back. `authRetried` is meant to record "the daemon
        // REJECTED a refreshed token, so refreshing again is pointless" -- but
        // this token never reached the daemon to be judged. The daemon can
        // start refusing the old token just before the new one lands on disk,
        // so the re-read above may legitimately still be stale; keeping the
        // budget spent would strand the send on the next 401. Bounded by
        // SWARM_SEND_MAX_ATTEMPTS regardless.
        authRetried = false
        if (isLast) {
          throw new Error(
            `swarm_send failed after ${attempt} attempts (daemon unreachable): ${lastError.message}`,
          )
        }
        await sleepFn(backoffMs(attempt))
        continue
      }
    }

    const authNote = reauthAttempted ? " (re-auth attempted)" : ""

    if (isTransientStatus(res.status)) {
      // No authNote on `lastError`: it is internal bookkeeping for the loop and
      // its message is never surfaced (every attempt-6 branch throws its own
      // Error, so the trailing `throw lastError` is unreachable). Decorating it
      // would be untested dead prose.
      lastError = new Error(`swarm_send failed: ${res.status} ${text}`)
      if (isLast) {
        throw new Error(
          `swarm_send failed after ${attempt} attempts: ${res.status} ${text}${authNote}`,
        )
      }
      await sleepFn(backoffMs(attempt))
      continue
    }

    // Permanent (non-transient 4xx): preserve the original inline-error format.
    throw new Error(`swarm_send failed: ${res.status} ${text}${authNote}`)
  }

  // Unreachable: the loop either returns, retries, or throws on every path.
  throw lastError ?? new Error("swarm_send failed: exhausted retries")
}

/**
 * Render the result as a concise confirmation line for the LLM. Delivery is
 * async (the daemon's arbiter delivers with retry), so this reports acceptance,
 * not proof-of-delivery — use swarm_read on the recipient side to verify.
 */
export function formatSendResult(
  result: SwarmSendResult,
  charCount: number,
): string {
  const base =
    `Queued ${result.msg_id} -> ${result.to} ` +
    `(kind=${result.kind} priority=${result.priority}, ${charCount} chars). ` +
    `Delivery is async.`
  if (result.attempts && result.attempts > 1) {
    return (
      `${base} (Accepted after ${result.attempts} attempts — transient ` +
      `daemon errors were retried.)`
    )
  }
  return base
}

/**
 * Build a `ToolDefinition` registered as `swarm_send` in the plugin's `tool`
 * map. The factory captures `daemonBaseUrl`; the runtime call needs `to` +
 * `message` (and optional kind/priority/reply_to) from the LLM and `sessionID`
 * from ToolContext.
 */
export function createSwarmSendTool(daemonBaseUrl: string): ToolDefinition {
  return tool({
    description:
      "Send a swarm message to another opencode session via the pigeon daemon. " +
      "Provide the RAW message text in `message` — pigeon wraps it in the " +
      "<swarm_message> envelope automatically, so do NOT include any envelope " +
      "tags yourself. The sender (`from`) is set automatically to the current " +
      "session. Delivery is asynchronous with retry; the recipient can use " +
      "swarm_read to see it, and swarm_list to discover session ids.",
    args: {
      to: tool.schema
        .string()
        .describe(
          "Recipient opencode session id (starts with 'ses_').",
        ),
      message: tool.schema
        .string()
        .describe(
          "Raw message text. Pigeon adds the <swarm_message> envelope " +
            "automatically — do NOT include envelope tags yourself.",
        ),
      kind: tool.schema
        .string()
        .optional()
        .describe(
          "Message kind (default 'chat'). Examples: chat, task.assign, " +
            "result, status.update, clarification.request.",
        ),
      priority: tool.schema
        .string()
        .optional()
        .describe("Priority: 'urgent', 'normal' (default), or 'low'."),
      reply_to: tool.schema
        .string()
        .optional()
        .describe("A prior msg_id to thread this message under."),
    },
    async execute(args, ctx) {
      const result = await swarmSend(
        // swarmSend resolves the token itself -- once per call, and again in
        // the one-shot 401 re-auth branch, which is what makes a rotation
        // recoverable without a plugin reload. There is no
        // way to pin one from here any more: the `authToken` option was
        // DELETED (pigeon-zox1) rather than documented, because passing it
        // held the value for the whole call and made the 401 re-auth retry
        // re-send the same dead token after invalidateDaemonToken() had
        // cleared the cache -- the pigeon-iy4 outage. The invalid state is now
        // unrepresentable instead of merely warned against.
        {
          daemonBaseUrl,
          sessionId: ctx.sessionID,
        },
        {
          to: args.to,
          message: args.message,
          kind: args.kind,
          priority: args.priority,
          reply_to: args.reply_to,
        },
      )
      ctx.metadata({
        title: `swarm send -> ${result.to}`,
        metadata: {
          msg_id: result.msg_id,
          to: result.to,
          kind: result.kind,
          priority: result.priority,
        },
      })
      return formatSendResult(result, args.message.length)
    },
  })
}

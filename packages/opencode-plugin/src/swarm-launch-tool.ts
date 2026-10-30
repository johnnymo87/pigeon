/**
 * swarm_launch — opencode tool that launches a fresh session on another machine
 * via the pigeon daemon. (pigeon-k0qn.17)
 *
 * An agent calls `swarm_launch` with {machine, directory, prompt, tag?}.
 * The plugin resolves the root session id to use as `from`, mints a stable
 * `launch_id = rl_<base36 now>_<8 hex>`, and POSTs to daemon `/swarm/launch`
 * with transient retry. The launched session runs on the target machine, and
 * the result arrives as a `launch.result` swarm message.
 */

import { randomUUID } from "node:crypto"
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"
import { resolveServeAuthHeader, invalidateServeAuthHeader } from "./serve-auth"

export const SWARM_LAUNCH_TOOL_NAME = "swarm_launch" as const

export const SWARM_LAUNCH_MAX_ATTEMPTS = 6 // 1 initial try + 5 retries
export const SWARM_LAUNCH_INITIAL_BACKOFF_MS = 500
export const SWARM_LAUNCH_BACKOFF_FACTOR = 2
export const SWARM_LAUNCH_MAX_BACKOFF_MS = 8000

export interface SwarmLaunchArgs {
  machine: string
  directory: string
  prompt: string
  tag?: string
}

export interface SwarmLaunchRequestOptions {
  daemonBaseUrl: string
  from: string
  fetchFn?: typeof fetch
  sleepFn?: (ms: number) => Promise<void>
  makeLaunchId?: () => string
}

export interface SwarmLaunchResult {
  launch_id: string
  status: "accepted" | "pending"
  message: string
}

/**
 * Mint launch_id: rl_<base36 now>_<8 hex>.
 */
function defaultMakeLaunchId(): string {
  return `rl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempt: number): number {
  return Math.min(
    SWARM_LAUNCH_INITIAL_BACKOFF_MS *
      SWARM_LAUNCH_BACKOFF_FACTOR ** (attempt - 1),
    SWARM_LAUNCH_MAX_BACKOFF_MS,
  )
}

/**
 * Follow parentID via GET /session/<id> on the plugin's internalFetch + serverUrl,
 * at most 8 hops. Any failure -> return the furthest session id reached.
 */
export async function resolveRootSession(
  sessionId: string,
  serverUrl: string,
  fetchFn: typeof fetch,
  maxHops: number = 8,
): Promise<string> {
  let currentId = sessionId
  const seen = new Set<string>([sessionId])

  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const url = new URL(`/session/${encodeURIComponent(currentId)}`, serverUrl)
      const headers: Record<string, string> = {}
      const authHeader = resolveServeAuthHeader()
      if (authHeader) headers["Authorization"] = authHeader

      const res = await fetchFn(
        new Request(url.toString(), { method: "GET", headers }),
      )
      if (res.status === 401) {
        invalidateServeAuthHeader()
      }
      if (!res.ok) {
        return currentId
      }
      const data = (await res.json().catch(() => null)) as {
        parentID?: string
        data?: { parentID?: string }
      } | null
      const parentId = data?.parentID ?? data?.data?.parentID
      if (!parentId || typeof parentId !== "string" || seen.has(parentId)) {
        return currentId
      }
      seen.add(parentId)
      currentId = parentId
    } catch {
      return currentId
    }
  }

  return currentId
}

/**
 * Worker / daemon refusal codes passed through as terminal errors.
 */
const KNOWN_429_REFUSALS = new Set(["queue_full", "rate_limited"])
const KNOWN_503_REFUSALS = new Set(["target_offline", "launch_unavailable", "no_worker"])

function formatErrorMessage(code: string | undefined, detail: string | undefined, fallback: string): string {
  if (code && detail) return `${code}: ${detail}`
  if (code) return code
  if (detail) return detail
  return fallback
}

/**
 * POST /swarm/launch helper with retry and error classification.
 */
export async function swarmLaunch(
  opts: SwarmLaunchRequestOptions,
  args: SwarmLaunchArgs,
): Promise<SwarmLaunchResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const sleepFn = opts.sleepFn ?? defaultSleep
  const makeLaunchId = opts.makeLaunchId ?? defaultMakeLaunchId
  const url = new URL("/swarm/launch", opts.daemonBaseUrl)

  const launchId = makeLaunchId()

  const token = resolveDaemonToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const body: Record<string, unknown> = {
    launch_id: launchId,
    from: opts.from,
    machine: args.machine,
    directory: args.directory,
    prompt: args.prompt,
  }
  if (args.tag !== undefined) {
    body.tag = args.tag
  }
  const bodyJson = JSON.stringify(body)

  let authRetried = false
  let sawDaemon5xx = false

  const pendingMessage = (id: string) =>
    `Launch ${id} is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.`

  for (let attempt = 1; attempt <= SWARM_LAUNCH_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === SWARM_LAUNCH_MAX_ATTEMPTS

    let res: Response
    try {
      res = await fetchFn(url.toString(), {
        method: "POST",
        headers,
        body: bodyJson,
      })
    } catch {
      if (isLast) {
        if (sawDaemon5xx) {
          return {
            launch_id: launchId,
            status: "pending",
            message: pendingMessage(launchId),
          }
        }
        throw new Error("swarm_launch failed: daemon unreachable")
      }
      await sleepFn(backoffMs(attempt))
      continue
    }

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        launch_id?: string
        status?: string
        to_machine?: string
      }
      const returnedId = data.launch_id ?? launchId
      if (data.status === "accepted") {
        const toMachine = data.to_machine ?? args.machine
        return {
          launch_id: returnedId,
          status: "accepted",
          message: `Launch ${returnedId} accepted for ${toMachine}. The result arrives as a launch.result swarm message.`,
        }
      }
      return {
        launch_id: returnedId,
        status: "pending",
        message: pendingMessage(returnedId),
      }
    }

    let text = await res.text().catch(() => "")

    // 401 re-auth
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
          const data = (await res.json().catch(() => ({}))) as {
            launch_id?: string
            status?: string
            to_machine?: string
          }
          const returnedId = data.launch_id ?? launchId
          if (data.status === "accepted") {
            const toMachine = data.to_machine ?? args.machine
            return {
              launch_id: returnedId,
              status: "accepted",
              message: `Launch ${returnedId} accepted for ${toMachine}. The result arrives as a launch.result swarm message.`,
            }
          }
          return {
            launch_id: returnedId,
            status: "pending",
            message: pendingMessage(returnedId),
          }
        }
        text = await res.text().catch(() => "")
      } catch {
        authRetried = false
        if (isLast) {
          if (sawDaemon5xx) {
            return {
              launch_id: launchId,
              status: "pending",
              message: pendingMessage(launchId),
            }
          }
          throw new Error("swarm_launch failed: daemon unreachable")
        }
        await sleepFn(backoffMs(attempt))
        continue
      }
    }

    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }

    const code =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.code === "string"
          ? parsed.code
          : undefined
    const detail = typeof parsed?.detail === "string" ? parsed.detail : undefined

    // 404 without a code: too old
    if (res.status === 404 && !code) {
      throw new Error("pigeon on this machine is too old for swarm_launch")
    }

    // Refusals (permanent errors):
    // 1. Any 4xx except 429
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new Error(formatErrorMessage(code, detail, `swarm_launch failed: ${res.status} ${text}`))
    }

    // 2. 429 with known worker code
    if (res.status === 429 && code && KNOWN_429_REFUSALS.has(code)) {
      throw new Error(formatErrorMessage(code, detail, `swarm_launch failed: 429 ${text}`))
    }

    // 3. 503 with known refusal code
    if (res.status === 503 && code && KNOWN_503_REFUSALS.has(code)) {
      throw new Error(formatErrorMessage(code, detail, `swarm_launch failed: 503 ${text}`))
    }

    // Transient errors:
    if (res.status >= 500) {
      sawDaemon5xx = true
    }

    if (isLast) {
      if (sawDaemon5xx) {
        return {
          launch_id: launchId,
          status: "pending",
          message: pendingMessage(launchId),
        }
      }
      throw new Error(`swarm_launch failed: ${res.status} ${text}`)
    }

    await sleepFn(backoffMs(attempt))
  }

  // Unreachable
  throw new Error("swarm_launch failed: daemon unreachable")
}

/**
 * Build a `ToolDefinition` registered as `swarm_launch`.
 */
export function createSwarmLaunchTool(
  daemonBaseUrl: string,
  serverUrl: string,
  internalFetchFn: typeof fetch,
  daemonFetchFn?: typeof fetch,
): ToolDefinition {
  return tool({
    description:
      "Start a FRESH session on another machine via the pigeon daemon. " +
      "Call ONCE per launch; the result arrives as a launch.result swarm message. " +
      "'pending' means do not call again; a pool restart on that machine kills " +
      "the launched session (see the cross-device-deployment skill).",
    args: {
      machine: tool.schema
        .string()
        .describe("Target machine id to launch the session on (e.g. 'devbox', 'cloudbox')."),
      directory: tool.schema
        .string()
        .describe(
          "Working directory for the new session: absolute path or ~/... or a bare project name expanded to ~/projects/<name> on the target machine.",
        ),
      prompt: tool.schema
        .string()
        .describe("Initial prompt for the launched session."),
      tag: tool.schema
        .string()
        .optional()
        .describe("Optional tag for oc-tags cost attribution."),
    },
    async execute(args, ctx) {
      const from = await resolveRootSession(
        ctx.sessionID,
        serverUrl,
        internalFetchFn,
      )

      const result = await swarmLaunch(
        {
          daemonBaseUrl,
          from,
          fetchFn: daemonFetchFn,
        },
        args,
      )

      ctx.metadata({
        title: `swarm launch -> ${args.machine}`,
        metadata: {
          launch_id: result.launch_id,
          machine: args.machine,
          directory: args.directory,
          status: result.status,
        },
      })

      return result.message
    },
  })
}

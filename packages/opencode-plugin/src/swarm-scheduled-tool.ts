/**
 * swarm_scheduled — opencode tool that lists or cancels scheduled swarm messages.
 *
 * NOTE on naming: like swarm_read/swarm_send, the registration name must satisfy
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"

export const SWARM_SCHEDULED_TOOL_NAME = "swarm_scheduled" as const

export interface ScheduledMessage {
  msg_id: string
  from: string
  to: string
  kind: string
  priority: string
  payload: string
  state: string
  deliver_at: number
  expires_at: number
  created_at: number
  ref?: string
}

export interface SwarmScheduledOptions {
  daemonBaseUrl: string // e.g. http://127.0.0.1:4731
  sessionId: string // ctx.sessionID
  fetchFn?: typeof fetch
  now?: number // injectable current time for relative formatting in tests
}

export interface SwarmScheduledArgs {
  action: "list" | "cancel"
  msg_id?: string
}

export async function swarmScheduledList(
  opts: SwarmScheduledOptions,
): Promise<ScheduledMessage[]> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/scheduled", opts.daemonBaseUrl)
  url.searchParams.set("session", opts.sessionId)

  let token = resolveDaemonToken()
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`

  let res = await fetchFn(url.toString(), { method: "GET", headers })

  if (res.status === 401) {
    invalidateDaemonToken()
    const retryToken = resolveDaemonToken()
    if (retryToken) {
      headers["Authorization"] = `Bearer ${retryToken}`
    } else {
      delete headers["Authorization"]
    }
    res = await fetchFn(url.toString(), { method: "GET", headers })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`swarm_scheduled list failed: ${res.status} ${text}`)
  }

  const data = (await res.json()) as { scheduled: ScheduledMessage[] }
  return data.scheduled ?? []
}

export async function swarmScheduledCancel(
  opts: SwarmScheduledOptions,
  msgId: string,
): Promise<{ cancelled: boolean; msg_id: string }> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL(
    `/swarm/scheduled/${encodeURIComponent(msgId)}/cancel`,
    opts.daemonBaseUrl,
  )

  let token = resolveDaemonToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const bodyJson = JSON.stringify({ from: opts.sessionId })

  let res = await fetchFn(url.toString(), {
    method: "POST",
    headers,
    body: bodyJson,
  })

  if (res.status === 401) {
    invalidateDaemonToken()
    const retryToken = resolveDaemonToken()
    if (retryToken) {
      headers["Authorization"] = `Bearer ${retryToken}`
    } else {
      delete headers["Authorization"]
    }
    res = await fetchFn(url.toString(), {
      method: "POST",
      headers,
      body: bodyJson,
    })
  }

  if (res.ok) {
    const data = (await res.json()) as { cancelled: boolean; msg_id: string }
    return data
  }

  const text = await res.text().catch(() => "")

  if (res.status === 404) {
    throw new Error(`Failed to cancel ${msgId}: no such scheduled message.`)
  }

  if (res.status === 403) {
    throw new Error(`Failed to cancel ${msgId}: only the original sender may cancel it.`)
  }

  if (res.status === 409) {
    let stateStr: string | undefined
    try {
      const json = JSON.parse(text) as { state?: string }
      if (json && typeof json.state === "string") stateStr = json.state
    } catch {}
    if (stateStr) {
      throw new Error(
        `Failed to cancel ${msgId}: cannot cancel message in state '${stateStr}'.`,
      )
    }
    throw new Error(
      `Failed to cancel ${msgId}: message is already in a terminal state.`,
    )
  }

  throw new Error(`swarm_scheduled cancel failed: ${res.status} ${text}`)
}

function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  if (totalSecs < 60) return `${totalSecs}s`
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins < 60) {
    return secs > 0 ? `${mins}m${secs}s` : `${mins}m`
  }
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) {
    return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`
}

function formatRelativeTime(deliverAt: number, now: number, state: string): string {
  const diffMs = deliverAt - now
  if (diffMs > 0) {
    return `in ${formatDuration(diffMs)}`
  }
  const agoMs = Math.abs(diffMs)
  if (state === "queued") {
    return `overdue by ${formatDuration(agoMs)}`
  }
  return `${formatDuration(agoMs)} ago`
}

export function formatScheduledList(
  messages: ScheduledMessage[],
  sessionId: string,
  now: number,
): string {
  if (messages.length === 0) {
    return "No scheduled messages found."
  }

  return messages
    .map((m) => {
      const relTime = formatRelativeTime(m.deliver_at, now, m.state)
      const absTime = new Date(m.deliver_at).toISOString()

      let dirStr = ""
      if (m.from !== m.to) {
        if (m.from === sessionId) {
          dirStr = ` [to: ${m.to}]`
        } else if (m.to === sessionId) {
          dirStr = ` [from: ${m.from}]`
        } else {
          dirStr = ` [${m.from} -> ${m.to}]`
        }
      }

      const refStr = m.ref ? ` [ref: ${m.ref}]` : ""
      const payloadPreview = m.payload.replace(/\s+/g, " ")
      const truncatedPayload =
        payloadPreview.length > 60
          ? `${payloadPreview.slice(0, 57)}...`
          : payloadPreview

      return `${m.msg_id} [${m.state}] deliver: ${absTime} (${relTime})${dirStr}${refStr} - "${truncatedPayload}"`
    })
    .join("\n")
}

export function createSwarmScheduledTool(
  daemonBaseUrl: string,
): ToolDefinition {
  return tool({
    description:
      "Manage scheduled swarm messages. " +
      "Use action 'list' to view pending (queued) and recent terminal scheduled messages (expired, failed, cancelled) for the current session. Note: successfully delivered wakes (handed_off) do not appear in this list, so absence of a past scheduled wake implies it was delivered. " +
      "Use action 'cancel' with `msg_id` to cancel a pending queued scheduled message before it fires.",
    args: {
      action: tool.schema
        .string()
        .describe("Action to perform: 'list' or 'cancel'."),
      msg_id: tool.schema
        .string()
        .optional()
        .describe(
          "Message ID to cancel (required when action is 'cancel').",
        ),
    },
    async execute(args, ctx) {
      const action = args.action as string
      if (action !== "list" && action !== "cancel") {
        throw new Error(
          `Invalid action '${args.action}': expected 'list' or 'cancel'`,
        )
      }

      const opts: SwarmScheduledOptions = {
        daemonBaseUrl,
        sessionId: ctx.sessionID,
      }

      if (action === "cancel") {
        if (!args.msg_id || args.msg_id.trim().length === 0) {
          throw new Error("msg_id is required when action is 'cancel'")
        }
        const trimmedMsgId = args.msg_id.trim()
        const res = await swarmScheduledCancel(opts, trimmedMsgId)
        ctx.metadata({
          title: `swarm scheduled cancel ${res.msg_id}`,
          metadata: { msg_id: res.msg_id },
        })
        return `Cancelled scheduled message ${res.msg_id}.`
      }

      const messages = await swarmScheduledList(opts)
      ctx.metadata({
        title: `swarm scheduled list (${messages.length})`,
        metadata: { count: messages.length },
      })
      return formatScheduledList(messages, ctx.sessionID, Date.now())
    },
  })
}

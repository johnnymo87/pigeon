/**
 * swarm_read — opencode tool that fetches the current session's swarm
 * inbox from pigeon. Receivers call this when they want to see backlog
 * or check for messages they haven't seen pushed yet.
 *
 * The tool gets the calling sessionID from ToolContext. The daemon URL
 * is injected at registration time (closed-over from the plugin entry).
 *
 * NOTE on naming: the tool used to be registered as "swarm.read", but
 * Anthropic's API rejects tool names containing characters outside
 * `^[a-zA-Z0-9_-]{1,128}$`. Periods are not allowed, so the original
 * name produced a 400 error on every fresh opencode session that loaded
 * the plugin. The name is now an underscore-joined identifier.
 *
 * Args:
 *   since: optional msg_id cursor; if omitted, returns from the start
 *          of retention (default 7 days).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

/**
 * Registration name for the swarm-inbox replay tool. Must satisfy
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods,
 * no slashes, no spaces). Exported so the plugin entry point and tests
 * share a single source of truth.
 */
export const SWARM_READ_TOOL_NAME = "swarm_read" as const

export interface SwarmReadOptions {
  daemonBaseUrl: string // e.g. http://127.0.0.1:4731
  sessionId: string // injected from ToolContext at execute-time
  fetchFn?: typeof fetch
}

export interface SwarmInboxMessage {
  msg_id: string
  from: string
  kind: string
  priority: string
  payload: string
  reply_to: string | null
  created_at: number
}

/**
 * Pure helper: hits GET /swarm/inbox?session=<id>[&since=<msg_id>] and
 * returns the parsed messages array. Exported separately so unit tests
 * can exercise it without going through the opencode tool runtime.
 */
export async function swarmRead(
  opts: SwarmReadOptions,
  since?: string,
): Promise<SwarmInboxMessage[]> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/inbox", opts.daemonBaseUrl)
  url.searchParams.set("session", opts.sessionId)
  if (since) url.searchParams.set("since", since)

  const res = await fetchFn(url.toString())
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`swarm_read failed: ${res.status} ${body}`)
  }
  const body = (await res.json()) as { messages: SwarmInboxMessage[] }
  return body.messages
}

/**
 * Format inbox messages as a single string the LLM can reason about.
 * Each message is rendered as a compact block with routing metadata
 * followed by its payload.
 */
export function formatInbox(messages: SwarmInboxMessage[]): string {
  if (messages.length === 0) {
    return "Inbox is empty."
  }
  const blocks = messages.map((m) => {
    const replyTo = m.reply_to ? ` reply_to=${m.reply_to}` : ""
    const ts = new Date(m.created_at).toISOString()
    return [
      `--- msg_id=${m.msg_id} from=${m.from} kind=${m.kind} priority=${m.priority}${replyTo} at=${ts} ---`,
      m.payload,
    ].join("\n")
  })
  return blocks.join("\n\n")
}

/**
 * Build a `ToolDefinition` registered as `swarm_read` in the plugin's
 * `tool` map. The factory captures `daemonBaseUrl` so the runtime call
 * only needs `since` from the LLM and `sessionID` from ToolContext.
 */
export function createSwarmReadTool(daemonBaseUrl: string): ToolDefinition {
  return tool({
    description:
      "Read swarm messages addressed to the current session from the pigeon daemon. " +
      "Use this to check for backlog or messages that weren't pushed via prompt_async (e.g. low-priority chatter). " +
      "Optionally pass a `since` msg_id cursor to fetch only messages newer than a known msg_id.",
    args: {
      since: tool.schema
        .string()
        .optional()
        .describe(
          "Optional msg_id cursor. When provided, only messages with msg_id > this value are returned.",
        ),
    },
    async execute(args, ctx) {
      const messages = await swarmRead(
        { daemonBaseUrl, sessionId: ctx.sessionID },
        args.since,
      )
      ctx.metadata({
        title: `swarm inbox (${messages.length})`,
        metadata: { count: messages.length, since: args.since ?? null },
      })
      return formatInbox(messages)
    },
  })
}

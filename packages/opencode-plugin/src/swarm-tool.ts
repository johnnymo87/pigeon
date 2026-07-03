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

/** Cursor-based query for the inbox. All fields are optional. */
export interface SwarmReadQuery {
  /** Only messages strictly newer than this msg_id (forward replay). */
  since?: string
  /** Only messages strictly older than this msg_id (scroll back). */
  before?: string
  /** Max messages to return. */
  limit?: number
}

/** One page of inbox messages plus whether more exist beyond the window. */
export interface SwarmReadPage {
  messages: SwarmInboxMessage[]
  hasMore: boolean
}

/**
 * Pure helper: hits GET
 * /swarm/inbox?session=<id>[&since=][&before=][&limit=] and returns the
 * parsed page (messages + has_more). Exported separately so unit tests can
 * exercise it without going through the opencode tool runtime.
 */
export async function swarmRead(
  opts: SwarmReadOptions,
  query: SwarmReadQuery = {},
): Promise<SwarmReadPage> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/inbox", opts.daemonBaseUrl)
  url.searchParams.set("session", opts.sessionId)
  if (query.since) url.searchParams.set("since", query.since)
  if (query.before) url.searchParams.set("before", query.before)
  if (typeof query.limit === "number") {
    url.searchParams.set("limit", String(query.limit))
  }

  const res = await fetchFn(url.toString())
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`swarm_read failed: ${res.status} ${body}`)
  }
  const body = (await res.json()) as {
    messages: SwarmInboxMessage[]
    has_more?: boolean
  }
  return { messages: body.messages, hasMore: body.has_more ?? false }
}

/** Rendering options for {@link formatInbox}. */
export interface FormatInboxOptions {
  /** Whether more messages exist beyond the returned window. */
  hasMore?: boolean
  /**
   * Paging direction, used to choose the right "get more" hint:
   * - "forward": more RECENT messages remain → page with `since=<newest>`.
   * - "recent" (default): OLDER messages remain → page with `before=<oldest>`.
   */
  mode?: "forward" | "recent"
}

/**
 * Format inbox messages as a single string the LLM can reason about.
 * Each message is rendered as a compact block with routing metadata
 * followed by its payload. When `hasMore` is set, a trailing hint tells
 * the model how to fetch the next page.
 */
export function formatInbox(
  messages: SwarmInboxMessage[],
  opts: FormatInboxOptions = {},
): string {
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
  let out = blocks.join("\n\n")

  if (opts.hasMore) {
    if (opts.mode === "forward") {
      const newest = messages[messages.length - 1]!.msg_id
      out += `\n\nMore recent messages arrived after these. Call swarm_read again with since="${newest}" to continue.`
    } else {
      const oldest = messages[0]!.msg_id
      out += `\n\nOlder messages exist beyond this page. Call swarm_read again with before="${oldest}" to see them.`
    }
  }
  return out
}

/** Default page size for swarm_read when the caller doesn't specify `limit`. */
export const SWARM_READ_DEFAULT_LIMIT = 10 as const

/**
 * Build a `ToolDefinition` registered as `swarm_read` in the plugin's
 * `tool` map. The factory captures `daemonBaseUrl`; at runtime the tool
 * takes optional `since`/`before`/`limit` from the LLM and `sessionID`
 * from ToolContext.
 */
export function createSwarmReadTool(daemonBaseUrl: string): ToolDefinition {
  return tool({
    description:
      "Read swarm messages addressed to the current session from the pigeon daemon. " +
      "Use this to check for backlog or messages that weren't pushed via prompt_async (e.g. low-priority chatter). " +
      `Returns the newest ${SWARM_READ_DEFAULT_LIMIT} messages by default (most recent last). ` +
      "Pagination is cursor-based: pass `before` (an older-than cursor) to scroll back through history, " +
      "or `since` (a newer-than cursor) to drain forward from a known point. When more messages exist beyond " +
      "the returned page, the output ends with a hint telling you which cursor to pass next.",
    args: {
      since: tool.schema
        .string()
        .optional()
        .describe(
          "Forward cursor: only messages with msg_id > this value, oldest-first (drain forward / catch up).",
        ),
      before: tool.schema
        .string()
        .optional()
        .describe(
          "Backward cursor: only messages with msg_id < this value, newest-first within the window (scroll back through history).",
        ),
      limit: tool.schema
        .number()
        .optional()
        .describe(
          `Max messages to return (default ${SWARM_READ_DEFAULT_LIMIT}). The response is always chronological (oldest-first).`,
        ),
    },
    async execute(args, ctx) {
      const limit = typeof args.limit === "number" ? args.limit : SWARM_READ_DEFAULT_LIMIT
      // `since` implies forward drain; otherwise it's a recent/scroll-back view.
      const mode: "forward" | "recent" = args.since ? "forward" : "recent"
      const { messages, hasMore } = await swarmRead(
        { daemonBaseUrl, sessionId: ctx.sessionID },
        { since: args.since, before: args.before, limit },
      )
      ctx.metadata({
        title: `swarm inbox (${messages.length}${hasMore ? "+" : ""})`,
        metadata: {
          count: messages.length,
          since: args.since ?? null,
          before: args.before ?? null,
          limit,
          has_more: hasMore,
        },
      })
      return formatInbox(messages, { hasMore, mode })
    },
  })
}

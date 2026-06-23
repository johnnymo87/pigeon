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

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

/**
 * Registration name for the swarm send tool. Must satisfy Anthropic's
 * tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods/slashes/spaces).
 */
export const SWARM_SEND_TOOL_NAME = "swarm_send" as const

export interface SwarmSendOptions {
  daemonBaseUrl: string // e.g. http://127.0.0.1:4731
  sessionId: string // injected from ToolContext; becomes the message `from`
  authToken?: string // when set, sent as `Authorization: Bearer <token>`
  fetchFn?: typeof fetch
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
}

/**
 * Pure helper: POSTs to /swarm/send and returns the minted msg_id plus the
 * resolved routing fields. Exported separately so unit tests can exercise it
 * without going through the opencode tool runtime.
 *
 * Throws (with the daemon's status + body) on any non-2xx response so the
 * caller sees the real reason inline — notably a 400 when the payload contains
 * the literal </swarm_message> close tag.
 */
export async function swarmSend(
  opts: SwarmSendOptions,
  args: SwarmSendArgs,
): Promise<SwarmSendResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/send", opts.daemonBaseUrl)

  const kind = args.kind ?? "chat"
  const priority = args.priority ?? "normal"

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`

  const body: Record<string, unknown> = {
    from: opts.sessionId,
    to: args.to,
    kind,
    priority,
    payload: args.message,
  }
  if (args.reply_to) body.reply_to = args.reply_to

  const res = await fetchFn(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`swarm_send failed: ${res.status} ${text}`)
  }

  const data = (await res.json()) as { accepted: boolean; msg_id: string }
  return { msg_id: data.msg_id, to: args.to, kind, priority }
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
  return (
    `Queued ${result.msg_id} -> ${result.to} ` +
    `(kind=${result.kind} priority=${result.priority}, ${charCount} chars). ` +
    `Delivery is async.`
  )
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
        {
          daemonBaseUrl,
          sessionId: ctx.sessionID,
          authToken: process.env.PIGEON_DAEMON_AUTH_TOKEN?.trim() || undefined,
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

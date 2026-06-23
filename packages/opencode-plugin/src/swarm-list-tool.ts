/**
 * swarm_list — opencode tool that lists local opencode sessions across all
 * projects, so an agent can discover the session ids of its peers (e.g. to
 * pick a `to` for swarm_send). This replaces the old `opencode-send --list`
 * CLI.
 *
 * It hits the serve's cross-project `GET /experimental/session` endpoint via
 * the plugin's in-process fetch (the same `internalFetch` + `ctx.serverUrl`
 * the plugin uses for prompt_async), because in TUI mode no network HTTP
 * server is listening and a raw fetch to serverUrl would fail.
 *
 * Naming: like swarm_read/swarm_send, the registration name must satisfy
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` (no periods).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

export const SWARM_LIST_TOOL_NAME = "swarm_list" as const

export interface SwarmSession {
  id: string
  title?: string
  directory?: string
  time?: { updated?: number; created?: number }
}

export interface SwarmListOptions {
  serverUrl: string // ctx.serverUrl from the plugin scope
  fetchFn: typeof fetch // the plugin's internalFetch (required)
  limit?: number
}

/**
 * Pure helper: GET /experimental/session?limit=<n> and return the sessions
 * sorted most-recently-updated first. The cross-project endpoint is used
 * deliberately (the project-scoped /session would only show the caller's
 * project, which is wrong for swarm discovery).
 *
 * Throws (with status + body) on any non-2xx so the caller sees the reason.
 */
export async function swarmList(
  opts: SwarmListOptions,
): Promise<SwarmSession[]> {
  const limit = opts.limit ?? 100
  const url = new URL("/experimental/session", opts.serverUrl)
  url.searchParams.set("limit", String(limit))

  const res = await opts.fetchFn(
    new Request(url.toString(), { method: "GET" }),
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`swarm_list failed: ${res.status} ${text}`)
  }

  const sessions = (await res.json()) as SwarmSession[]
  return [...sessions].sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  )
}

function relativeAge(updated: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - updated) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

/**
 * Render sessions as a compact table the LLM can reason about: id, relative
 * updated time, directory, title. Mirrors the old `opencode-send --list`
 * output.
 */
export function formatSessions(sessions: SwarmSession[], now: number): string {
  if (sessions.length === 0) return "No sessions found."
  const header = ["ID", "UPDATED", "DIRECTORY", "TITLE"]
  const rows = sessions.map((s) => {
    const ago = relativeAge(s.time?.updated ?? 0, now)
    const dir = (s.directory ?? "").slice(0, 40)
    const title = (s.title ?? "").slice(0, 60)
    return `${s.id}  ${ago}  ${dir}  ${title}`.trimEnd()
  })
  return [header.join("  "), ...rows].join("\n")
}

/**
 * Build a `ToolDefinition` registered as `swarm_list`. The factory captures
 * the plugin's `serverUrl` and `internalFetch` (the runtime call needs no
 * routing info from the LLM beyond an optional `limit`).
 */
export function createSwarmListTool(
  serverUrl: string,
  fetchFn: typeof fetch,
): ToolDefinition {
  return tool({
    description:
      "List local opencode sessions across all projects (id, last-updated, " +
      "directory, title), most-recently-updated first. Use this to discover " +
      "the session id of a peer to message with swarm_send.",
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe("Max sessions to return (default 100)."),
    },
    async execute(args, ctx) {
      const sessions = await swarmList({
        serverUrl,
        fetchFn,
        limit: args.limit,
      })
      ctx.metadata({
        title: `swarm sessions (${sessions.length})`,
        metadata: { count: sessions.length },
      })
      return formatSessions(sessions, Date.now())
    },
  })
}

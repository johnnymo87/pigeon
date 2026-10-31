/**
 * swarm_list — opencode tool that lists local opencode sessions across all
 * projects, so an agent can discover the session ids of its peers (e.g. to
 * pick a `to` for swarm_send). This replaces the old `opencode-send --list`
 * CLI.
 *
 * With `remote: true` (pigeon-k0qn.9) it lists sessions on OTHER machines
 * instead, from the pigeon daemon's `GET /swarm/remote-sessions`, which
 * proxies the worker's registry. That output also says, per machine, whether
 * a cross-machine send could be relayed right now, because most of the time
 * (relay off, receiver not accepting) it cannot.
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
import { resolveServeAuthHeader } from "./serve-auth"
import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"

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

  const headers: Record<string, string> = {}
  const authHeader = resolveServeAuthHeader()
  if (authHeader) {
    headers["Authorization"] = authHeader
  }

  const res = await opts.fetchFn(
    new Request(url.toString(), { method: "GET", headers }),
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

/** The worker clamps `limit` to this (REMOTE_SESSIONS_MAX_LIMIT). */
export const REMOTE_LIMIT_MAX = 500

/** The daemon's `GET /swarm/remote-sessions` body. */
export interface RemoteSessionsListing {
  /** The machine this daemon runs on, as the worker resolved its credential. */
  machine_id: string
  sessions: Array<{ session_id: string; machine_id: string; label: string | null; updated_at: number }>
  /** Per listed machine: what POST /swarm/relay would answer for a send from this machine. */
  machines: Array<{ machine_id: string; relay: string; last_poll_at: number | null }>
  truncated: boolean
  /** Whether this machine's daemon relays at all (PIGEON_SWARM_RELAY_SEND=1). */
  relay_send: boolean
}

export interface SwarmListRemoteOptions {
  daemonBaseUrl: string
  fetchFn?: typeof fetch
  limit?: number
}

/** GET the daemon's /swarm/remote-sessions. Throws with status + body on any non-2xx. */
export async function swarmListRemote(opts: SwarmListRemoteOptions): Promise<RemoteSessionsListing> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/remote-sessions", opts.daemonBaseUrl)
  if (typeof opts.limit === "number") url.searchParams.set("limit", String(opts.limit))

  const send = () => {
    const token = resolveDaemonToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetchFn(url.toString(), { headers })
  }
  let res = await send()
  if (res.status === 401) {
    invalidateDaemonToken()
    res = await send()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`swarm_list remote failed: ${res.status} ${text}`)
  }
  return (await res.json()) as RemoteSessionsListing
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function explainRelay(
  status: string,
  machine: string,
  self: string,
  lastPollAt: number | null,
  now: number,
): string {
  switch (status) {
    case "available":
      return "available"
    case "not_accepted":
      return `not_accepted (${machine} does not accept relays from ${self})`
    case "not_retired":
      return `not_retired (${machine} still accepts the shared worker key, so it cannot receive relays)`
    case "offline": {
      if (lastPollAt === null) {
        return `offline (${machine} is not polling the worker; asleep or down)`
      }
      const ageMs = now - lastPollAt
      if (ageMs <= SEVEN_DAYS_MS) {
        return `offline (${machine} last polled ${relativeAge(lastPollAt, now)}; a message sent now is held up to 24h and delivered if it wakes in time)`
      }
      return `offline (${machine} has not polled for ${relativeAge(lastPollAt, now)}; sends are refused)`
    }
    case "unknown":
      return "unknown (the worker's relay schema is not applied)"
    default:
      return status
  }
}

/**
 * Render a remote listing: one row per session (id, age, machine, label), then
 * each machine's relay status, then a warning when this machine does not relay
 * at all, since that makes every row above unreachable by swarm_send.
 */
export function formatRemoteSessions(listing: RemoteSessionsListing, now: number): string {
  const self = listing.machine_id
  if (listing.sessions.length === 0) {
    return `No sessions on other machines were active in the last 7 days (asked from ${self}).`
  }
  // SEEN, not UPDATED: the worker row is also bumped by the owner's daily re-registration, so
  // it says the session is still held, not that it was recently active. The label is the
  // session's directory basename, JSON-quoted because it is free text written by another machine.
  const header = ["ID", "SEEN", "MACHINE", "LABEL"]
  const rows = listing.sessions.map((s) =>
    `${s.session_id}  ${relativeAge(s.updated_at, now)}  ${s.machine_id}  ${s.label ? JSON.stringify(s.label) : ""}`.trimEnd(),
  )
  const out = [`Sessions on machines other than ${self}:`, header.join("  "), ...rows]
  if (listing.truncated) {
    out.push(`(more sessions matched; pass a larger limit, up to ${REMOTE_LIMIT_MAX}, to see them)`)
  }
  out.push(
    "",
    `Relay from ${self} (what swarm_send to each machine would get now; "available" and "offline" ` +
      "(within 7 days) are queued by the worker, and the receiving session may still refuse it):",
  )
  for (const m of listing.machines) {
    out.push(`  ${m.machine_id}: ${explainRelay(m.relay, m.machine_id, self, m.last_poll_at, now)}`)
  }
  if (!listing.relay_send) {
    out.push(
      "",
      `WARNING: ${self} does not relay (PIGEON_SWARM_RELAY_SEND is not set on its daemon), ` +
        "so swarm_send to any session above fails with delivery.failed.",
    )
  }
  return out.join("\n")
}

export interface SwarmListRemoteConfig {
  daemonBaseUrl: string
  /** Defaults to global fetch: the daemon is a real HTTP server, unlike a TUI serve. */
  fetchFn?: typeof fetch
}

/**
 * Build a `ToolDefinition` registered as `swarm_list`. The factory captures
 * the plugin's `serverUrl` and `internalFetch` (the runtime call needs no
 * routing info from the LLM beyond an optional `limit`).
 */
export function createSwarmListTool(
  serverUrl: string,
  fetchFn: typeof fetch,
  remote?: SwarmListRemoteConfig,
): ToolDefinition {
  return tool({
    description:
      "List local opencode sessions across all projects (id, last-updated, " +
      "directory, title), most-recently-updated first. Use this to discover " +
      "the session id of a peer to message with swarm_send. With remote: true, " +
      "list sessions on OTHER machines instead (id, last-updated, machine, label), " +
      "and whether a swarm_send to each machine can be relayed right now.",
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe("Max sessions to return (default 100)."),
      remote: tool.schema
        .boolean()
        .optional()
        .describe(
          "List sessions on other machines (active in the last 7 days) instead of local ones.",
        ),
    },
    async execute(args, ctx) {
      if (args.remote === true) {
        if (!remote) throw new Error("swarm_list remote: no pigeon daemon is configured for this plugin")
        const listing = await swarmListRemote({
          daemonBaseUrl: remote.daemonBaseUrl,
          fetchFn: remote.fetchFn,
          limit: args.limit,
        })
        ctx.metadata({
          title: `remote swarm sessions (${listing.sessions.length})`,
          metadata: { count: listing.sessions.length, remote: true },
        })
        return formatRemoteSessions(listing, Date.now())
      }
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

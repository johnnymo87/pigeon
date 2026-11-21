/**
 * Slack workspace configuration (bead pigeon-4ogz.3; plan
 * docs/plans/2026-11-20-slack-outbound-plan.md, "Config").
 *
 * A machine is on Slack when a `SLACK_WORKSPACE_<MACHINE>` worker secret exists for it: the
 * machine id upper-cased with `-` mapped to `_`, holding one JSON object of the workspace's
 * ids and credentials. There is no other switch, so with no such secret every path behaves
 * exactly as it did before Slack existed.
 *
 * A secret that does not parse, or lacks a field, is treated as ABSENT (the machine has no
 * workspace) and logged. It must never throw: this runs on the request path of every
 * notification, and a typo in a secret should degrade one machine rather than turn every
 * request into a 500. The log names the key and never its value (the value holds tokens).
 */

/**
 * Slack handles (the integers that stand in for a conversation or a post in the daemon's
 * Telegram-shaped contract) start here. Telegram message-thread ids and message ids stay far
 * below 2^40, so a handle at or above it can only be a Slack one. The tables seed a row at
 * 2^40 - 1 so AUTOINCREMENT hands out values from 2^40 without writing `sqlite_sequence`.
 *
 * A NEGATIVE message id is never a handle: it is the placeholder for a post Slack accepted but D1
 * would not record, so it cannot be edited or replied to (it resolves as an unknown handle).
 */
export const SLACK_HANDLE_MIN = 2 ** 40;

export interface SlackWorkspace {
  teamId: string;
  appId: string;
  /** The workspace subdomain, e.g. `acme` (the part before the Slack host). */
  domain: string;
  botToken: string;
  /** A user token (xoxp), for the few calls a bot token cannot make (unarchive). */
  userToken: string;
  signingSecret: string;
  /** The human the bot invites into conversations and mentions when it must be heard. */
  ownerUserId: string;
}

const SECRET_PREFIX = "SLACK_WORKSPACE_";
const FIELDS = ["teamId", "appId", "domain", "botToken", "userToken", "signingSecret", "ownerUserId"] as const;

const SLACK_CHAT_PREFIX = "slack:";

/** Keys already reported broken in this isolate, so one bad secret logs once, not per request. */
const warned = new Set<string>();

/**
 * Parsed secrets by their raw string, per isolate. A request resolves a workspace several times
 * (the `SLACK_WORKSPACE_*` scan parses every secret), and the secrets never change within an
 * isolate, so the JSON is parsed once per distinct string. Failures are cached too (null), so a
 * broken secret is neither re-parsed nor re-logged. Keyed on the string, not the env key, so a
 * rotated secret misses the cache by construction. Bounded, since keys are secret values.
 */
const parsed = new Map<string, SlackWorkspace | null>();
const PARSED_MAX = 64;

/** Test seam: forget which keys were already reported, and every cached parse. */
export function clearSlackConfigWarnings(): void {
  warned.clear();
  parsed.clear();
}

function warnOnce(key: string, reason: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error("[worker] slack workspace secret ignored", { key, reason });
}

function parseWorkspace(key: string, raw: unknown): SlackWorkspace | null {
  if (typeof raw !== "string") return null;
  if (parsed.has(raw)) return parsed.get(raw) ?? null;
  const ws = parseWorkspaceUncached(key, raw);
  if (parsed.size >= PARSED_MAX) parsed.clear();
  parsed.set(raw, ws);
  return ws;
}

function parseWorkspaceUncached(key: string, raw: string): SlackWorkspace | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    warnOnce(key, "not valid JSON");
    return null;
  }
  if (typeof value !== "object" || value === null) {
    warnOnce(key, "not a JSON object");
    return null;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const v = obj[field];
    if (typeof v !== "string" || v === "") {
      warnOnce(key, `missing or empty field: ${field}`);
      return null;
    }
    out[field] = v;
  }
  return out as unknown as SlackWorkspace;
}

/** Secrets are read by name, so Env is viewed as a bag rather than widened with an index signature. */
function bag(env: Env): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

export function slackSecretKeyForMachine(machineId: string): string {
  return SECRET_PREFIX + machineId.toUpperCase().replace(/-/g, "_");
}

/** The workspace a machine posts into, or null when it has none (or its secret is broken). */
export function slackWorkspaceForMachine(env: Env, machineId: string): SlackWorkspace | null {
  const key = slackSecretKeyForMachine(machineId);
  return parseWorkspace(key, bag(env)[key]);
}

/**
 * The configured workspace with this team id, scanning every `SLACK_WORKSPACE_*` secret. Used
 * where only the address (`slack:<team>`) is known, such as a stored conversation's chat id.
 */
export function slackWorkspaceForTeam(env: Env, teamId: string): SlackWorkspace | null {
  const all = bag(env);
  for (const key of Object.keys(all)) {
    if (!key.startsWith(SECRET_PREFIX)) continue;
    const ws = parseWorkspace(key, all[key]);
    if (ws && ws.teamId === teamId) return ws;
  }
  return null;
}

/**
 * Every configured workspace, one per team id (two machines may share a workspace, and each
 * machine has its own secret). Order follows the env's key order; broken secrets are skipped.
 */
export function allSlackWorkspaces(env: Env): SlackWorkspace[] {
  const all = bag(env);
  const byTeam = new Map<string, SlackWorkspace>();
  for (const key of Object.keys(all)) {
    if (!key.startsWith(SECRET_PREFIX)) continue;
    const ws = parseWorkspace(key, all[key]);
    if (ws && !byTeam.has(ws.teamId)) byTeam.set(ws.teamId, ws);
  }
  return [...byTeam.values()];
}

/** True when the worker has at least one `SLACK_WORKSPACE_*` secret (valid or not): Slack is in play. */
export function hasSlackWorkspaceSecret(env: Env): boolean {
  return Object.keys(bag(env)).some((key) => key.startsWith(SECRET_PREFIX));
}

/** The chat address of a workspace; `isSlackChatId` in `./index` recognises it. */
export function slackChatId(ws: Pick<SlackWorkspace, "teamId">): string {
  return SLACK_CHAT_PREFIX + ws.teamId;
}

/** The team id inside a `slack:<team>` address, or null for anything else (Telegram ids). */
export function teamIdOfChat(chatId: string | number): string | null {
  if (typeof chatId !== "string" || !chatId.startsWith(SLACK_CHAT_PREFIX)) return null;
  const team = chatId.slice(SLACK_CHAT_PREFIX.length);
  return team === "" ? null : team;
}

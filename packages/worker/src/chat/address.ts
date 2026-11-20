/**
 * Which chat address a request acts on, and whether its principal may (bead pigeon-4ogz.3; plan
 * docs/plans/2026-11-20-slack-outbound-plan.md, "Address resolution and authorization").
 *
 * There are two families of route, and they resolve differently on purpose:
 *
 * - WORKER-RESOLVED sends (`/notifications/send`, `/topics/named`, `/topics/named/bind`): the
 *   daemon asks the worker to put something in a conversation the worker owns. A machine that is
 *   on Slack therefore always gets its own `slack:<team>`, whatever `chatId` the daemon sent: a
 *   daemon that has not yet learned it moved (a stale numeric chat id from its config) cannot pull
 *   its sessions back to Telegram. Every other principal keeps today's rule, the allowlist.
 *
 * - STORED addresses (`/messages/send`, `/topics/unpin`): the caller names a conversation that
 *   already exists (a command reply into the thread it was typed in), so it goes where it lives.
 *   A Slack conversation of another machine's team is reachable only by a machine that holds a
 *   command typed there; the shared key never reaches Slack.
 *
 * With no `SLACK_WORKSPACE_*` secret none of this changes anything: no principal is on Slack, no
 * `slack:` team is configured, and every function below falls through to the Telegram rule.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Principal } from "../credentials";
import { isAllowedChatId } from "../notifications";
import { isSlackChatId } from "./index";
import { SLACK_HANDLE_MIN, slackChatId, slackWorkspaceForMachine, slackWorkspaceForTeam, teamIdOfChat } from "./slack-config";
import type { SlackWorkspace } from "./slack-config";

/** The workspace a machine principal posts into, or null (shared key, or a Telegram machine). */
export function machineSlackWorkspace(env: Env, principal: Principal): SlackWorkspace | null {
  return principal.kind === "machine" ? slackWorkspaceForMachine(env, principal.machineId) : null;
}

export type WorkerTarget =
  | {
      ok: true;
      /** The address to act on. For Telegram, exactly what the caller sent (not coerced). */
      chatId: string | number;
      slack: boolean;
    }
  | { ok: false };

/**
 * The target chat of a worker-resolved send. `ok: false` means "refuse with 403": no chat id, one
 * that is not allowlisted, or a `slack:` address from a principal that is not on Slack. The caller
 * chooses the response, because each route has its own order of checks and body.
 */
export function resolveWorkerTarget(
  env: Env,
  principal: Principal,
  requestedChatId: string | number | null | undefined,
): WorkerTarget {
  const ws = machineSlackWorkspace(env, principal);
  if (ws) return { ok: true, chatId: slackChatId(ws), slack: true };

  if (requestedChatId === undefined || requestedChatId === null || requestedChatId === "") return { ok: false };
  if (isSlackChatId(requestedChatId)) return { ok: false };
  if (!isAllowedChatId(requestedChatId, env)) return { ok: false };
  return { ok: true, chatId: requestedChatId, slack: false };
}

const refuse = () => ({
  ok: false as const,
  response: Response.json({ error: "chat_not_allowed" }, { status: 403 }),
});

export type StoredAddress =
  | {
      ok: true;
      /** The address to act on: `slack:<team>` for Slack, the caller's numeric id otherwise. */
      chatId: string;
      /** The thread/handle to act in. Undefined on Slack means that workspace's `#alerts`. */
      threadId: number | undefined;
      slack: boolean;
      /** The Slack address was derived from a numeric one (so the response must say where it went). */
      rerouted: boolean;
    }
  | { ok: false; response: Response };

async function holdsCommandIn(
  db: D1Database,
  machineId: string,
  chatId: string,
  threadId: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM commands WHERE chat_id = ? AND message_thread_id = ? AND machine_id = ? LIMIT 1")
    .bind(chatId, threadId, machineId)
    .first<{ one: number }>();
  return row !== null;
}

/**
 * Authorize and resolve the address of a session-free send. Failures are the route's existing 403
 * `{error: "chat_not_allowed"}`.
 *
 * - `slack:<T>`: the shared principal is refused. A machine on team T is allowed. Any other
 *   principal needs the team to be configured AND a thread AND a `commands` row for that
 *   `(chat_id, message_thread_id)` addressed to its own machine id, i.e. it was handed a command
 *   typed in that very conversation.
 * - numeric, from a machine on Slack: with no thread it means that machine's `#alerts` (the
 *   daemon's old numeric `chatId` is not Telegram any more); with a Slack handle (>= 2^40) it is
 *   that conversation in its own workspace, which is what a daemon that dropped the `chatId` the
 *   worker returned to it sends. A smaller thread id is a Telegram thread and takes the Telegram
 *   path below.
 * - everything else is Telegram, under `ALLOWED_CHAT_IDS`, exactly as before.
 */
export async function authorizeStoredAddress(
  env: Env,
  db: D1Database,
  principal: Principal,
  chatId: string,
  threadId: number | undefined,
): Promise<StoredAddress> {
  const team = teamIdOfChat(chatId);
  if (team !== null) {
    if (principal.kind !== "machine") return refuse();
    if (!slackWorkspaceForTeam(env, team)) return refuse();
    const own = machineSlackWorkspace(env, principal);
    if (own && own.teamId === team) return { ok: true, chatId, threadId, slack: true, rerouted: false };
    if (threadId === undefined) return refuse();
    if (!(await holdsCommandIn(db, principal.machineId, chatId, threadId))) return refuse();
    return { ok: true, chatId, threadId, slack: true, rerouted: false };
  }
  if (isSlackChatId(chatId)) return refuse(); // `slack:` with no team id

  const own = machineSlackWorkspace(env, principal);
  if (own && (threadId === undefined || threadId >= SLACK_HANDLE_MIN)) {
    return { ok: true, chatId: slackChatId(own), threadId, slack: true, rerouted: true };
  }

  if (!isAllowedChatId(chatId, env)) return refuse();
  return { ok: true, chatId, threadId, slack: false, rerouted: false };
}

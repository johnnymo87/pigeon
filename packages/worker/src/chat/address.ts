/**
 * Which chat address a request acts on, and whether its principal may (bead pigeon-4ogz.3; plan
 * docs/plans/2026-11-20-slack-outbound-plan.md, "Address resolution and authorization").
 *
 * There are two families of route, and they resolve differently on purpose:
 *
 * - WORKER-RESOLVED sends (`/notifications/send`, `/topics/named`, `/topics/named/bind`): the
 *   daemon asks the worker to put something in a conversation the worker owns. A machine that is
 *   on Slack therefore always gets its own `slack:<team>`, whatever `chatId` the daemon sent (a
 *   daemon that has not yet learned that Telegram is gone sends a stale numeric one). Every other
 *   principal (the shared key, a machine with no workspace) has no target.
 *
 * - STORED addresses (`/messages/send`): the caller names a conversation that already exists (a
 *   command reply into the thread it was typed in), so it goes where it lives. A Slack
 *   conversation of another machine's team is reachable only by a machine that holds a command
 *   typed there; the shared key never reaches Slack.
 *
 * Slack is the only transport: a numeric chat id is accepted from a machine on Slack for backward
 * compatibility and mapped onto that machine's workspace; nothing else resolves.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Principal } from "../credentials";
import { isSlackChatId } from "./index";
import { SLACK_HANDLE_MIN, slackChatId, slackWorkspaceForMachine, slackWorkspaceForTeam, teamIdOfChat } from "./slack-config";
import type { SlackWorkspace } from "./slack-config";

/** The workspace a machine principal posts into, or null (shared key, or a machine with no workspace). */
export function machineSlackWorkspace(env: Env, principal: Principal): SlackWorkspace | null {
  return principal.kind === "machine" ? slackWorkspaceForMachine(env, principal.machineId) : null;
}

export type WorkerTarget =
  | {
      ok: true;
      /** The address to act on: the machine's `slack:<team>`. */
      chatId: string;
      slack: true;
    }
  | { ok: false };

/**
 * The target chat of a worker-resolved send. `ok: false` means the principal has no target: the
 * shared key, or a machine with no Slack workspace. The caller chooses the response, because each
 * route has its own order of checks and body. The requested chat id is ignored: a machine's target
 * is its own workspace.
 */
export function resolveWorkerTarget(env: Env, principal: Principal): WorkerTarget {
  const ws = machineSlackWorkspace(env, principal);
  if (ws) return { ok: true, chatId: slackChatId(ws), slack: true };
  return { ok: false };
}

const refuse = () => ({
  ok: false as const,
  response: Response.json({ error: "chat_not_allowed" }, { status: 403 }),
});

export type StoredAddress =
  | {
      ok: true;
      /** The address to act on: `slack:<team>`. */
      chatId: string;
      /** The thread/handle to act in. Undefined means that workspace's `#alerts`. */
      threadId: number | undefined;
      slack: true;
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
 * - a missing `chatId` (the caller is a machine on Slack that dropped it): that machine's
 *   workspace, in the handle it names, or its `#alerts`.
 * - numeric, from a machine on Slack: with no thread it means that machine's `#alerts` (the
 *   daemon's old numeric `chatId` is not a chat any more); with a Slack handle (>= 2^40) it is
 *   that conversation in its own workspace. A smaller thread id was a Telegram thread and has
 *   nowhere to go: refused.
 * - everything else (the shared key, a machine with no workspace): refused.
 */
export async function authorizeStoredAddress(
  env: Env,
  db: D1Database,
  principal: Principal,
  chatId: string | null,
  threadId: number | undefined,
): Promise<StoredAddress> {
  if (chatId === null) {
    const own = machineSlackWorkspace(env, principal);
    if (!own || (threadId !== undefined && threadId < SLACK_HANDLE_MIN)) return refuse();
    return { ok: true, chatId: slackChatId(own), threadId, slack: true };
  }
  const team = teamIdOfChat(chatId);
  if (team !== null) {
    if (principal.kind !== "machine") return refuse();
    if (!slackWorkspaceForTeam(env, team)) return refuse();
    const own = machineSlackWorkspace(env, principal);
    if (own && own.teamId === team) return { ok: true, chatId, threadId, slack: true };
    if (threadId === undefined) return refuse();
    if (!(await holdsCommandIn(db, principal.machineId, chatId, threadId))) return refuse();
    return { ok: true, chatId, threadId, slack: true };
  }
  if (isSlackChatId(chatId)) return refuse(); // `slack:` with no team id

  const own = machineSlackWorkspace(env, principal);
  if (own && (threadId === undefined || threadId >= SLACK_HANDLE_MIN)) {
    return { ok: true, chatId: slackChatId(own), threadId, slack: true };
  }
  return refuse();
}

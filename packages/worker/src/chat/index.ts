/**
 * Picking a ChatTransport by address (spec §1, "A stored conversation goes where it lives").
 * See `./transport.ts` for the interface and why it is Telegram-shaped.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { parseNotifyCategories } from "./slack-notify";
import { slackWorkspaceForTeam, teamIdOfChat } from "./slack-config";
import { createSlackTransport } from "./slack-transport";
import type { ChatResult, ChatTransport } from "./transport";

export type { ChatResult, ChatTransport } from "./transport";

/** Slack workspace chat ids are `slack:<teamId>`. Anything else is a numeric Telegram-era id. */
export const SLACK_CHAT_PREFIX = "slack:";

export function isSlackChatId(chatId: string | number): boolean {
  return typeof chatId === "string" && chatId.startsWith(SLACK_CHAT_PREFIX);
}

/**
 * The failure every call to a Slack address gets when no Slack transport can be built for it: the
 * caller passed no env/db, or no `SLACK_WORKSPACE_*` secret is configured for the address's team
 * (the secret was deleted, or never existed). It is a guard, not a path: it makes sure a Slack
 * address is never answered as if it were a refusal. It is classified transient (no 4xx code), so
 * a caller holds and retries rather than relocating to #alerts.
 */
function slackUnavailable<T>(method: string): Promise<ChatResult<T>> {
  console.warn("[worker] slack transport not available", { method });
  return Promise.resolve({ ok: false, kind: "error", description: "slack transport not available" });
}

const SLACK_UNAVAILABLE: ChatTransport = {
  sendMessage: () => slackUnavailable("sendMessage"),
  sendRichMessage: () => slackUnavailable("sendRichMessage"),
  editMessageText: () => slackUnavailable("editMessageText"),
  sendPhoto: () => slackUnavailable("sendPhoto"),
  sendDocument: () => slackUnavailable("sendDocument"),
  createForumTopic: () => slackUnavailable("createForumTopic"),
  editForumTopic: () => slackUnavailable("editForumTopic"),
  closeForumTopic: () => slackUnavailable("closeForumTopic"),
  reopenForumTopic: () => slackUnavailable("reopenForumTopic"),
  deleteForumTopic: () => slackUnavailable("deleteForumTopic"),
};

/**
 * The failure every call to a non-Slack address gets (a numeric chat id: the Telegram days are
 * over, so no provider can take it). Unlike `SLACK_UNAVAILABLE` it is permanent, and it is
 * distinct on purpose: `no_transport` never reaches a response body (see `ChatResult`), each
 * caller maps it to its own answer.
 */
function noTransport<T>(method: string): Promise<ChatResult<T>> {
  console.warn("[worker] no transport for address", { method });
  return Promise.resolve({ ok: false, kind: "no_transport" });
}

const NO_TRANSPORT: ChatTransport = {
  sendMessage: () => noTransport("sendMessage"),
  sendRichMessage: () => noTransport("sendRichMessage"),
  editMessageText: () => noTransport("editMessageText"),
  sendPhoto: () => noTransport("sendPhoto"),
  sendDocument: () => noTransport("sendDocument"),
  createForumTopic: () => noTransport("createForumTopic"),
  editForumTopic: () => noTransport("editForumTopic"),
  closeForumTopic: () => noTransport("closeForumTopic"),
  reopenForumTopic: () => noTransport("reopenForumTopic"),
  deleteForumTopic: () => noTransport("deleteForumTopic"),
};

/** What a Slack address needs beyond the address itself: the workspace secrets and the handle tables. */
export interface SlackContext {
  env: Env;
  db: D1Database;
  /** Replaces the global `fetch` for Slack calls (tests). */
  fetchFn?: typeof fetch;
}

/**
 * The transport for a chat address.
 *
 * `transport` replaces whatever the address would pick (tests inject fakes this way, through the
 * `transport` options of the topic modules), for any address. A `slack:<team>` address with a
 * configured workspace gets the Slack transport; without `ctx`, or with no workspace for the team,
 * it gets the `SLACK_UNAVAILABLE` guard (transient). Any other address gets `NO_TRANSPORT`.
 */
export function transportForChat(
  chatId: string | number,
  ctx?: SlackContext,
  transport?: ChatTransport,
): ChatTransport {
  if (transport) return transport;
  if (!isSlackChatId(chatId)) return NO_TRANSPORT;
  const team = teamIdOfChat(chatId);
  const ws = ctx && team ? slackWorkspaceForTeam(ctx.env, team) : null;
  if (ctx && ws) {
    return createSlackTransport({
      db: ctx.db,
      ws,
      notifyCategories: parseNotifyCategories(ctx.env.SLACK_NOTIFY_OWNER),
      ...(ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {}),
    });
  }
  return SLACK_UNAVAILABLE;
}

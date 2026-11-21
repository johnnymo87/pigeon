/**
 * Picking a ChatTransport by address (spec §1, "A stored conversation goes where it lives").
 * See `./transport.ts` for the interface and why it is Telegram-shaped.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { createTelegramClient } from "../telegram";
import { parseNotifyCategories } from "./slack-notify";
import { slackWorkspaceForTeam, teamIdOfChat } from "./slack-config";
import { createSlackTransport } from "./slack-transport";
import type { ChatResult, ChatTransport } from "./transport";

export type { ChatResult, ChatTransport } from "./transport";

/** Slack workspace chat ids are `slack:<teamId>`; Telegram chat ids are numeric. */
export const SLACK_CHAT_PREFIX = "slack:";

export function isSlackChatId(chatId: string | number): boolean {
  return typeof chatId === "string" && chatId.startsWith(SLACK_CHAT_PREFIX);
}

/**
 * The failure every call to a Slack address gets when no Slack transport can be built for it: the
 * caller passed no env/db, or no `SLACK_WORKSPACE_*` secret is configured for the address's team
 * (the secret was deleted, or never existed). It is a guard, not a path: it makes sure a Slack
 * address can never be handed to the Telegram Bot API. It is classified transient (no 4xx code),
 * so a caller holds and retries rather than relocating to General.
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
  unpinAllForumTopicMessages: () => slackUnavailable("unpinAllForumTopicMessages"),
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
 * `transport` options of the topic modules), for a Slack address as much as a numeric one. `slack`
 * is what a Slack address needs: without it, or when no workspace is configured for the address's
 * team, the address gets the `SLACK_UNAVAILABLE` guard. A numeric address ignores it, so with no
 * Slack secret every call behaves exactly as before Slack existed.
 */
export function transportForChat(
  chatId: string | number,
  botToken: string,
  transport?: ChatTransport,
  slack?: SlackContext,
): ChatTransport {
  if (transport) return transport;
  if (isSlackChatId(chatId)) {
    const team = teamIdOfChat(chatId);
    const ws = slack && team ? slackWorkspaceForTeam(slack.env, team) : null;
    if (slack && ws) {
      return createSlackTransport({
        db: slack.db,
        ws,
        notifyCategories: parseNotifyCategories(slack.env.SLACK_NOTIFY_OWNER),
        ...(slack.fetchFn ? { fetchFn: slack.fetchFn } : {}),
      });
    }
    return SLACK_UNAVAILABLE;
  }
  return createTelegramClient(botToken);
}

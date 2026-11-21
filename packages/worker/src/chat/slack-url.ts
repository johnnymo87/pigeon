/**
 * The link to a stored Slack conversation (bead pigeon-4ogz.3): the per-transport half of "jump to
 * this session's thread". It needs the channel id behind the handle (`slack_conversations`) and the workspace's domain (its secret).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { slackArchiveUrl } from "../slack";
import { slackWorkspaceForTeam, teamIdOfChat } from "./slack-config";

/**
 * The conversation permalink (`slackArchiveUrl`) for a `slack:<team>` row with a handle, or
 * null when it cannot be built: not a Slack address, no handle, no workspace configured for the
 * team (secret deleted), or a handle with no conversation. A D1 error propagates: callers that
 * decorate (mention buttons) catch it, and the lookup route answers 503 as for its own query.
 */
export async function slackConversationUrl(
  db: D1Database,
  env: Env,
  chatId: string,
  handle: number | null,
): Promise<string | null> {
  const team = teamIdOfChat(chatId);
  if (team === null || typeof handle !== "number" || !Number.isInteger(handle) || handle <= 0) return null;
  const ws = slackWorkspaceForTeam(env, team);
  if (!ws) return null;
  const row = await db
    .prepare("SELECT channel_id FROM slack_conversations WHERE handle = ? AND team_id = ?")
    .bind(handle, team)
    .first<{ channel_id: string }>();
  return row?.channel_id ? slackArchiveUrl(ws.domain, row.channel_id) : null;
}

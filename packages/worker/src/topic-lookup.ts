import { verifyApiKey, unauthorized } from "./auth";
import { withD1, StorageError } from "./d1";

/**
 * Upper bound on one lookup batch. Keeps the `IN (...)` well under D1's bound-parameter
 * limit, and is far above what any caller needs: the only caller (the daemon's `/alert`
 * link buttons) caps itself at a handful of sessions.
 */
export const MAX_TOPIC_LOOKUP_IDS = 50;

export interface TopicLookupEntry {
  chatId: string;
  messageThreadId: number | null;
  state: "open" | "closed";
}

/**
 * POST /topics/lookup  {sessionIds: string[]}
 *   -> 200 {topics: {[sessionId]: TopicLookupEntry | null}}
 *
 * A read-only view of the `topics` table, so a machine can render a link to a session's
 * forum topic without the worker having to know what the link is for. `null` means the
 * session has no topic row at all — topics are created lazily on a session's first threaded
 * notification, so a quiet or never-notified session legitimately has none.
 *
 * Rows are returned as stored, including a reserved row (`messageThreadId: null`) and a
 * closed one: deciding what is linkable is the caller's policy, not this route's.
 */
export async function handleTopicLookup(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const raw = (body as { sessionIds?: unknown } | null)?.sessionIds;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_TOPIC_LOOKUP_IDS ||
    !raw.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return Response.json(
      { error: `sessionIds must be an array of 0-${MAX_TOPIC_LOOKUP_IDS} non-empty strings` },
      { status: 400 },
    );
  }

  const ids = [...new Set(raw as string[])];
  const topics: Record<string, TopicLookupEntry | null> = {};
  for (const id of ids) topics[id] = null;
  if (ids.length === 0) return Response.json({ topics });

  try {
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await withD1(
      "topics.lookup",
      db
        .prepare(
          `SELECT session_id, chat_id, message_thread_id, state FROM topics WHERE session_id IN (${placeholders})`,
        )
        .bind(...ids)
        .all<{ session_id: string; chat_id: string; message_thread_id: number | null; state: "open" | "closed" }>(),
    );
    for (const row of results) {
      topics[row.session_id] = {
        chatId: row.chat_id,
        messageThreadId: row.message_thread_id,
        state: row.state,
      };
    }
  } catch (err) {
    if (err instanceof StorageError) {
      return Response.json({ error: "storage unavailable" }, { status: 503 });
    }
    throw err;
  }

  return Response.json({ topics });
}

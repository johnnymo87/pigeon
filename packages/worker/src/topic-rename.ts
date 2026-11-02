import { unauthorized } from "./auth";
import { authenticate, checkActsAs } from "./credentials";
import { withD1, StorageError } from "./d1";
import { createTelegramClient, getTelegramErrorDetails } from "./telegram";
import {
  getBySession,
  isPlaceholderTitle,
  rename as renameTopic,
  topicName,
  topicsEnabled,
  type TopicRow,
} from "./topics";

export async function editTopicName(
  db: D1Database,
  env: Env,
  topic: TopicRow,
  name: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (topic.message_thread_id === null) {
    return { ok: false, error: "topic has no message thread" };
  }

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const editRes = await tg.editForumTopic({
    chatId: topic.chat_id,
    messageThreadId: topic.message_thread_id,
    name,
  });

  // TOPIC_NOT_MODIFIED means Telegram's name already equals the requested one, so the
  // rename is effectively done — treat it as success and fall through to the D1 writes.
  // This matches the reopen path (topic-manager.ts:77) and matters for two reasons:
  // repeating /rename with the same title must not report a failure, and because the
  // Telegram edit deliberately precedes the D1 writes, a crash in between leaves D1
  // stale — re-issuing the command is the repair, and it only converges if this is
  // not treated as an error.
  if (!editRes.ok && editRes.kind !== "topic_not_modified") {
    return { ok: false, error: getTelegramErrorDetails(editRes) };
  }

  await withD1("topics.rename", renameTopic(db, { sessionId: topic.session_id, name }));
  return { ok: true };
}

export async function handleTopicRename(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { sessionId, title, dir } = body as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    typeof dir !== "string"
  ) {
    return Response.json(
      { error: "sessionId and title must be non-empty strings, dir must be a string" },
      { status: 400 },
    );
  }

  if (isPlaceholderTitle(title)) {
    return Response.json({ error: "placeholder_title" }, { status: 400 });
  }

  try {
    const session = await withD1(
      "topicRename.getSession",
      db
        .prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first<{ machine_id: string }>(),
    );
    if (!session) {
      return Response.json({ error: "unknown_session" }, { status: 404 });
    }

    const actsAsError = checkActsAs(principal, env, session.machine_id);
    if (actsAsError) {
      return actsAsError;
    }

    let bound: unknown = null;
    try {
      bound = await withD1(
        "topicRename.checkBinding",
        db
          .prepare("SELECT 1 FROM named_topic_bindings WHERE session_id = ?")
          .bind(sessionId)
          .first(),
      );
    } catch (err) {
      if (err instanceof StorageError && /no such table: named_topic_bindings/i.test(String(err.cause))) {
        bound = null;
      } else {
        throw err;
      }
    }
    if (bound) {
      return Response.json({ error: "bound_session" }, { status: 409 });
    }

    if (!topicsEnabled(env)) {
      return Response.json({ renamed: false, reason: "topics_disabled" });
    }

    const topic = await withD1(
      "topicRename.getTopic",
      getBySession(db, sessionId),
    );
    if (!topic || topic.message_thread_id === null) {
      return Response.json({ renamed: false, reason: "no_topic" });
    }

    const name = topicName(dir, title);
    const editRes = await editTopicName(db, env, topic, name);
    if (!editRes.ok) {
      return Response.json({ error: "telegram_failed", detail: editRes.error }, { status: 502 });
    }

    return Response.json({ renamed: true, name });
  } catch (err) {
    if (err instanceof StorageError) {
      return Response.json({ error: "storage unavailable" }, { status: 503 });
    }
    throw err;
  }
}

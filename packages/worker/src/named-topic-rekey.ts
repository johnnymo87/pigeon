/**
 * POST /topics/named/rekey: move a named topic's key and rename its Slack channel in place.
 *
 * stall-watch is renaming a program (its tag). A program's Slack channel is a pigeon "named topic"
 * keyed `stallwatch:<tag>` (D1 tables `named_topics` and `named_topic_bindings`). There is no way
 * to change a named topic's key: posting under the new key would create a fresh channel and lose
 * history. This route moves the key and renames the Slack channel in place.
 *
 * Only this one chat (the caller machine's workspace) is touched; rows for the same key in other
 * chats are left alone.
 *
 *   {fromKey, toKey, name, dryRun?}
 *   200 {chatId, messageThreadId, renamed: true, boundSession} (success)
 *   200 {chatId, dryRun: true, from: {...}|null, to: {...}|null} (dryRun)
 *   200 {chatId, messageThreadId, renamed: false, already: true} (idempotent retry)
 *   400 bad input
 *   401 unauthorized
 *   403 Chat ID not allowed
 *   404 {error: "no_such_topic"}
 *   409 {error: "target_exists", messageThreadId}
 *   429 {error: "rate_limited", retryAfter}
 *   502 {error: "rename_failed", details}
 */

import type { D1Database } from "@cloudflare/workers-types";
import { unauthorized } from "./auth";
import { authenticate } from "./credentials";
import { resolveWorkerTarget } from "./chat/address";
import { failureDetails } from "./chat/failures";
import { transportForChat, type ChatTransport } from "./chat";
import {
  getNamedTopic,
  isMissingBindingsTable,
  NAMED_TOPIC_KEY_RE,
  truncateName,
} from "./named-topics";

export interface RekeyTopicDetails {
  messageThreadId: number;
  name: string;
  boundSession: string | null;
}

export async function getBoundSessionForKey(
  db: D1Database,
  chatId: string,
  key: string,
): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT session_id FROM named_topic_bindings WHERE chat_id = ? AND topic_key = ?")
      .bind(chatId, key)
      .first<{ session_id: string }>();
    return row?.session_id ?? null;
  } catch (err) {
    if (!isMissingBindingsTable(err)) throw err;
    console.warn("[worker] getBoundSessionForKey: named_topic_bindings is missing (schema not applied?); treating as unbound");
    return null;
  }
}

export async function handleNamedTopicRekey(
  db: D1Database,
  env: Env,
  request: Request,
  optsOrTransport?: ChatTransport | { transport?: ChatTransport; now?: number },
): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const fromKey = typeof body.fromKey === "string" ? body.fromKey : "";
  const toKey = typeof body.toKey === "string" ? body.toKey : "";
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const dryRun = body.dryRun === true;

  if (!NAMED_TOPIC_KEY_RE.test(fromKey) || !NAMED_TOPIC_KEY_RE.test(toKey)) {
    return Response.json({ error: "valid fromKey and toKey are required" }, { status: 400 });
  }
  if (fromKey.startsWith("_") || toKey.startsWith("_")) {
    return Response.json({ error: "keys starting with _ are reserved" }, { status: 400 });
  }
  if (fromKey === toKey) {
    return Response.json({ error: "fromKey and toKey must be different" }, { status: 400 });
  }
  if (!rawName) {
    return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
  }

  const target = resolveWorkerTarget(env, principal);
  if (!target.ok) {
    return Response.json({ error: "Chat ID not allowed" }, { status: 403 });
  }
  const chatId = target.chatId;

  const name = truncateName(rawName);
  const from = await getNamedTopic(db, chatId, fromKey);
  const to = await getNamedTopic(db, chatId, toKey);
  const fromBoundSession = await getBoundSessionForKey(db, chatId, fromKey);
  const toBoundSession = await getBoundSessionForKey(db, chatId, toKey);

  if (dryRun) {
    return Response.json({
      chatId,
      dryRun: true,
      from: from
        ? {
            messageThreadId: from.message_thread_id,
            name: from.name,
            boundSession: fromBoundSession,
          }
        : null,
      to: to
        ? {
            messageThreadId: to.message_thread_id,
            name: to.name,
            boundSession: toBoundSession,
          }
        : null,
    });
  }

  if (!from && to) {
    return Response.json({
      chatId,
      messageThreadId: to.message_thread_id,
      renamed: false,
      already: true,
    });
  }

  if (!from && !to) {
    return Response.json({ error: "no_such_topic" }, { status: 404 });
  }

  if (from && to) {
    return Response.json(
      { error: "target_exists", messageThreadId: to.message_thread_id },
      { status: 409 },
    );
  }

  // Otherwise: from is non-null and to is null
  const opts =
    optsOrTransport && "sendMessage" in optsOrTransport
      ? { transport: optsOrTransport }
      : (optsOrTransport ?? {});

  const chat = transportForChat(chatId, { env, db }, opts.transport);
  const res = await chat.renameConversation({
    chatId,
    messageThreadId: from!.message_thread_id,
    name,
    channelKey: toKey,
  });

  if (!res.ok && res.kind !== "topic_not_modified") {
    if (res.kind === "rate_limited") {
      return Response.json({ error: "rate_limited", retryAfter: res.retryAfter }, { status: 429 });
    }
    return Response.json({ error: "rename_failed", details: failureDetails(res) }, { status: 502 });
  }

  const now = opts.now ?? Date.now();
  await db.batch([
    db
      .prepare(
        "UPDATE named_topics SET topic_key = ?, name = ?, updated_at = ? WHERE chat_id = ? AND topic_key = ?",
      )
      .bind(toKey, name, now, chatId, fromKey),
    db
      .prepare(
        "UPDATE named_topic_bindings SET topic_key = ? WHERE chat_id = ? AND topic_key = ?",
      )
      .bind(toKey, chatId, fromKey),
  ]);

  return Response.json({
    chatId,
    messageThreadId: from!.message_thread_id,
    renamed: true,
    boundSession: fromBoundSession,
  });
}

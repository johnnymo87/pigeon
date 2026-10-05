/**
 * Named forum topics: caller-keyed topics that belong to no session.
 *
 * A `POST /alert` caller (a digest, a watcher) can ask for its alerts to land in a topic of its
 * own, identified by a stable key it chooses, instead of in General. The worker owns the
 * key -> thread mapping because it already owns topic creation; the daemon only resolves a key
 * here and then sends the alert itself.
 *
 * Deliberately a SEPARATE table from `topics`, not rows in it with a non-session key:
 * everything that reads `topics` is session-shaped. The orphan-closer selects open topics whose
 * session row is absent, the reaper deletes closed ones 30 days later, and inbound routing treats
 * a topic row as "messages here go to that session". A named topic has no session by design, so
 * in `topics` it would be closed after 7 days, later deleted, and its messages routed as
 * prompts to a session that does not exist. Keeping it out of that table exempts it from all
 * three without a single special case in their queries.
 */

import { verifyApiKey, unauthorized } from "./auth";
import { isAllowedChatId } from "./notifications";
import { topicsEnabled } from "./topics";
import { createTelegramClient, getTelegramErrorDetails, type TelegramClient } from "./telegram";

/** Caller-chosen key. Validated on both sides of the wire (daemon and here). */
export const NAMED_TOPIC_KEY_RE = /^[A-Za-z0-9:._-]{1,64}$/;

/** Telegram's limit on a forum topic name. */
export const MAX_TOPIC_NAME_CHARS = 128;

/** How often an existing named topic is re-opened, at most. A closed topic still accepts posts. */
export const REOPEN_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** At most one "this is a digest topic" hint per topic in this window. */
export const NAMED_TOPIC_HINT_INTERVAL_MS = 10 * 60 * 1000;

export const NAMED_TOPIC_HINT_TEXT =
  "This is a digest topic, and no session reads messages typed here. " +
  "Tap a button on a digest message to open a session's topic, and answer there.";

export interface NamedTopicRow {
  chat_id: string;
  topic_key: string;
  message_thread_id: number;
  name: string;
  reopen_checked_at: number | null;
  hint_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function getNamedTopic(
  db: D1Database,
  chatId: string,
  key: string,
): Promise<NamedTopicRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM named_topics WHERE chat_id = ? AND topic_key = ?")
      .bind(chatId, key)
      .first<NamedTopicRow>()) ?? null
  );
}

export async function getNamedTopicByThread(
  db: D1Database,
  chatId: string,
  messageThreadId: number,
): Promise<NamedTopicRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM named_topics WHERE chat_id = ? AND message_thread_id = ?")
      .bind(chatId, messageThreadId)
      .first<NamedTopicRow>()) ?? null
  );
}

function truncateName(name: string): string {
  const chars = [...name];
  return chars.length <= MAX_TOPIC_NAME_CHARS ? name : chars.slice(0, MAX_TOPIC_NAME_CHARS).join("");
}

export type ResolveNamedTopicResult =
  | { ok: true; messageThreadId: number; created: boolean }
  | { ok: false; kind: "rate_limited"; retryAfter: number }
  | { ok: false; kind: "create_failed"; details?: unknown };

/**
 * Find-or-create the topic for `(chatId, key)`.
 *
 * `staleThreadId` is the daemon reporting that a send into that thread failed with
 * "thread not found" (the topic was deleted out of band). The row is dropped — only if it
 * still points at that thread, so a concurrent recreate is not undone — and a new topic made.
 *
 * Creation is not reserved first. Two concurrent first-sends for one key would both create a
 * topic; the INSERT OR IGNORE picks one winner and the loser deletes its own. Callers of this
 * route post sequentially, so that path is a correctness backstop rather than a hot one.
 */
export async function resolveNamedTopic(
  db: D1Database,
  opts: {
    chatId: string;
    key: string;
    name: string;
    staleThreadId?: number;
    botToken: string;
    now?: number;
    tgClient?: TelegramClient;
  },
): Promise<ResolveNamedTopicResult> {
  const now = opts.now ?? Date.now();
  const tg = opts.tgClient ?? createTelegramClient(opts.botToken);

  let row = await getNamedTopic(db, opts.chatId, opts.key);

  if (row && opts.staleThreadId !== undefined && row.message_thread_id === opts.staleThreadId) {
    await db
      .prepare("DELETE FROM named_topics WHERE chat_id = ? AND topic_key = ? AND message_thread_id = ?")
      .bind(opts.chatId, opts.key, opts.staleThreadId)
      .run();
    row = null;
  }

  if (row) {
    if (row.reopen_checked_at === null || now - row.reopen_checked_at >= REOPEN_CHECK_INTERVAL_MS) {
      const res = await tg.reopenForumTopic({ chatId: opts.chatId, messageThreadId: row.message_thread_id });
      if (!res.ok && res.kind === "thread_not_found") {
        await db
          .prepare("DELETE FROM named_topics WHERE chat_id = ? AND topic_key = ? AND message_thread_id = ?")
          .bind(opts.chatId, opts.key, row.message_thread_id)
          .run();
        row = null;
      } else {
        // ok (was closed, now open) and TOPIC_NOT_MODIFIED (already open) both mean the
        // desired state holds. Any other failure is left for the next check: an admin bot can
        // post into a closed topic, so delivery does not depend on this succeeding.
        if (res.ok || res.kind === "topic_not_modified") {
          await db
            .prepare("UPDATE named_topics SET reopen_checked_at = ?, updated_at = ? WHERE chat_id = ? AND topic_key = ?")
            .bind(now, now, opts.chatId, opts.key)
            .run();
        }
      }
    }
    if (row) return { ok: true, messageThreadId: row.message_thread_id, created: false };
  }

  const name = truncateName(opts.name.trim() || opts.key);
  const created = await tg.createForumTopic({ chatId: opts.chatId, name });
  if (!created.ok) {
    if (created.kind === "rate_limited") {
      return { ok: false, kind: "rate_limited", retryAfter: created.retryAfter };
    }
    console.warn("[worker] named topic creation failed", {
      key: opts.key,
      details: getTelegramErrorDetails(created),
    });
    return { ok: false, kind: "create_failed", details: getTelegramErrorDetails(created) };
  }

  const threadId = created.result.message_thread_id;
  await db
    .prepare(
      `INSERT OR IGNORE INTO named_topics
         (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(opts.chatId, opts.key, threadId, name, now, now, now)
    .run();

  const winner = await getNamedTopic(db, opts.chatId, opts.key);
  if (winner && winner.message_thread_id !== threadId) {
    // Lost a concurrent create. Remove our duplicate; best-effort.
    try {
      await tg.deleteForumTopic({ chatId: opts.chatId, messageThreadId: threadId });
    } catch {
      // ignore
    }
    return { ok: true, messageThreadId: winner.message_thread_id, created: false };
  }
  return { ok: true, messageThreadId: threadId, created: true };
}

/**
 * POST /topics/named  {chatId, key, name, staleThreadId?}
 *   200 {chatId, messageThreadId, created}
 *   400 bad input · 403 chat not allowed · 409 topics disabled · 429 rate limited · 502 create failed
 *
 * Every non-200 is a fail-open signal to the daemon: it posts the alert to General instead.
 */
export async function handleNamedTopic(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const chatId = typeof body.chatId === "string" || typeof body.chatId === "number" ? String(body.chatId) : "";
  const key = typeof body.key === "string" ? body.key : "";
  const name = typeof body.name === "string" ? body.name : "";
  const stale = body.staleThreadId;
  if (!chatId || !NAMED_TOPIC_KEY_RE.test(key)) {
    return Response.json({ error: "chatId and a valid key are required" }, { status: 400 });
  }
  if (stale !== undefined && !(typeof stale === "number" && Number.isInteger(stale) && stale > 0)) {
    return Response.json({ error: "staleThreadId must be a positive integer" }, { status: 400 });
  }
  if (!isAllowedChatId(chatId, env)) {
    return Response.json({ error: "Chat ID not allowed" }, { status: 403 });
  }
  if (!topicsEnabled(env)) {
    return Response.json({ error: "topics disabled" }, { status: 409 });
  }

  const res = await resolveNamedTopic(db, {
    chatId,
    key,
    name,
    staleThreadId: stale as number | undefined,
    botToken: env.TELEGRAM_BOT_TOKEN,
  });
  if (res.ok) {
    return Response.json({ chatId, messageThreadId: res.messageThreadId, created: res.created });
  }
  if (res.kind === "rate_limited") {
    return Response.json({ error: "rate_limited", retryAfter: res.retryAfter }, { status: 429 });
  }
  return Response.json({ error: "create_failed", details: res.details }, { status: 502 });
}

/**
 * Called for an inbound message that resolved to no session. If it was typed in a named topic,
 * answer once with a hint (rate-limited per topic) and report it as handled, so the caller
 * neither injects it anywhere nor posts its generic "could not find session" error.
 *
 * The hint slot is claimed with a conditional UPDATE before sending, so concurrent messages
 * cannot each send one.
 */
export async function maybeAnswerInNamedTopic(
  db: D1Database,
  env: Env,
  chatId: string,
  messageThreadId: number | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!topicsEnabled(env) || messageThreadId === undefined) return false;
  const row = await getNamedTopicByThread(db, chatId, messageThreadId);
  if (!row) return false;

  const claimed = await db
    .prepare(
      `UPDATE named_topics SET hint_at = ?
       WHERE chat_id = ? AND topic_key = ? AND (hint_at IS NULL OR hint_at <= ?)`,
    )
    .bind(now, chatId, row.topic_key, now - NAMED_TOPIC_HINT_INTERVAL_MS)
    .run();
  if ((claimed.meta?.changes ?? 0) > 0) {
    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    const res = await tg.sendMessage({ chatId, messageThreadId, text: NAMED_TOPIC_HINT_TEXT });
    if (!res.ok) {
      console.warn("[worker] named topic hint failed", { key: row.topic_key, details: getTelegramErrorDetails(res) });
    }
  }
  return true;
}

/**
 * True only for the one failure these lookups may absorb: the worker was deployed before
 * `named_topic_bindings` was created in D1 (the schema file is applied by hand, separately).
 * Anything else -- a transient D1 error -- must still throw. Swallowing it would turn a
 * notification the daemon would have retried into a permanent misroute into a fresh session
 * topic, and tell the human nothing reads a topic that something does.
 */
function isMissingBindingsTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

/** The session a bound named topic routes to, or null. Inert when the session has no row. */
export async function getBoundSessionByThread(
  db: D1Database,
  chatId: string,
  messageThreadId: number,
): Promise<string | null> {
  try {
    const row = await db
      .prepare(
        `SELECT b.session_id FROM named_topic_bindings b
           JOIN named_topics t ON t.chat_id = b.chat_id AND t.topic_key = b.topic_key
           JOIN sessions s ON s.session_id = b.session_id
          WHERE t.chat_id = ? AND t.message_thread_id = ?`,
      )
      .bind(chatId, messageThreadId)
      .first<{ session_id: string }>();
    return row?.session_id ?? null;
  } catch (err) {
    if (!isMissingBindingsTable(err)) throw err;
    console.warn("[worker] getBoundSessionByThread: named_topic_bindings is missing (schema not applied?); treating as unbound");
    return null;
  }
}

export async function getBindingForSession(
  db: D1Database,
  sessionId: string,
): Promise<{ chat_id: string; topic_key: string; message_thread_id: number } | null> {
  try {
    const row = await db
      .prepare(
        `SELECT b.chat_id, b.topic_key, t.message_thread_id
           FROM named_topic_bindings b
           JOIN named_topics t ON t.chat_id = b.chat_id AND t.topic_key = b.topic_key
          WHERE b.session_id = ?`,
      )
      .bind(sessionId)
      .first<{ chat_id: string; topic_key: string; message_thread_id: number }>();
    return row ?? null;
  } catch (err) {
    if (!isMissingBindingsTable(err)) throw err;
    console.warn("[worker] getBindingForSession: named_topic_bindings is missing (schema not applied?); treating as unbound");
    return null;
  }
}

export async function unbindSession(db: D1Database, sessionId: string): Promise<number> {
  const r = await db.prepare("DELETE FROM named_topic_bindings WHERE session_id = ?").bind(sessionId).run();
  return r.meta?.changes ?? 0;
}

/**
 * POST /topics/named/bind  {chatId, key, name, sessionId}
 *   200 {chatId, messageThreadId, created, bound: true, sessionId}
 *   400 bad input · 403 chat not allowed · 409 topics disabled · 409 session not registered · 429/502
 */
export async function handleNamedTopicBind(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const chatId = typeof body.chatId === "string" || typeof body.chatId === "number" ? String(body.chatId) : "";
  const key = typeof body.key === "string" ? body.key : "";
  const name = typeof body.name === "string" ? body.name : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

  if (!chatId || !NAMED_TOPIC_KEY_RE.test(key) || !sessionId || sessionId.length > 128) {
    return Response.json({ error: "chatId, a valid key, and sessionId (1-128 chars) are required" }, { status: 400 });
  }
  if (!isAllowedChatId(chatId, env)) {
    return Response.json({ error: "Chat ID not allowed" }, { status: 403 });
  }
  if (!topicsEnabled(env)) {
    return Response.json({ error: "topics disabled" }, { status: 409 });
  }

  const sessionRow = await db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first();
  if (!sessionRow) {
    return Response.json({ error: "session not registered" }, { status: 409 });
  }

  const res = await resolveNamedTopic(db, {
    chatId,
    key,
    name,
    botToken: env.TELEGRAM_BOT_TOKEN,
  });
  if (!res.ok) {
    if (res.kind === "rate_limited") {
      return Response.json({ error: "rate_limited", retryAfter: res.retryAfter }, { status: 429 });
    }
    return Response.json({ error: "create_failed", details: res.details }, { status: 502 });
  }

  const now = Date.now();
  await db.batch([
    db
      .prepare("DELETE FROM named_topic_bindings WHERE session_id = ? AND NOT (chat_id = ? AND topic_key = ?)")
      .bind(sessionId, chatId, key),
    db
      .prepare(
        `INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, topic_key) DO UPDATE SET
           session_id = excluded.session_id,
           bound_at = excluded.bound_at`,
      )
      .bind(chatId, key, sessionId, now),
  ]);

  return Response.json({
    chatId,
    messageThreadId: res.messageThreadId,
    created: res.created,
    bound: true,
    sessionId,
  });
}

/**
 * POST /topics/named/unbind  {sessionId}
 *   200 {unbound: n}
 *   400 bad input
 */
export async function handleNamedTopicUnbind(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId || sessionId.length > 128) {
    return Response.json({ error: "sessionId (1-128 chars) is required" }, { status: 400 });
  }

  const unbound = await unbindSession(db, sessionId);
  return Response.json({ unbound });
}

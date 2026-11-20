/**
 * The Slack `ChatTransport` (bead pigeon-4ogz.3; plan docs/plans/2026-11-20-slack-outbound-plan.md,
 * "SlackTransport", and its review deltas; spec docs/plans/2026-11-20-slack-transport-design.md).
 *
 * It answers the daemon's Telegram-shaped contract in Slack terms. A session's "topic" is a
 * channel, a "message_thread_id" is a HANDLE (an integer from `slack_conversations`, at least
 * 2^40, so it can never be mistaken for a Telegram thread id), and a "message_id" is a handle
 * into `slack_posts`. Both tables are scoped by team id, so a handle another team minted is
 * unknown here and answers `thread_not_found`.
 *
 * Failures come out of `callSlack` already mapped onto `TgResult` (see `../slack.ts`); this file
 * adds only the method-specific answers that are benign for ONE operation (`name_taken` is a
 * retry for create/rename, `already_archived` is success for archive, and so on).
 *
 * `signal` is passed to every Slack call of an operation whose options carry one, so a request
 * with a deadline (`/messages/send` has 4 s) cannot be left holding a second, unbounded call.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { callSlack, uploadToSlack, type SlackBody } from "../slack";
import type {
  CloseForumTopicOptions,
  CreateForumTopicOptions,
  DeleteForumTopicOptions,
  EditForumTopicOptions,
  EditMessageTextOptions,
  ForumTopic,
  ReopenForumTopicOptions,
  SendDocumentOptions,
  SendMessageOptions,
  SendPhotoOptions,
  SendRichMessageOptions,
  TgResult,
  UnpinAllForumTopicMessagesOptions,
} from "../telegram";
import { slackChatId, type SlackWorkspace } from "./slack-config";
import { shouldMention, type ConversationKind, type ExplicitNotifyCategory, type NotifyCategory } from "./slack-notify";
import { buildSlackMessage, type SlackMessage } from "./slack-render";
import type { ChatResult, ChatTransport } from "./transport";

/** Slack's channel-name limit. */
const CHANNEL_NAME_MAX = 80;
/** Characters of a session id kept in a channel name (`<slug>-<sid8>`). */
const SID_LEN = 8;
/** `-<sid8>`. */
const SID_PART = SID_LEN + 1;
/** `-N`, the collision suffix. Always reserved, so the first attempt and the retries share a slug. */
const COLLISION_PART = 2;
/** Collision suffixes are tried as `-2` … `-9`. */
const MAX_COLLISION_SUFFIX = 9;
/** `conversations.setTopic` limit, in characters. */
const TOPIC_MAX = 250;
/** Characters of a post's text kept in `slack_posts`. */
const POST_TEXT_MAX = 500;
/** `conversations.list` paging for `#alerts` discovery. */
const ALERTS_LIST_PAGES = 5;
const ALERTS_LIST_PAGE_SIZE = 200;
/** The `named_topics` key of a workspace's alerts channel. Callers may not use `_`-prefixed keys. */
export const ALERTS_TOPIC_KEY = "_alerts";
const ALERTS_CHANNEL_NAME = "alerts";

export interface SlackTransportDeps {
  db: D1Database;
  ws: SlackWorkspace;
  /** Replaces the global `fetch` for every Slack call and upload (tests). */
  fetchFn?: typeof fetch;
  /**
   * The categories whose posts mention the owner (`SLACK_NOTIFY_OWNER`, parsed). Absent or empty
   * means no post ever mentions: Slack pushes are off by default (spec D7).
   */
  notifyCategories?: ReadonlySet<NotifyCategory>;
}

// ─── Names ─────────────────────────────────────────────────────────────────

/** NFKD, combining marks stripped, lower-cased, runs of anything but [a-z0-9] become one `-`, trimmed. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `[...s].slice(0, n)` as a string: never splits a surrogate pair. */
function cutPoints(s: string, n: number): string {
  const points = [...s];
  return points.length <= n ? s : points.slice(0, n).join("");
}

/**
 * Splits a topic name (`<title> · <~/dir>`, see `topicName`) into its parts. The separator is the
 * LAST ` · ` whose remainder looks like a path, since a title may itself contain ` · `. A name with
 * no such suffix is a bare directory when it looks like a path and a bare title otherwise.
 */
function splitTopicName(name: string): { title: string; dir: string } {
  const idx = name.lastIndexOf(" · ");
  if (idx >= 0) {
    const rest = name.slice(idx + 3);
    if (rest.startsWith("~") || rest.startsWith("/")) return { title: name.slice(0, idx), dir: rest };
  }
  if (name.startsWith("~") || name.startsWith("/")) return { title: "", dir: name };
  return { title: name, dir: "" };
}

function basename(dir: string): string {
  const parts = dir.split("/").filter((p) => p !== "" && p !== "~");
  return parts[parts.length - 1] ?? "";
}

/** The 8 characters after the `ses_`/`gse_` prefix, lower-cased and reduced to [a-z0-9]. */
function sessionIdSuffix(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const sid = sessionId
    .replace(/^[a-z]{3}_/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, SID_LEN);
  return sid === "" ? null : sid;
}

interface NameParts {
  slug: string;
  sid: string | null;
}

function nameParts(o: { name?: string; sessionId?: string; channelKey?: string }): NameParts {
  if (o.channelKey) return { slug: slugify(o.channelKey), sid: null };
  const sid = sessionIdSuffix(o.sessionId);
  const name = o.name ?? "";
  if (sid) {
    const { title, dir } = splitTopicName(name);
    return { slug: slugify(title) || slugify(basename(dir)), sid };
  }
  return { slug: slugify(name), sid: null };
}

/** The channel name for attempt `n` (1 = no suffix). At most 80 characters; never empty. */
function composeName(parts: NameParts, n: number): string {
  const room = CHANNEL_NAME_MAX - (parts.sid ? SID_PART : 0) - COLLISION_PART;
  const slug = cutPoints(parts.slug, room).replace(/-+$/g, "") || "session";
  return `${slug}${parts.sid ? `-${parts.sid}` : ""}${n > 1 ? `-${n}` : ""}`;
}

/** The conversation topic line: the caller's `topic`, else the name plus the session id. */
function topicText(o: { name?: string; sessionId?: string; topic?: string }): string {
  if (o.topic !== undefined) return cutPoints(o.topic, TOPIC_MAX);
  const name = o.name ?? "";
  if (!o.sessionId) return cutPoints(name, TOPIC_MAX);
  const suffix = ` · 🆔 ${o.sessionId}`;
  const room = TOPIC_MAX - [...suffix].length;
  const nameLen = [...name].length;
  const head = nameLen <= room ? name : `${cutPoints(name, Math.max(0, room - 1))}…`;
  return cutPoints(`${head}${suffix}`, TOPIC_MAX);
}

// ─── Result helpers ────────────────────────────────────────────────────────

/** Slack's own error string on a failed result, when it carries one. */
function slackErr(result: TgResult<unknown>): string | undefined {
  if (result.ok) return undefined;
  const error = (result.response as { error?: unknown } | undefined)?.error;
  return typeof error === "string" ? error : undefined;
}

function failureBody(error: string, errorClass: string, errorCode: number, description: string) {
  return { ok: false as const, error, errorClass, error_code: errorCode, description };
}

function unknownHandle<T>(what: "conversation" | "post"): ChatResult<T> {
  const description = `thread not found: unknown ${what} handle`;
  return {
    ok: false,
    kind: "thread_not_found",
    response: failureBody("unknown_handle", "conversation_gone", 400, description),
  };
}

/** A failure Slack answered with something that cannot be used (a body with no `ts`, say): transient. */
function upstreamFailure<T>(error: string): ChatResult<T> {
  const description = `slack error: ${error}`;
  return {
    ok: false,
    kind: "error",
    errorCode: 502,
    description,
    response: failureBody(error, "upstream", 502, description),
  };
}

function rejected<T>(error: string, description: string): ChatResult<T> {
  return {
    ok: false,
    kind: "error",
    errorCode: 400,
    description,
    response: failureBody(error, "rejected_format", 400, description),
  };
}

const OK_TRUE = { ok: true, result: true } as const;

// ─── The transport ─────────────────────────────────────────────────────────

interface Target {
  handle: number;
  channelId: string;
}

export function createSlackTransport(deps: SlackTransportDeps): ChatTransport {
  const { db, ws, fetchFn } = deps;
  const notifyCategories: ReadonlySet<NotifyCategory> = deps.notifyCategories ?? new Set();
  const chat = slackChatId(ws);

  const bot = (method: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    callSlack<SlackBody>(ws.botToken, method, args, { ...(signal ? { signal } : {}), ...(fetchFn ? { fetchFn } : {}) });
  const asUser = (method: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    callSlack<SlackBody>(ws.userToken, method, args, { ...(signal ? { signal } : {}), ...(fetchFn ? { fetchFn } : {}) });

  // ── handles ──

  async function targetForHandle(handle: number): Promise<Target | null> {
    const row = await db
      .prepare("SELECT channel_id FROM slack_conversations WHERE handle = ? AND team_id = ?")
      .bind(handle, ws.teamId)
      .first<{ channel_id: string }>();
    return row ? { handle, channelId: row.channel_id } : null;
  }

  /**
   * The handle of a channel, minting one on first sight; null when D1 would not record it.
   *
   * Only called AFTER Slack accepted something (the channel exists). A thrown D1 error here would
   * surface as a 500, the daemon would retry the whole operation, and the retry would create a
   * second channel. So the insert is retried once and, if it still fails, the failure is logged
   * with the channel id (an operator can recover from that) and reported as null for the caller to
   * turn into a structured transient failure.
   */
  async function ensureConversation(channelId: string): Promise<number | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await db
          .prepare("INSERT OR IGNORE INTO slack_conversations (team_id, channel_id, created_at) VALUES (?, ?, ?)")
          .bind(ws.teamId, channelId, Date.now())
          .run();
        const row = await db
          .prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
          .bind(ws.teamId, channelId)
          .first<{ handle: number }>();
        if (!row) throw new Error("slack_conversations row missing after insert");
        return row.handle;
      } catch (err) {
        if (attempt === 2) {
          console.error("[worker] slack conversation created but not recorded", { channelId, err: String(err) });
        }
      }
    }
    return null;
  }

  /**
   * Records a post and returns its handle, or 0 when D1 would not record it.
   *
   * Only called after Slack accepted the post. Throwing would make the daemon retry a message that
   * is already in the channel, a visible duplicate, so a failed insert is retried once and then
   * downgraded: the send succeeds with message_id 0. The cost is that this one post cannot later be
   * edited or used as a reply target (0 is an unknown handle), which only matters for a wizard
   * question and a reply-threaded file.
   */
  async function recordPost(channelId: string, ts: string, text: string): Promise<number> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await db
          .prepare("INSERT OR IGNORE INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(ws.teamId, channelId, ts, cutPoints(text, POST_TEXT_MAX), Date.now())
          .run();
        const row = await db
          .prepare("SELECT handle FROM slack_posts WHERE team_id = ? AND channel_id = ? AND ts = ?")
          .bind(ws.teamId, channelId, ts)
          .first<{ handle: number }>();
        if (!row) throw new Error("slack_posts row missing after insert");
        return row.handle;
      } catch (err) {
        if (attempt === 2) {
          console.warn("[worker] slack post sent but not recorded; returning message_id 0", {
            channelId,
            ts,
            err: String(err),
          });
        }
      }
    }
    return 0;
  }

  async function postForHandle(handle: number): Promise<{ channelId: string; ts: string } | null> {
    const row = await db
      .prepare("SELECT channel_id, ts FROM slack_posts WHERE handle = ? AND team_id = ?")
      .bind(handle, ws.teamId)
      .first<{ channel_id: string; ts: string }>();
    return row ? { channelId: row.channel_id, ts: row.ts } : null;
  }

  /** `alerts` for the `_alerts` row, `named` for any other named topic, else `session`. */
  async function conversationKind(handle: number): Promise<ConversationKind> {
    const row = await db
      .prepare("SELECT topic_key FROM named_topics WHERE chat_id = ? AND message_thread_id = ? LIMIT 1")
      .bind(chat, handle)
      .first<{ topic_key: string }>();
    if (row === null) return "session";
    return row.topic_key === ALERTS_TOPIC_KEY ? "alerts" : "named";
  }

  // ── conversation operations ──

  async function inviteOwner(channelId: string, signal?: AbortSignal): Promise<void> {
    const res = await bot("conversations.invite", { channel: channelId, users: ws.ownerUserId }, signal);
    if (!res.ok && slackErr(res) !== "already_in_channel") {
      console.warn("[worker] slack owner invite failed", { channelId, error: slackErr(res) ?? res.kind });
    }
  }

  const join = (channelId: string, signal?: AbortSignal) => bot("conversations.join", { channel: channelId }, signal);

  /**
   * Runs one channel operation; on `not_in_channel` joins and retries once, and (when `unarchive`)
   * on `is_archived` unarchives (as the user: a bot may not), joins and retries once. A failure of
   * a recovery step is that step's own mapped error, so an unarchive 429 stays a transient 503.
   *
   * `unarchive` is for posting, which should reach the conversation whatever its state. Metadata
   * edits pass false: renaming or re-topicking a closed conversation must not reopen it, so
   * `is_archived` stays `thread_not_found` for them.
   */
  async function withChannelRecovery(
    channelId: string,
    op: () => Promise<TgResult<SlackBody>>,
    signal?: AbortSignal,
    unarchive = true,
  ): Promise<TgResult<SlackBody>> {
    const first = await op();
    if (first.ok) return first;
    const error = slackErr(first);
    if (error === "not_in_channel") {
      const joined = await join(channelId, signal);
      if (!joined.ok) return joined;
      return op();
    }
    if (error === "is_archived" && unarchive) {
      const unarchived = await asUser("conversations.unarchive", { channel: channelId }, signal);
      if (!unarchived.ok && slackErr(unarchived) !== "not_archived") return unarchived;
      const joined = await join(channelId, signal);
      if (!joined.ok) return joined;
      return op();
    }
    return first;
  }

  // ── #alerts ──

  async function alertsFromDb(): Promise<Target | null> {
    const row = await db
      .prepare(
        `SELECT c.handle AS handle, c.channel_id AS channel_id
         FROM named_topics t
         JOIN slack_conversations c ON c.handle = t.message_thread_id AND c.team_id = ?
         WHERE t.chat_id = ? AND t.topic_key = ?`,
      )
      .bind(ws.teamId, chat, ALERTS_TOPIC_KEY)
      .first<{ handle: number; channel_id: string }>();
    return row ? { handle: row.handle, channelId: row.channel_id } : null;
  }

  /**
   * An existing public `#alerts`, archived or not, found by listing (at most 5 pages), or
   * undefined. Archived channels are included because an archived `alerts` still owns the name:
   * creating one would answer `name_taken` forever.
   */
  async function findAlertsChannel(
    signal?: AbortSignal,
  ): Promise<TgResult<{ id: string; archived: boolean } | undefined>> {
    let cursor: string | undefined;
    for (let page = 0; page < ALERTS_LIST_PAGES; page++) {
      const res = await bot(
        "conversations.list",
        {
          types: "public_channel",
          exclude_archived: false,
          limit: ALERTS_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (!res.ok) return res;
      const channels = Array.isArray(res.result.channels)
        ? (res.result.channels as Array<{ id?: string; name?: string; is_archived?: boolean }>)
        : [];
      const hit = channels.find((c) => c.name === ALERTS_CHANNEL_NAME && typeof c.id === "string");
      if (hit?.id) return { ok: true, result: { id: hit.id, archived: hit.is_archived === true } };
      const next = res.result.response_metadata?.next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
    return { ok: true, result: undefined };
  }

  /**
   * The workspace's `#alerts`: the `named_topics` row `(slack:<team>, '_alerts')` when its
   * conversation is known; else an existing public channel named `alerts` (joined); else a new
   * one (owner invited). Concurrent first use: the loser's INSERT OR IGNORE is a no-op and both
   * read the winner's row back.
   */
  /** Makes a discovered `#alerts` usable: unarchive it (as the user) when archived, then join. */
  async function adoptAlertsChannel(
    hit: { id: string; archived: boolean },
    signal?: AbortSignal,
  ): Promise<ChatResult<string>> {
    if (hit.archived) {
      const unarchived = await asUser("conversations.unarchive", { channel: hit.id }, signal);
      if (!unarchived.ok && slackErr(unarchived) !== "not_archived") return unarchived;
    }
    const joined = await join(hit.id, signal);
    if (!joined.ok) return joined;
    return { ok: true, result: hit.id };
  }

  async function resolveAlertsChannel(signal?: AbortSignal): Promise<ChatResult<Target>> {
    const existing = await alertsFromDb();
    if (existing) return { ok: true, result: existing };

    // A row whose conversation is gone would defeat the INSERT OR IGNORE below.
    await db
      .prepare(
        `DELETE FROM named_topics WHERE chat_id = ? AND topic_key = ?
           AND message_thread_id NOT IN (SELECT handle FROM slack_conversations WHERE team_id = ?)`,
      )
      .bind(chat, ALERTS_TOPIC_KEY, ws.teamId)
      .run();

    let channelId: string | undefined;
    const found = await findAlertsChannel(signal);
    if (!found.ok) return found;
    if (found.result !== undefined) {
      const adopted = await adoptAlertsChannel(found.result, signal);
      if (!adopted.ok) return adopted;
      channelId = adopted.result;
    } else {
      const created = await bot("conversations.create", { name: ALERTS_CHANNEL_NAME, is_private: false }, signal);
      if (!created.ok) {
        if (slackErr(created) !== "name_taken") return created;
        // Someone else made it between our listing and our create (or the listing missed it).
        // Their row may already be stored; if not, look again and adopt what they made.
        const raced = await alertsFromDb();
        if (raced) return { ok: true, result: raced };
        const again = await findAlertsChannel(signal);
        if (!again.ok) return again;
        if (again.result === undefined) return created;
        const adopted = await adoptAlertsChannel(again.result, signal);
        if (!adopted.ok) return adopted;
        channelId = adopted.result;
      } else {
        const id = created.result.channel?.id;
        if (typeof id !== "string") return upstreamFailure("create_without_channel");
        channelId = id;
        await inviteOwner(id, signal);
      }
    }

    const handle = await ensureConversation(channelId);
    if (handle === null) return upstreamFailure("handle_not_recorded");
    const now = Date.now();
    await db
      .prepare(
        `INSERT OR IGNORE INTO named_topics
           (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(chat, ALERTS_TOPIC_KEY, handle, ALERTS_CHANNEL_NAME, now, now)
      .run();
    const winner = await alertsFromDb();
    return { ok: true, result: winner ?? { handle, channelId } };
  }

  /** Drops the `_alerts` row, but only while it still points at `handle`. */
  async function forgetAlerts(handle: number): Promise<void> {
    await db
      .prepare("DELETE FROM named_topics WHERE chat_id = ? AND topic_key = ? AND message_thread_id = ?")
      .bind(chat, ALERTS_TOPIC_KEY, handle)
      .run();
  }

  async function resolveTarget(messageThreadId: number | undefined, signal?: AbortSignal): Promise<ChatResult<Target>> {
    if (messageThreadId === undefined) return resolveAlertsChannel(signal);
    const target = await targetForHandle(messageThreadId);
    return target ? { ok: true, result: target } : unknownHandle("conversation");
  }

  // ── posting ──

  interface PostInput {
    messageThreadId: number | undefined;
    /** Plain text (or markdown) kept in `slack_posts`. */
    recordText: string;
    notifyOwner: boolean | undefined;
    notifyCategory: ExplicitNotifyCategory | undefined;
    build: (notifyOwner: boolean) => SlackMessage;
    signal?: AbortSignal;
  }

  async function postOnce(target: Target, input: PostInput): Promise<TgResult<SlackBody>> {
    const notify = shouldMention({
      categories: notifyCategories,
      notifyOwner: input.notifyOwner,
      notifyCategory: input.notifyCategory,
      conversationKind: await conversationKind(target.handle),
    });
    const message = input.build(notify);
    return withChannelRecovery(
      target.channelId,
      () =>
        bot(
          "chat.postMessage",
          {
            channel: target.channelId,
            text: message.text,
            blocks: message.blocks,
            unfurl_links: false,
            unfurl_media: false,
          },
          input.signal,
        ),
      input.signal,
    );
  }

  async function post(input: PostInput): Promise<ChatResult<{ message_id: number }>> {
    const resolved = await resolveTarget(input.messageThreadId, input.signal);
    if (!resolved.ok) return resolved;
    let target = resolved.result;
    let res = await postOnce(target, input);

    // The alerts channel was deleted out from under its row: forget it and look again, once.
    if (
      !res.ok &&
      input.messageThreadId === undefined &&
      res.kind === "thread_not_found" &&
      slackErr(res) === "channel_not_found"
    ) {
      await forgetAlerts(target.handle);
      const again = await resolveAlertsChannel(input.signal);
      if (!again.ok) return again;
      target = again.result;
      res = await postOnce(target, input);
    }

    if (!res.ok) return res;
    const ts = res.result.ts;
    if (typeof ts !== "string" || ts === "") return upstreamFailure("post_without_ts");
    const handle = await recordPost(target.channelId, ts, input.recordText);
    return { ok: true, result: { message_id: handle } };
  }

  // ── files ──

  async function sendFile(
    blob: Blob,
    filename: string,
    messageThreadId: number | undefined,
    replyToMessageId: number | undefined,
    signal?: AbortSignal,
  ): Promise<ChatResult<{ message_id: number }>> {
    const resolved = await resolveTarget(messageThreadId, signal);
    if (!resolved.ok) return resolved;
    const target = resolved.result;

    let threadTs: string | undefined;
    if (replyToMessageId !== undefined) {
      const reply = await postForHandle(replyToMessageId);
      if (reply && reply.channelId === target.channelId && !reply.ts.startsWith("file:")) threadTs = reply.ts;
    }

    const slot = await bot("files.getUploadURLExternal", { filename, length: blob.size }, signal);
    if (!slot.ok) return slot;
    const uploadUrl = slot.result.upload_url;
    const fileId = slot.result.file_id;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") return upstreamFailure("upload_slot_missing");

    const uploaded = await uploadToSlack(uploadUrl, blob, {
      ...(signal ? { signal } : {}),
      ...(fetchFn ? { fetchFn } : {}),
    });
    if (!uploaded.ok) return uploaded;

    const completed = await withChannelRecovery(
      target.channelId,
      () =>
        bot(
          "files.completeUploadExternal",
          {
            files: [{ id: fileId, title: filename }],
            channel_id: target.channelId,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          },
          signal,
        ),
      signal,
    );
    if (!completed.ok) return completed;

    const handle = await recordPost(target.channelId, `file:${fileId}`, filename);
    return { ok: true, result: { message_id: handle } };
  }

  // ── channels ──

  /**
   * Runs `attempt(name)` for `-`, `-2` … `-9`, moving on only when Slack answers `name_taken`.
   * Anything else, success included, is returned as it is; running out is `create_failed`.
   */
  async function withUniqueName(
    parts: NameParts,
    attempt: (name: string) => Promise<TgResult<SlackBody>>,
  ): Promise<{ result: TgResult<SlackBody>; name: string } | { result: ChatResult<never>; name: null }> {
    for (let n = 1; n <= MAX_COLLISION_SUFFIX; n++) {
      const name = composeName(parts, n);
      const result = await attempt(name);
      if (result.ok || slackErr(result) !== "name_taken") return { result, name };
    }
    return {
      result: rejected("create_failed", `create_failed: no free channel name after ${MAX_COLLISION_SUFFIX} attempts`),
      name: null,
    };
  }

  async function archive(handle: number, signal?: AbortSignal): Promise<ChatResult<boolean>> {
    const target = await targetForHandle(handle);
    if (!target) return unknownHandle("conversation");
    const res = await withChannelRecovery(
      target.channelId,
      () => bot("conversations.archive", { channel: target.channelId }, signal),
      signal,
      false,
    );
    if (res.ok || slackErr(res) === "already_archived") return OK_TRUE;
    return res;
  }

  return {
    async sendMessage(options: SendMessageOptions) {
      return post({
        messageThreadId: options.messageThreadId,
        recordText: options.text,
        notifyOwner: options.notifyOwner,
        notifyCategory: options.notifyCategory,
        build: (notify) =>
          buildSlackMessage({
            text: options.text,
            ...(options.entities ? { entities: options.entities } : {}),
            replyMarkup: options.replyMarkup,
            ownerUserId: ws.ownerUserId,
            notifyOwner: notify,
          }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },

    async sendRichMessage(options: SendRichMessageOptions) {
      return post({
        messageThreadId: options.messageThreadId,
        recordText: options.text ?? options.markdown,
        notifyOwner: options.notifyOwner,
        notifyCategory: options.notifyCategory,
        build: (notify) =>
          buildSlackMessage({
            // The fallback text is what a notification shows: the caller's plain text when it
            // sent one, else the markdown source.
            text: options.text ?? options.markdown,
            markdown: options.markdown,
            replyMarkup: options.replyMarkup,
            ownerUserId: ws.ownerUserId,
            notifyOwner: notify,
          }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },

    async editMessageText(options: EditMessageTextOptions) {
      const original = await postForHandle(options.messageId);
      if (!original) return unknownHandle("post");
      if (original.ts.startsWith("file:")) return rejected("not_editable", "slack file posts cannot be edited");
      const conversation = await db
        .prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
        .bind(ws.teamId, original.channelId)
        .first<{ handle: number }>();
      const notify = shouldMention({
        categories: notifyCategories,
        notifyOwner: options.notifyOwner,
        notifyCategory: options.notifyCategory,
        conversationKind: conversation !== null ? await conversationKind(conversation.handle) : "session",
      });
      const message = buildSlackMessage({
        text: options.text,
        ...(options.entities ? { entities: options.entities } : {}),
        replyMarkup: options.replyMarkup,
        ownerUserId: ws.ownerUserId,
        notifyOwner: notify,
      });
      const res = await bot(
        "chat.update",
        { channel: original.channelId, ts: original.ts, text: message.text, blocks: message.blocks },
        options.signal,
      );
      if (!res.ok) return res;
      try {
        await db
          .prepare("UPDATE slack_posts SET text = ? WHERE handle = ? AND team_id = ?")
          .bind(cutPoints(options.text, POST_TEXT_MAX), options.messageId, ws.teamId)
          .run();
      } catch (err) {
        // Slack already has the edit; the stored text is only a convenience copy.
        console.warn("[worker] slack post edited but its stored text was not updated", { err: String(err) });
      }
      return { ok: true, result: { message_id: options.messageId } };
    },

    async sendPhoto(options: SendPhotoOptions) {
      return sendFile(options.photo, options.filename, options.messageThreadId, options.replyToMessageId, options.signal);
    },

    async sendDocument(options: SendDocumentOptions) {
      return sendFile(options.document, options.filename, options.messageThreadId, options.replyToMessageId, options.signal);
    },

    async createForumTopic(options: CreateForumTopicOptions): Promise<ChatResult<ForumTopic>> {
      const parts = nameParts(options);
      const created = await withUniqueName(parts, (name) =>
        bot("conversations.create", { name, is_private: false }),
      );
      if (!created.result.ok) return created.result;
      const channelId = created.result.result.channel?.id;
      if (typeof channelId !== "string") return upstreamFailure("create_without_channel");
      const channelName: string =
        typeof created.result.result.channel?.name === "string"
          ? created.result.result.channel.name
          : (created.name as string);

      // Durable before the cosmetic steps, so a failure below cannot orphan a channel from its handle.
      const handle = await ensureConversation(channelId);
      // The channel exists but has no handle, so nothing can address it. A transient failure (not a
      // thrown 500): the retry makes a fresh channel, and the logged channel id lets one be tidied.
      if (handle === null) return upstreamFailure("handle_not_recorded");
      await inviteOwner(channelId);
      const topic = await bot("conversations.setTopic", { channel: channelId, topic: topicText(options) });
      if (!topic.ok) console.warn("[worker] slack setTopic failed", { channelId, error: slackErr(topic) ?? topic.kind });

      return { ok: true, result: { message_thread_id: handle, name: channelName, icon_color: 0 } };
    },

    /**
     * Renames only when the channel name can be computed in full: with a `sessionId` (the name
     * ends in the session's 8 characters) or a `channelKey` (the name is the key). With neither,
     * a rename would strip the suffix that makes the name unique, so only the topic is edited.
     */
    async editForumTopic(options: EditForumTopicOptions) {
      if (options.name === undefined && options.topic === undefined) return OK_TRUE;
      const target = await targetForHandle(options.messageThreadId);
      if (!target) return unknownHandle("conversation");
      const channel = (op: () => Promise<TgResult<SlackBody>>) =>
        withChannelRecovery(target.channelId, op, undefined, false);

      const info = await channel(() => bot("conversations.info", { channel: target.channelId }));
      if (!info.ok) return info;
      const currentName = typeof info.result.channel?.name === "string" ? (info.result.channel.name as string) : "";
      const currentTopic =
        typeof info.result.channel?.topic?.value === "string" ? (info.result.channel.topic.value as string) : "";

      if (options.name !== undefined) {
        const parts = nameParts({
          name: options.name,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.channelKey ? { channelKey: options.channelKey } : {}),
        });
        if (parts.sid !== null || options.channelKey) {
          let unchanged = false;
          for (let n = 1; n <= MAX_COLLISION_SUFFIX; n++) {
            if (composeName(parts, n) === currentName) unchanged = true;
          }
          if (!unchanged) {
            const renamed = await withUniqueName(parts, (name) =>
              channel(() => bot("conversations.rename", { channel: target.channelId, name })),
            );
            if (!renamed.result.ok) return renamed.result;
          }
        }
      }

      let desired = topicText({
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.topic !== undefined ? { topic: options.topic } : {}),
      });
      if (options.sessionId === undefined && options.topic === undefined) {
        // Nothing here says which session this is, but the channel's current topic line may, and
        // dropping its id would lose the one place a human can read it.
        const idSuffix = currentTopic.match(/ · 🆔 \S+$/)?.[0];
        if (idSuffix) desired = topicText({ topic: `${cutPoints(desired, TOPIC_MAX - [...idSuffix].length)}${idSuffix}` });
      }
      if (desired !== currentTopic) {
        const set = await channel(() =>
          bot("conversations.setTopic", { channel: target.channelId, topic: desired }),
        );
        if (!set.ok) return set;
      }
      return OK_TRUE;
    },

    async closeForumTopic(options: CloseForumTopicOptions) {
      return archive(options.messageThreadId);
    },

    async reopenForumTopic(options: ReopenForumTopicOptions) {
      const target = await targetForHandle(options.messageThreadId);
      if (!target) return unknownHandle("conversation");
      const res = await asUser("conversations.unarchive", { channel: target.channelId });
      if (res.ok) return OK_TRUE;
      if (slackErr(res) === "not_archived") {
        return { ok: false, kind: "topic_not_modified", response: res.response };
      }
      return res;
    },

    async deleteForumTopic(options: DeleteForumTopicOptions) {
      // Bots cannot delete a channel. This is only used to retire a lost-race duplicate.
      return archive(options.messageThreadId);
    },

    async unpinAllForumTopicMessages(_options: UnpinAllForumTopicMessagesOptions) {
      // Slack pins nothing on its own, so there is nothing to clear.
      return OK_TRUE;
    },
  };
}

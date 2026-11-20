/**
 * Slack ingress (chat-transport phase 2, bead pigeon-4ogz.4; spec
 * docs/plans/2026-11-20-slack-transport-design.md §5). Slack's counterpart of `webhook.ts`.
 *
 *   POST /slack/<machine>/events         Events API (`message.channels`, `url_verification`)
 *   POST /slack/<machine>/commands       slash commands
 *   POST /slack/<machine>/interactivity  button presses (`block_actions`)
 *
 * The path names the machine, and so the workspace (D2: machine = workspace). With no
 * `SLACK_WORKSPACE_<MACHINE>` secret every one of these answers the router's ordinary 404, so a
 * worker with no Slack configured behaves exactly as before this file existed.
 *
 * Every request is checked in the same order: the signature against the PATH's workspace secret,
 * on the raw body, before anything is parsed; then `team_id` and `api_app_id` against that
 * workspace (except `url_verification`, whose body carries neither); then the owner. A request
 * from anyone but the owner is dropped silently with a 200 on all three endpoints (D5).
 *
 * What a Slack message means is decided by the same code Telegram uses: `parseChatCommand` for
 * slash commands, `lookupMessage`/`lookupMessageByToken` for replies and buttons, `queueCommand`'s
 * INSERT for the command. Only the addressing differs: a channel is a handle in
 * `slack_conversations`, a post a handle in `slack_posts`, both under `slack:<team>`.
 */
import { lookupMessage, lookupMessageByToken } from "./notifications";
import { getBoundSessionByThread, maybeAnswerInNamedTopic } from "./named-topics";
import { getBySession, getByThread, topicName } from "./topics";
import { currentDirSuffix, editTopicName } from "./topic-rename";
import { commandInsertStatement, isMachineRecent, isQueueFull, MAX_QUEUE_PER_MACHINE, queueCommand } from "./d1-ops";
import { transportForChat } from "./chat";
import { parseChatCommand, sessionCommandAck, SESSION_COMMAND_USAGE_TEXT } from "./chat/commands";
import { ambiguousRefText, noSessionRefText, resolveSessionRef } from "./chat/session-ref";
import { slackChatId, slackWorkspaceForMachine, type SlackWorkspace } from "./chat/slack-config";
import { verifySlackSignature } from "./chat/slack-verify";
import { buildSlackMessage } from "./chat/slack-render";
import { callSlack, downloadSlackFile } from "./slack";
import { LAUNCH_USAGE_TEXT } from "./launch-command";
import { TAG_USAGE_TEXT } from "./tag-command";
import type { MediaRef } from "./media";
import { IN_REPLY_TO_MAX_CHARS, MAX_COMMAND_LENGTH, MAX_FILE_SIZE, MAX_IMAGE_DIMENSION } from "./webhook";

export type SlackEndpoint = "events" | "commands" | "interactivity";

/** `ctx.waitUntil`, or an inline await when there is no execution context (tests). */
export type WaitUntil = (work: Promise<unknown>) => void;

/** How long a thread reply waits for `conversations.replies` before going without `inReplyTo`. */
export const PARENT_FETCH_TIMEOUT_MS = 1_000;

/** Inbound file download cap: `waitUntil` work gets about 30 s after the response. */
export const FILE_DOWNLOAD_TIMEOUT_MS = 25_000;

/** `slack_seen_events` retention: past Slack's 24 h of Delayed Events retries, with room. */
export const SLACK_SEEN_EVENT_TTL_MS = 48 * 60 * 60 * 1000;

/** Message subtypes that are a human writing. Everything else (edits, joins, topic changes) is noise. */
const ROUTED_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

const OK = () => new Response("", { status: 200 });
const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

// ─── text ──────────────────────────────────────────────────────────────────

/**
 * Slack's message text as the human typed it. Slack escapes `&`, `<`, `>` and wraps links and
 * mentions in `<...>`: `<https://x.io|x.io>`, `<mailto:a@b|a@b>`, `<@U123>`, `<#C123|general>`.
 * A prompt must not carry that markup (`a &lt; b` is not what was typed). Links become their URL
 * (or `label (url)` when the label says something else), mentions become `@name`/`#name`.
 */
export function slackTextToPlain(text: string): string {
  const linked = text.replace(/<([^<>]+)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const label = bar >= 0 ? inner.slice(bar + 1) : "";
    if (target.startsWith("@") || target.startsWith("#")) return label ? `${target[0]}${label}` : target;
    if (target.startsWith("!")) return label || `@${target.slice(1).split("^")[0]}`;
    if (!label) return target;
    if (target.startsWith("mailto:")) return label;
    const bare = target.replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/i, "").replace(/\/$/, "");
    return bare === label.replace(/\/$/, "") ? target : `${label} (${target})`;
  });
  return linked.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ─── D1 helpers ────────────────────────────────────────────────────────────

/**
 * The handle of a channel in this workspace, or null. With `mint`, a channel that has none gets
 * one, so the daemon's reply to a command typed there (which goes to the command's chat + handle)
 * lands in that channel, not in `#alerts`. Only ever called for a channel a signed request came from.
 */
async function channelHandle(db: D1Database, ws: SlackWorkspace, channelId: string, mint: boolean): Promise<number | null> {
  const find = () =>
    db
      .prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
      .bind(ws.teamId, channelId)
      .first<{ handle: number }>();
  const row = await find();
  if (row || !mint) return row?.handle ?? null;
  await db
    .prepare("INSERT OR IGNORE INTO slack_conversations (team_id, channel_id, created_at) VALUES (?, ?, ?)")
    .bind(ws.teamId, channelId, Date.now())
    .run();
  return (await find())?.handle ?? null;
}

const seenInsert = (db: D1Database, eventId: string) =>
  db.prepare("INSERT INTO slack_seen_events (event_id, created_at) VALUES (?, ?)").bind(eventId, Date.now());

function isSeenConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: slack_seen_events/i.test(String(err));
}

/** Records the event as handled. False when it already was (a retry): the caller does nothing. */
async function markSeen(db: D1Database, eventId: string): Promise<boolean> {
  try {
    await seenInsert(db, eventId).run();
    return true;
  } catch (err) {
    if (isSeenConflict(err)) return false;
    throw err;
  }
}

/** Deletes dedup rows past retention. Best-effort, like the `slack_posts` sweep. */
export async function sweepSlackSeenEvents(db: D1Database, now: number = Date.now()): Promise<number> {
  try {
    const res = await db
      .prepare("DELETE FROM slack_seen_events WHERE created_at < ?")
      .bind(now - SLACK_SEEN_EVENT_TTL_MS)
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      console.log("[worker] slack_seen_events retention skipped: table missing");
      return 0;
    }
    console.error("[worker] slack_seen_events retention sweep failed", { error: String(err) });
    return 0;
  }
}

function parseQuestionRequestId(notificationId: string | null | undefined): string | undefined {
  if (notificationId && notificationId.startsWith("q:")) {
    const parts = notificationId.split(":");
    if (parts.length >= 3) return parts.slice(2).join(":").replace(/#c\d+$/, "");
  }
  return undefined;
}

// ─── replies into Slack ────────────────────────────────────────────────────

/** A best-effort bot post into a conversation (by handle). Failures are logged, never thrown. */
async function postInChannel(env: Env, db: D1Database, ws: SlackWorkspace, handle: number, text: string): Promise<void> {
  const chatId = slackChatId(ws);
  try {
    const res = await transportForChat(chatId, env.TELEGRAM_BOT_TOKEN, undefined, { env, db }).sendMessage({
      chatId,
      messageThreadId: handle,
      text,
    });
    if (!res.ok) console.warn("[slack-inbound] reply post failed", { handle, kind: res.kind });
  } catch (err) {
    console.warn("[slack-inbound] reply post threw", { handle, err: String(err) });
  }
}

/** A best-effort ephemeral note to the owner (a button that no longer works). */
async function postEphemeral(ws: SlackWorkspace, channelId: string, text: string): Promise<void> {
  try {
    const res = await callSlack(ws.botToken, "chat.postEphemeral", { channel: channelId, user: ws.ownerUserId, text });
    if (!res.ok) console.warn("[slack-inbound] ephemeral post failed", { kind: res.kind });
  } catch (err) {
    console.warn("[slack-inbound] ephemeral post threw", { err: String(err) });
  }
}

/** A slash command's inline answer. `in_channel` for an ack, ephemeral for usage and refusals. */
function commandReply(text: string, visible: boolean): Response {
  const msg = buildSlackMessage({ text });
  return Response.json({ response_type: visible ? "in_channel" : "ephemeral", text: msg.text, blocks: msg.blocks });
}

// ─── entry ─────────────────────────────────────────────────────────────────

export async function handleSlackRequest(
  db: D1Database,
  env: Env,
  request: Request,
  machineId: string,
  endpoint: SlackEndpoint,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const ws = slackWorkspaceForMachine(env, machineId);
  if (!ws) return NOT_FOUND();

  const raw = await request.text();
  const sig = await verifySlackSignature(request.headers, raw, ws.signingSecret);
  if (!sig.ok) {
    console.warn("[slack-inbound] signature refused", { machineId, endpoint, reason: sig.reason });
    return new Response("Unauthorized", { status: 401 });
  }

  if (endpoint === "events") return handleEvents(db, env, ws, raw, waitUntil);
  if (endpoint === "commands") return handleCommand(db, env, ws, raw);
  return handleInteractivity(db, env, ws, raw);
}

function teamMismatch(ws: SlackWorkspace, teamId: unknown, appId: unknown): boolean {
  return teamId !== ws.teamId || appId !== ws.appId;
}

// ─── events ────────────────────────────────────────────────────────────────

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  original_w?: number;
  original_h?: number;
  [thumb: string]: unknown;
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  files?: SlackFile[];
  attachments?: Array<{ is_share?: boolean }>;
}

/** The thread parent's text, when it is our own app's post Slack still has (spec §5 reply context). */
async function fetchParentText(ws: SlackWorkspace, channelId: string, threadTs: string): Promise<string | undefined> {
  try {
    const res = await callSlack(
      ws.botToken,
      "conversations.replies",
      { channel: channelId, ts: threadTs, limit: 1, inclusive: true },
      { signal: AbortSignal.timeout(PARENT_FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return undefined;
    const parent = Array.isArray(res.result.messages) ? res.result.messages[0] : undefined;
    if (!parent || parent.ts !== threadTs || typeof parent.bot_id !== "string") return undefined;
    // Only this app's own posts are context, the rule Telegram applies (buildExecuteMetadata).
    const appId = parent.app_id ?? parent.bot_profile?.app_id;
    if (appId !== ws.appId) return undefined;
    const text = slackTextToPlain(typeof parent.text === "string" ? parent.text : "").trim();
    return text ? text.slice(0, IN_REPLY_TO_MAX_CHARS) : undefined;
  } catch (err) {
    console.warn("[slack-inbound] thread parent fetch failed", { err: String(err) });
    return undefined;
  }
}

/**
 * What to fetch for an inbound file: the original, or for a photo larger than
 * MAX_IMAGE_DIMENSION the largest Slack thumbnail within it (Telegram's rule, `extractMedia`).
 */
export function pickSlackFile(
  file: SlackFile,
): { url: string; mime: string; filename: string; size: number; original: boolean } | null {
  const mime = typeof file.mimetype === "string" && file.mimetype ? file.mimetype : "application/octet-stream";
  const filename = typeof file.name === "string" && file.name ? file.name : `file_${file.id ?? "slack"}`;
  const size = typeof file.size === "number" ? file.size : 0;
  const w = typeof file.original_w === "number" ? file.original_w : 0;
  const h = typeof file.original_h === "number" ? file.original_h : 0;
  if (mime.startsWith("image/") && (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION)) {
    let best: { px: number; url: string } | null = null;
    for (const [key, value] of Object.entries(file)) {
      const m = key.match(/^thumb_(\d+)$/);
      if (!m || typeof value !== "string") continue;
      const px = Number(m[1]);
      if (px <= MAX_IMAGE_DIMENSION && (!best || px > best.px)) best = { px, url: value };
    }
    if (!best) return null;
    return { url: best.url, mime: mime === "image/png" ? "image/png" : "image/jpeg", filename, size: 0, original: false };
  }
  if (typeof file.url_private_download !== "string" || !file.url_private_download) return null;
  return { url: file.url_private_download, mime, filename, size, original: true };
}

async function handleEvents(
  db: D1Database,
  env: Env,
  ws: SlackWorkspace,
  raw: string,
  waitUntil: WaitUntil | undefined,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "invalid JSON" }, { status: 400 });

  // The flip's Retry -> Verified handshake. Its body is {token, challenge, type}: no team or app
  // id to check, so the signature (already verified, with this path's secret) is the whole check.
  if (body.type === "url_verification") {
    return Response.json({ challenge: typeof body.challenge === "string" ? body.challenge : "" });
  }
  if (body.type !== "event_callback") return OK();
  if (teamMismatch(ws, body.team_id, body.api_app_id)) {
    console.warn("[slack-inbound] event for another team or app refused");
    return new Response("Forbidden", { status: 403 });
  }

  const eventId = body.event_id;
  const event = body.event as SlackMessageEvent | undefined;
  if (typeof eventId !== "string" || !eventId || !event || event.type !== "message") return OK();
  if (event.bot_id || !ROUTED_SUBTYPES.has(event.subtype)) return OK();
  if (event.user !== ws.ownerUserId) return OK(); // owner only, silently (D5)
  const channelId = event.channel;
  if (typeof channelId !== "string" || !channelId) return OK();

  const chat = slackChatId(ws);
  const handle = await channelHandle(db, ws, channelId, false);
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;

  // Session resolution, highest fidelity first (spec §5): the thread's parent post, the
  // channel's session, the session bound to a named channel.
  let sessionId: string | null = null;
  let questionRequestId: string | undefined;
  let parentText: string | null | undefined;
  if (threadTs) {
    const parent = await db
      .prepare("SELECT handle, text FROM slack_posts WHERE team_id = ? AND channel_id = ? AND ts = ?")
      .bind(ws.teamId, channelId, threadTs)
      .first<{ handle: number; text: string | null }>();
    if (parent) {
      parentText = parent.text;
      const mapping = await lookupMessage(db, chat, parent.handle);
      if (mapping) {
        sessionId = mapping.session_id;
        questionRequestId = parseQuestionRequestId(mapping.notification_id);
      }
    }
  }
  if (!sessionId && handle !== null) {
    const topic = await getByThread(db, chat, handle);
    if (topic) sessionId = topic.session_id;
  }
  if (!sessionId && handle !== null) sessionId = await getBoundSessionByThread(db, chat, handle);

  if (!sessionId) {
    // A channel pigeon never addressed (one Jonathan made, say) gets no answer: it has no handle,
    // and an unthreaded post would land in #alerts instead.
    if (handle === null) return OK();
    if (!(await markSeen(db, eventId))) return OK();
    if (await maybeAnswerInNamedTopic(db, env, chat, handle)) return OK();
    await postInChannel(env, db, ws, handle, "Could not find a session for this channel.");
    return OK();
  }

  // From here a handle exists: a session's topic or a bound channel is a handle, and so is a post.
  const replyHandle = handle ?? (await channelHandle(db, ws, channelId, true));
  const refuse = async (text: string) => {
    if (!(await markSeen(db, eventId))) return OK();
    if (replyHandle !== null) await postInChannel(env, db, ws, replyHandle, text);
    return OK();
  };

  const command = slackTextToPlain(event.text ?? "");
  const file = Array.isArray(event.files) && event.files.length > 0 ? event.files[0]! : undefined;

  if (!command.trim() && !file) return refuse("Nothing to send — that message had no text.");
  if (command.length > MAX_COMMAND_LENGTH) {
    return refuse(`Command too long (${command.length} chars, max ${MAX_COMMAND_LENGTH})`);
  }

  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) return refuse("Session not found");
  if (await isQueueFull(db, session.machine_id)) {
    return refuse(`Queue full for ${session.label || session.machine_id} (${MAX_QUEUE_PER_MACHINE} commands pending).`);
  }

  const inReplyTo =
    parentText !== undefined
      ? parentText?.trim().slice(0, IN_REPLY_TO_MAX_CHARS) || undefined
      : threadTs
        ? await fetchParentText(ws, channelId, threadTs)
        : undefined;
  const meta: Record<string, unknown> = {};
  if (questionRequestId) meta.questionRequestId = questionRequestId;
  meta.senderId = event.user;
  if (Array.isArray(event.attachments) && event.attachments.some((a) => a?.is_share === true)) meta.forwarded = true;
  if (inReplyTo) meta.inReplyTo = inReplyTo;
  const metadataJson = JSON.stringify(meta);

  const touch = db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(Date.now(), sessionId);
  const base = {
    machineId: session.machine_id,
    sessionId,
    command,
    chatId: chat,
    commandType: "execute",
    metadataJson,
    messageThreadId: replyHandle,
  };

  if (file) {
    const picked = pickSlackFile(file);
    if (!picked) return refuse("Could not download file from Slack");
    if (picked.size > MAX_FILE_SIZE) {
      return refuse(`File too large (${(picked.size / 1024 / 1024).toFixed(1)}MB, max 20MB)`);
    }
    if (!(await markSeen(db, eventId))) return OK();
    // The download can take longer than Slack's 3 s ack allows, so it runs after the response.
    // The event is already marked seen, so a failure here is reported in the channel instead.
    const work = relayFileAndQueue(env, db, ws, replyHandle, picked, file.id ?? "f", base, touch);
    if (waitUntil) waitUntil(work);
    else await work;
    return OK();
  }

  const { statement } = commandInsertStatement(db, base);
  try {
    await db.batch([seenInsert(db, eventId), touch, statement]);
  } catch (err) {
    if (isSeenConflict(err)) return OK(); // a retry of an event already queued
    throw err; // 500: Slack retries, and the batch wrote nothing
  }
  return OK();
}

async function relayFileAndQueue(
  env: Env,
  db: D1Database,
  ws: SlackWorkspace,
  replyHandle: number | null,
  picked: { url: string; mime: string; filename: string; size: number },
  fileId: string,
  base: Parameters<typeof queueCommand>[1],
  touch: D1PreparedStatement,
): Promise<void> {
  const say = (text: string) => (replyHandle !== null ? postInChannel(env, db, ws, replyHandle, text) : Promise.resolve());
  try {
    const dl = await downloadSlackFile(ws.botToken, picked.url, picked.mime === "text/html", {
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!dl.ok || !dl.body) {
      console.warn("[slack-inbound] file download failed", { error: dl.ok ? "no_body" : dl.error });
      await say("Could not download file from Slack");
      return;
    }
    const safeId = fileId.replace(/[^A-Za-z0-9_-]/g, "");
    const key = `inbound/${Date.now()}-${safeId}/${picked.filename}`;
    try {
      await env.MEDIA.put(key, dl.body, {
        httpMetadata: { contentType: picked.mime },
        customMetadata: { filename: picked.filename },
      });
    } catch (err) {
      console.warn("[slack-inbound] media storage failed", { err: String(err) });
      await say("Media storage failed, please try again");
      return;
    }
    const mediaRef: MediaRef = { key, mime: picked.mime, filename: picked.filename, size: picked.size };
    await touch.run();
    const commandId = await queueCommand(db, { ...base, mediaJson: JSON.stringify(mediaRef) });
    if (commandId === null) await say(`Queue full (${MAX_QUEUE_PER_MACHINE} commands pending).`);
  } catch (err) {
    console.error("[slack-inbound] file relay failed", { err: String(err) });
    await say("Could not deliver that file, please try again");
  }
}

// ─── slash commands ────────────────────────────────────────────────────────

type Context =
  | { kind: "none" }
  | { kind: "no_row"; sessionId: string }
  | { kind: "found"; sessionId: string; machineId: string; label: string | null };

async function channelContext(db: D1Database, chat: string, handle: number | null): Promise<Context> {
  if (handle === null) return { kind: "none" };
  const topic = await getByThread(db, chat, handle);
  if (!topic) return { kind: "none" };
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(topic.session_id)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) return { kind: "no_row", sessionId: topic.session_id };
  return { kind: "found", sessionId: topic.session_id, machineId: session.machine_id, label: session.label };
}

type Resolved = { sessionId: string; machineId: string; label: string | null };

const NO_CHANNEL_SESSION =
  "This channel has no session. Run the command in a session's channel, or name the session: /kill <session-id>.";

/** The channel's session, ready for a command, or the refusal to answer with. */
async function contextSession(db: D1Database, ctx: Context): Promise<Resolved | string> {
  if (ctx.kind === "none") return NO_CHANNEL_SESSION;
  if (ctx.kind === "no_row") return `Session \`${ctx.sessionId}\` not found.`;
  if (!(await isMachineRecent(db, ctx.machineId))) return `${ctx.machineId} is not recently seen.`;
  return ctx;
}

/** An explicit `<session-id>` (full or unique prefix), ready for a command, or the refusal. */
async function namedSession(db: D1Database, ref: string): Promise<Resolved | string> {
  const found = await resolveSessionRef(db, ref);
  if (found.kind === "none") return noSessionRefText(ref);
  if (found.kind === "ambiguous") return ambiguousRefText(ref, found.candidates);
  if (!(await isMachineRecent(db, found.machineId))) return `${found.machineId} is not recently seen.`;
  return found;
}

async function handleCommand(db: D1Database, env: Env, ws: SlackWorkspace, raw: string): Promise<Response> {
  const form = new URLSearchParams(raw);
  if (teamMismatch(ws, form.get("team_id"), form.get("api_app_id"))) {
    console.warn("[slack-inbound] command for another team or app refused");
    return new Response("Forbidden", { status: 403 });
  }
  if (form.get("user_id") !== ws.ownerUserId) return OK(); // owner only, silently (D5)

  const name = form.get("command") ?? "";
  const channelId = form.get("channel_id") ?? "";
  // `/rename` is a Slack built-in, so the app's rename command is `/retitle` (spec §2).
  const cmdName = name === "/retitle" ? "/rename" : name;
  const args = slackTextToPlain(form.get("text") ?? "").trim();
  const parsed = parseChatCommand(args ? `${cmdName} ${args}` : cmdName);
  if (!parsed || !channelId) return commandReply(`Unknown command ${name}.`, false);

  const chat = slackChatId(ws);
  const handle = await channelHandle(db, ws, channelId, true);
  const queue = async (opts: {
    machineId: string;
    sessionId: string | null;
    command: string;
    commandType: string;
    label: string | null;
    directory?: string | null;
    metadataJson?: string | null;
  }): Promise<boolean> =>
    (await queueCommand(db, { ...opts, chatId: chat, messageThreadId: handle })) !== null;
  const queueFull = (who: string) => commandReply(`Queue full for ${who} (${MAX_QUEUE_PER_MACHINE} commands pending).`, false);

  if (parsed.kind === "usage") return commandReply(SESSION_COMMAND_USAGE_TEXT, false);

  if (parsed.kind === "launch") {
    const launch = parsed.launch;
    if (launch.kind === "usage") {
      return commandReply(launch.reason ? `${launch.reason}\n\n${LAUNCH_USAGE_TEXT}` : LAUNCH_USAGE_TEXT, false);
    }
    const { machineId, directory, prompt, tag, backend } = launch;
    if (!(await isMachineRecent(db, machineId))) return commandReply(`${machineId} is not recently seen.`, false);
    // Tag inheritance from the channel's session, as Telegram does from the topic (see webhook.ts).
    let inheritFromSessionId: string | undefined;
    if (!tag) {
      const ctx = await channelContext(db, chat, handle);
      if (ctx.kind === "found" && ctx.machineId === machineId) inheritFromSessionId = ctx.sessionId;
    }
    const ok = await queue({
      machineId,
      sessionId: null,
      command: prompt,
      commandType: "launch",
      label: null,
      directory,
      metadataJson:
        tag || backend || inheritFromSessionId
          ? JSON.stringify({
              ...(tag ? { tag } : {}),
              ...(backend ? { backend } : {}),
              ...(inheritFromSessionId ? { inheritFromSessionId } : {}),
            })
          : null,
    });
    if (!ok) return queueFull(machineId);
    const tagNote = tag
      ? `, tag ${tag}`
      : inheritFromSessionId
        ? `, will inherit ${inheritFromSessionId}'s session tag if it has one (a coordinator's program)`
        : "";
    return commandReply(`Launching on ${machineId} in ${directory}${tagNote}...`, true);
  }

  if (parsed.kind === "session") {
    const resolved =
      parsed.target !== undefined
        ? await namedSession(db, parsed.target)
        : await contextSession(db, await channelContext(db, chat, handle));
    if (typeof resolved === "string") return commandReply(resolved, false);
    const ok = await queue({
      machineId: resolved.machineId,
      sessionId: resolved.sessionId,
      command: parsed.arg,
      commandType: parsed.type,
      label: resolved.label,
    });
    if (!ok) return queueFull(resolved.label || resolved.machineId);
    return commandReply(sessionCommandAck(parsed, resolved.sessionId, resolved.machineId), true);
  }

  if (parsed.kind === "rename") {
    if (!parsed.title) return commandReply("Usage: /retitle <new title>", false);
    const resolved = await contextSession(db, await channelContext(db, chat, handle));
    if (typeof resolved === "string") return commandReply(resolved, false);
    const topic = await getBySession(db, resolved.sessionId);
    if (!topic || topic.message_thread_id === null) return commandReply("This session has no channel to rename.", false);
    // Unlike Telegram's /rename, the ` · ~/dir` part is kept: on Slack it is the channel's topic line.
    const formatted = topicName(currentDirSuffix(topic), parsed.title);
    const edit = await editTopicName(db, env, topic, formatted);
    if (!edit.ok) return commandReply(`Failed to rename the channel of session \`${resolved.sessionId}\`.`, false);
    await db
      .prepare("UPDATE sessions SET label = ?, updated_at = ? WHERE session_id = ?")
      .bind(formatted, Date.now(), resolved.sessionId)
      .run();
    return commandReply(`Renamed session \`${resolved.sessionId}\` to "${formatted}".`, true);
  }

  // /tag. The channel's session decides which machine's backlog (oc-tags is per machine), as the
  // topic does on Telegram. `/tag <session-id> <tag>` also works where there is none (#alerts, a
  // named channel): the named session is then the context too (spec §5, "/tag works anywhere").
  const tagArgs = parsed.args;
  if (tagArgs.kind === "usage") return commandReply(tagArgs.message ?? TAG_USAGE_TEXT, false);
  const ctx = await channelContext(db, chat, handle);
  let resolved: Resolved | string;
  let targetSessionId: string | undefined;
  if (ctx.kind === "none" && tagArgs.kind === "set" && tagArgs.targetSessionId?.match(/^(?:ses|gse)_/)) {
    resolved = await namedSession(db, tagArgs.targetSessionId);
    if (typeof resolved !== "string") targetSessionId = resolved.sessionId;
  } else if (ctx.kind === "none") {
    resolved = "This channel has no session. Use /tag in a session's channel, or /tag <session-id> <tag>.";
  } else {
    resolved = await contextSession(db, ctx);
  }
  if (typeof resolved === "string") return commandReply(resolved, false);

  let commandType: string;
  let command = "";
  let metadataJson: string | null = null;
  let ack: string;
  if (tagArgs.kind === "top") {
    commandType = "tag_top";
    ack = `Listing untagged sessions on ${resolved.machineId}...`;
  } else if (tagArgs.kind === "list") {
    commandType = "tag_list";
    ack = `Listing tags on ${resolved.machineId}...`;
  } else {
    commandType = "tag_set";
    command = tagArgs.tag;
    const target = targetSessionId ?? tagArgs.targetSessionId ?? resolved.sessionId;
    metadataJson = JSON.stringify({ targetSessionId: target });
    ack = `Tagging session ${target} as ${tagArgs.tag} on ${resolved.machineId}...`;
  }
  const ok = await queue({
    machineId: resolved.machineId,
    sessionId: resolved.sessionId,
    command,
    commandType,
    label: resolved.label,
    metadataJson,
  });
  if (!ok) return queueFull(resolved.label || resolved.machineId);
  return commandReply(ack, true);
}

// ─── interactivity ─────────────────────────────────────────────────────────

interface BlockActionsPayload {
  type?: string;
  api_app_id?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string };
  actions?: Array<{ value?: string; url?: string }>;
}

async function handleInteractivity(db: D1Database, env: Env, ws: SlackWorkspace, raw: string): Promise<Response> {
  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "") as BlockActionsPayload;
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") return Response.json({ error: "invalid payload" }, { status: 400 });
  if (teamMismatch(ws, payload.team?.id, payload.api_app_id)) {
    console.warn("[slack-inbound] interaction for another team or app refused");
    return new Response("Forbidden", { status: 403 });
  }
  if (payload.type !== "block_actions") return OK();
  if (payload.user?.id !== ws.ownerUserId) return OK(); // owner only, silently (D5)

  // A URL button's press is reported too; Slack has already opened the link, so it is acked and ignored.
  const value = payload.actions?.[0]?.value;
  if (typeof value !== "string" || !value.startsWith("cmd:")) return OK();
  const channelId = payload.channel?.id ?? payload.container?.channel_id;
  if (typeof channelId !== "string" || !channelId) return OK();

  // Exactly Telegram's callback_data: cmd:TOKEN:ACTION (resolveCallbackSession in webhook.ts).
  const parts = value.split(":");
  if (parts.length < 3) return OK();
  const token = parts[1]!;
  const action = parts.slice(2).join(":");

  const chat = slackChatId(ws);
  const mapping = await lookupMessageByToken(db, token, chat);
  if (!mapping) {
    await postEphemeral(ws, channelId, "Session expired");
    return OK();
  }
  if (action.length > MAX_COMMAND_LENGTH) return OK();
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(mapping.session_id)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) {
    await postEphemeral(ws, channelId, "Session not found");
    return OK();
  }
  await db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").bind(Date.now(), mapping.session_id).run();

  const questionRequestId = parseQuestionRequestId(mapping.notification_id);
  const handle = await channelHandle(db, ws, channelId, true);
  // Like a Telegram button, no sender id: a backend that requires one refuses it (fails closed).
  const commandId = await queueCommand(db, {
    machineId: session.machine_id,
    sessionId: mapping.session_id,
    command: action,
    chatId: chat,
    metadataJson: questionRequestId ? JSON.stringify({ questionRequestId }) : null,
    messageThreadId: handle,
  });
  if (commandId === null) {
    await postEphemeral(ws, channelId, `Queue full for ${session.label || session.machine_id}.`);
  }
  return OK();
}

/**
 * Session-free sends: `POST /messages/send` and `POST /topics/unpin` (chat-transport phase 1,
 * bead pigeon-lenr.1; design docs/plans/2026-11-20-telegram-single-egress-design.md).
 *
 * These exist so the daemon never has to call Telegram itself for command replies and
 * operational alerts. The worker's TelegramClient is then the only normal caller of the Bot
 * API, and replacing Telegram means replacing it.
 *
 * THE RESULT CONTRACT is what the daemon's alert fallback hinges on, so it is narrower than
 * `/notifications/send`'s on purpose:
 *
 *   200 {ok:true, ...}                                   posted
 *   200 {ok:false, telegram:{status:400, description}}   Telegram refused the payload; nothing
 *                                                        was posted. "thread not found" lands
 *                                                        here, description intact, so the
 *                                                        daemon's /alert ladder still sees it.
 *   200 {ok:false, telegram:{status:429, retryAfter}}    rate limited
 *   403 {error:"chat_not_allowed"}                       chatId not in ALLOWED_CHAT_IDS
 *   502 {ok:false, error, telegram?}                     the worker could not deliver: any other
 *                                                        Telegram status (401/403/404 mean the
 *                                                        worker's own bot token is broken), an
 *                                                        unparseable Telegram body, a timeout, a
 *                                                        transport error.
 *
 * Only a Telegram answer that a different sender would get too rides in a 200. Everything that
 * is specific to this worker being broken is non-2xx, which is the daemon's cue to send direct.
 *
 * Unlike `/notifications/send`, nothing here writes a `messages` row: these posts are not
 * reply-routable, as they were not when the daemon sent them itself. Nor is the topics-enabled
 * gate applied: a caller that names a thread gets that thread, as before.
 */

import { authenticate } from "./credentials";
import { unauthorized } from "./auth";
import { isAllowedChatId } from "./notifications";
import { createTelegramClient, type TgResult } from "./telegram";

/** Default bound on the Telegram call. Below the daemon's ~5 s worker leg for alerts. */
export const MESSAGES_SEND_DEFAULT_TIMEOUT_MS = 4_000;
/** Ceiling on a caller-supplied `timeoutMs`. Command replies ask for long bounds; not unbounded. */
export const MESSAGES_SEND_MAX_TIMEOUT_MS = 30_000;

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  return body as Body;
}

function parseChatId(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v) || null : null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function parseTimeout(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (!isPositiveInt(v) || v > MESSAGES_SEND_MAX_TIMEOUT_MS) return null;
  return v;
}

type UrlButtons = Array<Array<{ text: string; url: string }>>;

function parseUrlButtons(v: unknown): UrlButtons | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  for (const row of v) {
    if (!Array.isArray(row)) return null;
    for (const b of row) {
      if (!b || typeof b !== "object") return null;
      const { text, url } = b as Record<string, unknown>;
      if (typeof text !== "string" || typeof url !== "string") return null;
    }
  }
  return v as UrlButtons;
}

function descriptionOf(res: { response?: unknown; description?: string }): string | undefined {
  if (typeof res.description === "string") return res.description;
  const d = (res.response as { description?: unknown } | undefined)?.description;
  return typeof d === "string" ? d : undefined;
}

/** Map a client result onto the contract above. `okBody` is the success payload. */
function toResponse<T>(res: TgResult<T>, okBody: (result: T) => Record<string, unknown>): Response {
  if (res.ok) return Response.json({ ok: true, ...okBody(res.result) });

  const description = descriptionOf(res);
  const withDescription = description !== undefined ? { description } : {};

  if (res.kind === "rate_limited") {
    return Response.json({ ok: false, telegram: { status: 429, retryAfter: res.retryAfter, ...withDescription } });
  }
  if (res.kind === "thread_not_found" || res.kind === "topic_not_modified" || (res.kind === "error" && res.errorCode === 400)) {
    return Response.json({ ok: false, telegram: { status: 400, ...withDescription } });
  }
  const status = res.kind === "error" ? res.errorCode : undefined;
  return Response.json(
    {
      ok: false,
      error: status === undefined ? "telegram_unparseable" : "telegram_error",
      ...(status !== undefined ? { telegram: { status, ...withDescription } } : {}),
    },
    { status: 502 },
  );
}

/**
 * Run one bounded Telegram call. A timeout or transport error becomes a 502 rather than
 * escaping: `callTelegram` throws on both, and an unhandled throw would be a 500 the daemon
 * cannot tell from a worker bug.
 */
async function bounded(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The signal alone bounds only a fetch that honours it; racing an explicit deadline bounds
  // it either way (the daemon learned this as pigeon-wfj1).
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("deadline"));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  try {
    const inFlight = run(controller.signal);
    inFlight.catch(() => {});
    return await Promise.race([inFlight, deadline]);
  } catch (err) {
    const error = controller.signal.aborted
      ? `telegram call timed out after ${timeoutMs}ms`
      : `telegram call failed: ${err instanceof Error ? err.message : String(err)}`;
    console.warn("[worker] session-free telegram call failed", { error });
    return Response.json({ ok: false, error }, { status: 502 });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handleSendMessage(env: Env, request: Request): Promise<Response> {
  if (!(await authenticate(request, env))) return unauthorized();
  const body = await readBody(request);
  if (body instanceof Response) return body;

  const chatId = parseChatId(body.chatId);
  const text = typeof body.text === "string" ? body.text : "";
  const urlButtons = parseUrlButtons(body.urlButtons);
  const timeoutMs = parseTimeout(body.timeoutMs);
  const thread = body.messageThreadId;
  const entities = body.entities;
  if (
    !chatId ||
    !text ||
    urlButtons === null ||
    timeoutMs === null ||
    (thread !== undefined && !isPositiveInt(thread)) ||
    (entities !== undefined && !Array.isArray(entities))
  ) {
    return Response.json(
      { error: "chatId and text are required; messageThreadId, entities, urlButtons and timeoutMs must be well-formed" },
      { status: 400 },
    );
  }
  if (!isAllowedChatId(chatId, env)) {
    return Response.json({ error: "chat_not_allowed" }, { status: 403 });
  }

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  return bounded(timeoutMs ?? MESSAGES_SEND_DEFAULT_TIMEOUT_MS, async (signal) =>
    toResponse(
      await tg.sendMessage({
        chatId,
        text,
        ...(entities !== undefined ? { entities: entities as unknown[] } : {}),
        ...(thread !== undefined ? { messageThreadId: thread as number } : {}),
        ...(urlButtons && urlButtons.length > 0 ? { replyMarkup: { inline_keyboard: urlButtons } } : {}),
        signal,
      }),
      (r) => ({ messageId: r.message_id }),
    ),
  );
}

export async function handleUnpinTopic(env: Env, request: Request): Promise<Response> {
  if (!(await authenticate(request, env))) return unauthorized();
  const body = await readBody(request);
  if (body instanceof Response) return body;

  const chatId = parseChatId(body.chatId);
  const thread = body.messageThreadId;
  if (!chatId || !isPositiveInt(thread)) {
    return Response.json({ error: "chatId and a positive messageThreadId are required" }, { status: 400 });
  }
  if (!isAllowedChatId(chatId, env)) {
    return Response.json({ error: "chat_not_allowed" }, { status: 403 });
  }

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  return bounded(MESSAGES_SEND_DEFAULT_TIMEOUT_MS, async (signal) =>
    toResponse(await tg.unpinAllForumTopicMessages({ chatId, messageThreadId: thread, signal }), () => ({})),
  );
}

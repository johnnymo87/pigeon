/**
 * The Slack Web API client (bead pigeon-4ogz.3; plan docs/plans/2026-11-20-slack-outbound-plan.md,
 * "Slack API client"). The worker's only door to Slack, as `src/telegram.ts` is its only door to
 * Telegram: the egress guard test (`test/slack-egress.test.ts`) fails if Slack's host appears in
 * any other source file. A new call belongs here, as a function, so it is timed, logged and
 * error-mapped like the rest.
 *
 * Results are mapped onto `TgResult` because the worker's seam (`./chat/transport.ts`) is
 * Telegram-shaped. Every failure carries a `response` of
 * `{ok:false, error, errorClass, error_code, description}`, which `getTelegramErrorDetails`
 * returns as the 502 body's `details`: a legacy daemon that reads `details.error_code` keeps
 * working, and a new one can read `errorClass`. The classes:
 *
 *   rate_limited      HTTP 429. The outbox pauses for `retryAfter`.
 *   conversation_gone the channel is missing or archived. Permanent for that conversation.
 *   rejected_format   Slack refused the payload. Retrying the same payload cannot help.
 *   upstream          everything else, including any error nobody listed. Transient: it is
 *                     retried, never relocated, because misjudging a permanent failure as
 *                     transient costs a delayed message and the reverse misfiles one (pigeon-bit4).
 */
import type { TgResult } from "./telegram";

const SLACK_API = "https://slack.com/api/";

export type SlackErrorClass = "rate_limited" | "conversation_gone" | "rejected_format" | "upstream";

/** A parsed Slack Web API success body. Callers read what they need (`ts`, `channel`, ...). */
export type SlackBody = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CallSlackOptions {
  /** Aborts the call (the fetch rejects). Callers that bound a request use this. */
  signal?: AbortSignal;
  /** Replaces the global `fetch` (tests, and callers that inject a transport). */
  fetchFn?: typeof fetch;
  /**
   * Treat a 429 as a transient failure of this one operation instead of `rate_limited`.
   * Defaults to true for the methods in `TRANSIENT_429_METHODS`, false otherwise.
   */
  rateLimitIsTransient?: boolean;
}

/**
 * Methods whose 429 must NOT pause the daemon's whole outbox. These create or revive a
 * conversation, and their limits are tight (Slack allows conversations.create about 20 a
 * minute), so a burst of new sessions hits them while ordinary posting is fine. Reporting that
 * as `rate_limited` would stall every notification for `retryAfter`; as a 503 `upstream` the
 * worker turns it into a `topic_unavailable` hold on that one session, which is what a failed
 * topic create already does.
 */
const TRANSIENT_429_METHODS = new Set(["conversations.create", "conversations.rename", "conversations.unarchive"]);

const GONE_ERRORS = new Set(["channel_not_found", "is_archived"]);

const REJECTED_ERRORS = new Set([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_too_long",
  "msg_blocks_too_long",
  "invalid_attachments",
  "no_text",
  "too_many_attachments",
  "markdown_text_conflict",
]);

const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** A Slack call at or above this many milliseconds is logged at `warn` (same rule as Telegram). */
export const SLACK_SLOW_CALL_MS = 5_000;

/**
 * Records how long one Slack call took. Logs every call so the healthy baseline exists beside the
 * slow tail. The method name is logged; the token and any upload URL (which is a bearer by
 * itself) are not.
 */
export function logSlackCall(method: string, elapsedMs: number, outcome: string): void {
  const payload = { method, elapsedMs, outcome };
  if (elapsedMs >= SLACK_SLOW_CALL_MS) {
    console.warn("[worker] slow slack call", payload);
  } else {
    console.log("[worker] slack call", payload);
  }
}

/** The `errorClass` Slack mapping put on a failure's response, if there is one. */
export function errorClassOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as { errorClass?: unknown }).errorClass;
  return typeof value === "string" ? value : undefined;
}

/** The error class of a failed result, or undefined for a success or a non-Slack failure. */
export function slackErrorClass(result: TgResult<unknown>): string | undefined {
  return result.ok ? undefined : errorClassOf(result.response);
}

/** A conversation's permalink in a workspace: `https://<domain>.slack.com/archives/<channel id>`. */
export function slackArchiveUrl(domain: string, channelId: string): string {
  return `https://${domain}.slack.com/archives/${channelId}`;
}

function encodeArgs(args: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return params;
}

function retryAfterSeconds(res: Response): number {
  const header = res.headers.get("retry-after");
  const n = header === null ? Number.NaN : Number(header);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETRY_AFTER_SECONDS;
}

function failureResponse(error: string, errorClass: SlackErrorClass, errorCode: number, description: string) {
  return { ok: false as const, error, errorClass, error_code: errorCode, description };
}

function upstream<T>(error: string, errorCode = 502): TgResult<T> {
  const description = `slack error: ${error}`;
  return {
    ok: false,
    kind: "error",
    errorCode,
    description,
    response: failureResponse(error, "upstream", errorCode, description),
  };
}

function rateLimited<T>(error: string, retryAfter: number): TgResult<T> {
  return {
    ok: false,
    kind: "rate_limited",
    retryAfter,
    response: failureResponse(error, "rate_limited", 429, `slack rate limited: ${error}`),
  };
}

/** Maps one Slack response (status + parsed body, or null when unparseable) onto a TgResult. */
async function mapResponse<T>(res: Response, method: string, rateLimitIsTransient: boolean): Promise<TgResult<T>> {
  const data = (await res.json().catch(() => null)) as SlackBody | null;
  const body = data !== null && typeof data === "object" && !Array.isArray(data) ? data : null;
  const error = typeof body?.error === "string" ? body.error : undefined;

  if (res.status === 429 || error === "ratelimited") {
    if (rateLimitIsTransient) return upstream(error ?? "ratelimited", 503);
    return rateLimited(error ?? "ratelimited", retryAfterSeconds(res));
  }

  if (body !== null && body.ok === true && res.status < 500) {
    return { ok: true, result: body as T };
  }

  if (res.status >= 500) return upstream(error ?? `http_${res.status}`);

  if (body === null) {
    // A 200 whose body will not parse: Slack may well have processed the call, so this is
    // retried like any transient fault (the duplicate is the better-placed risk, as for Telegram).
    console.warn("[worker] slack unparseable response", { method, status: res.status });
    return upstream("unparseable_response");
  }

  if (error !== undefined && GONE_ERRORS.has(error)) {
    const description = `thread not found: ${error}`;
    return {
      ok: false,
      kind: "thread_not_found",
      response: failureResponse(error, "conversation_gone", 400, description),
    };
  }

  if (error !== undefined && REJECTED_ERRORS.has(error)) {
    const description = `slack rejected the message: ${error}`;
    return {
      ok: false,
      kind: "error",
      errorCode: 400,
      description,
      response: failureResponse(error, "rejected_format", 400, description),
    };
  }

  return upstream(error ?? "unknown_error");
}

/**
 * The single place a Slack Web API call is made, so the timing cannot be bypassed.
 *
 * Same contract as `callTelegram`: the clock is in a `finally` so a call that throws is timed
 * too, `elapsedMs` covers reading the body, and a thrown fetch (a transport fault, or an abort)
 * propagates for the caller's boundary to deal with. A non-throwing failure is returned, mapped.
 */
export async function callSlack<T = SlackBody>(
  token: string,
  method: string,
  args: Record<string, unknown>,
  opts: CallSlackOptions = {},
): Promise<TgResult<T>> {
  const startedAt = Date.now();
  let outcome = "threw";
  try {
    const doFetch = opts.fetchFn ?? ((url, init) => fetch(url, init));
    const res = await doFetch(`${SLACK_API}${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: encodeArgs(args).toString(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const result = await mapResponse<T>(res, method, opts.rateLimitIsTransient ?? TRANSIENT_429_METHODS.has(method));
    outcome = result.ok ? "ok" : result.kind;
    return result;
  } finally {
    logSlackCall(method, Date.now() - startedAt, outcome);
  }
}

/** The only host an inbound file is fetched from: the bot token is sent with the request. */
const SLACK_FILES_HOST = "files.slack.com";

/** True for an `https://files.slack.com/...` URL, the only kind `downloadSlackFile` will fetch. */
export function isSlackFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === SLACK_FILES_HOST;
  } catch {
    return false;
  }
}

export interface DownloadSlackFileOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

/**
 * Fetches an inbound file's bytes (`url_private_download`) with the bot token (bead
 * pigeon-4ogz.4, spec §5 "Files"). The URL comes from a signed event, but it still has to be a
 * `files.slack.com` URL: anything else would be handed the bot token. Slack answers a request it
 * will not serve (a missing `files:read` scope, say) with a 200 HTML login page, so an HTML body is
 * a failure unless the file itself is HTML.
 */
export async function downloadSlackFile(
  token: string,
  url: string,
  expectHtml: boolean,
  opts: DownloadSlackFileOptions = {},
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }> {
  if (!isSlackFileUrl(url)) return { ok: false, error: "not_a_slack_file_url" };
  const startedAt = Date.now();
  let outcome = "threw";
  try {
    const doFetch = opts.fetchFn ?? ((u, init) => fetch(u, init));
    // Redirects are not followed: the bearer token must not travel to wherever one points.
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      outcome = `http_${res.status}`;
      return { ok: false, error: outcome };
    }
    if (!expectHtml && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
      outcome = "html_instead_of_file";
      return { ok: false, error: outcome };
    }
    const bytes = await res.arrayBuffer();
    outcome = "ok";
    return { ok: true, bytes };
  } finally {
    logSlackCall("file_download", Date.now() - startedAt, outcome);
  }
}

export interface UploadToSlackOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

/**
 * Step 2 of Slack's external file upload: POST the bytes to the `upload_url` that
 * `files.getUploadURLExternal` returned. Not a Web API method, so no token and no JSON body: Slack
 * answers plain text (`OK - <length>`) and the URL itself is the credential, so it is never logged.
 */
export async function uploadToSlack(
  uploadUrl: string,
  blob: Blob,
  opts: UploadToSlackOptions = {},
): Promise<TgResult<true>> {
  const startedAt = Date.now();
  let outcome = "threw";
  try {
    const doFetch = opts.fetchFn ?? ((url, init) => fetch(url, init));
    const res = await doFetch(uploadUrl, {
      method: "POST",
      body: blob,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let result: TgResult<true>;
    if (res.status === 429) {
      result = rateLimited("ratelimited", retryAfterSeconds(res));
    } else if (res.ok) {
      result = { ok: true, result: true };
    } else {
      result = upstream(`upload_http_${res.status}`);
    }
    outcome = result.ok ? "ok" : result.kind;
    return result;
  } finally {
    logSlackCall("upload", Date.now() - startedAt, outcome);
  }
}

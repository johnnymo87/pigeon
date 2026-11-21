/**
 * HTTP client for the worker's session-free send route, `POST /messages/send` (chat-transport
 * phase 1, pigeon-lenr). The wire shapes are the worker's (`packages/worker/src`), which is the
 * source of truth. Several wire values still carry Telegram's old names (`telegram:{status,..}`,
 * `/^telegram call /`): they are kept on purpose, so a daemon and a worker of different ages
 * still read each other.
 *
 * Every answer is reduced to one of three behaviours, and the whole point of the route's
 * shape is that the daemon can tell them apart:
 *
 *  - `sent`: posted.
 *  - `chat_rejected`: the chat itself said no (400, 429), relayed in a 200. Nothing was
 *    posted, and the worker is healthy, so a caller with a fallback must NOT fall back: the
 *    direct path would get the same answer.
 *  - `worker_failed`: anything else -- the worker is broken, absent (a 404 from a worker
 *    older than the route), misconfigured (403 `chat_not_allowed`), its own provider token is
 *    broken (502 carrying a provider 401/403/404), or it did not answer in time. This is the
 *    case a fallback exists for.
 *
 * Never throws from `sendMessage`, and is bounded even against a fetch that ignores its
 * AbortSignal or a body that stalls after the headers (the pigeon-wfj1 lesson): the alert
 * path awaits this inside the drainer and the watchdog.
 */

import type { ChatEntity } from "../chat-message";

export interface WorkerMessageBody {
  /**
   * Absent: the machine's own `#alerts`. Set it only to an address the worker handed out (a
   * named topic's returned `slack:` chat).
   */
  chatId?: string;
  text: string;
  entities?: ChatEntity[];
  messageThreadId?: number;
  urlButtons?: Array<Array<{ text: string; url: string }>>;
  /** The worker's own abort on its chat call. Absent: the worker's default (~4s). */
  timeoutMs?: number;
  /**
   * Ask for the owner mention (Slack only, still gated by the worker's `SLACK_NOTIFY_OWNER`;
   * pigeon-4ogz.5). Sent only when true.
   */
  notifyOwner?: boolean;
}

export type WorkerSendOutcome =
  | { kind: "sent"; messageId?: number }
  | {
      kind: "chat_rejected";
      status: 400 | 429;
      description?: string;
      retryAfter?: number;
      /** The worker's top-level `errorClass`, present on Slack responses only (pigeon-4ogz.5). */
      errorClass?: string;
    }
  | {
      kind: "worker_failed";
      /** Human-readable, for logs and the alert's `sent direct; worker: <reason>` suffix. */
      reason: string;
      /** Stable and low-cardinality, for throttling one health alert per kind of failure. */
      key: string;
      /**
       * `chat_unreachable`: the worker answered but could not get a reply from the chat
       * in time (its own abort, or a transport error to the chat). The worker itself is
       * probably fine. `worker`: everything else.
       */
      cause: "worker" | "chat_unreachable";
      status?: number;
    };

export interface WorkerMessageClientConfig {
  workerUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

class Timeout extends Error {}

export class WorkerMessageClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: WorkerMessageClientConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Runs `fn` (request AND body read) under one hard deadline. The AbortSignal alone bounds
   * only a fetch that honours it; the race bounds it either way.
   */
  private async bounded<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Timeout(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    deadline.catch(() => {});
    try {
      const work = fn(controller.signal);
      work.catch(() => {});
      return await Promise.race([work, deadline]);
    } catch (err) {
      if (controller.signal.aborted) throw new Timeout(`timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; ok: boolean; parsed: unknown; parseable: boolean }> {
    return this.bounded(timeoutMs, async (signal) => {
      const res = await this.fetchFn(`${this.config.workerUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let parsed: unknown = undefined;
      let parseable = false;
      try {
        parsed = JSON.parse(text);
        parseable = true;
      } catch {
        // classified by the caller
      }
      return { status: res.status, ok: res.ok, parsed, parseable };
    });
  }

  async sendMessage(body: WorkerMessageBody, opts: { timeoutMs: number }): Promise<WorkerSendOutcome> {
    const wire: Record<string, unknown> = { text: body.text };
    if (body.chatId !== undefined) wire.chatId = body.chatId;
    if (body.entities && body.entities.length > 0) wire.entities = body.entities;
    if (body.messageThreadId !== undefined) wire.messageThreadId = body.messageThreadId;
    if (body.urlButtons && body.urlButtons.length > 0) wire.urlButtons = body.urlButtons;
    if (body.timeoutMs !== undefined) wire.timeoutMs = body.timeoutMs;
    if (body.notifyOwner === true) wire.notifyOwner = true;

    let res: Awaited<ReturnType<WorkerMessageClient["post"]>>;
    try {
      res = await this.post("/messages/send", wire, opts.timeoutMs);
    } catch (err) {
      if (err instanceof Timeout) return { kind: "worker_failed", reason: err.message, key: "timeout", cause: "worker" };
      return { kind: "worker_failed", reason: `transport error: ${errText(err)}`, key: "transport", cause: "worker" };
    }

    const obj = isObject(res.parsed) ? res.parsed : undefined;
    // `obj.telegram` is the worker's wire name for the provider's answer ({status, description,
    // retryAfter}); it is kept so daemons and workers of different ages still read each other.
    const provider = obj && isObject(obj.telegram) ? obj.telegram : undefined;
    const providerStatus = provider && typeof provider.status === "number" ? provider.status : undefined;
    const providerDesc = provider && typeof provider.description === "string" ? provider.description : undefined;
    const errorClass = obj && typeof obj.errorClass === "string" && /^[a-z_]{1,40}$/.test(obj.errorClass)
      ? obj.errorClass
      : undefined;

    if (res.status === 200) {
      if (!obj || typeof obj.ok !== "boolean") {
        return {
          kind: "worker_failed",
          reason: res.parseable ? "200 with an unexpected body" : "200 with a non-JSON body",
          key: "bad_body",
          cause: "worker",
          status: 200,
        };
      }
      if (obj.ok) {
        return typeof obj.messageId === "number" ? { kind: "sent", messageId: obj.messageId } : { kind: "sent" };
      }
      if (providerStatus === 400 || providerStatus === 429) {
        const out: WorkerSendOutcome = { kind: "chat_rejected", status: providerStatus };
        if (providerDesc !== undefined) out.description = providerDesc;
        if (provider && typeof provider.retryAfter === "number") out.retryAfter = provider.retryAfter;
        if (errorClass !== undefined) out.errorClass = errorClass;
        return out;
      }
      // ok:false that is not a documented rejection: not a verdict we can trust.
      return {
        kind: "worker_failed",
        reason: `200 ok:false${providerStatus !== undefined ? ` (chat ${providerStatus})` : ""}`,
        key: `ok_false${providerStatus !== undefined ? `:chat${providerStatus}` : ""}`,
        cause: "worker",
        status: 200,
      };
    }

    const error = obj && typeof obj.error === "string" ? obj.error : undefined;
    let reason = `HTTP ${res.status}`;
    let key = `http${res.status}`;
    let cause: "worker" | "chat_unreachable" = "worker";
    if (errorClass !== undefined) {
      // A Slack answer: its class is the low-cardinality part, the description the detail.
      reason += ` (Slack ${errorClass}${providerDesc ? `: ${sanitise(providerDesc, 80)}` : ""})`;
      key += `:${errorClass}`;
    } else if (providerStatus !== undefined) {
      reason += ` (chat ${providerStatus}${providerDesc ? `: ${providerDesc}` : ""})`;
      key += `:chat${providerStatus}`;
    } else if (error && /^[a-z_]{1,40}$/.test(error)) {
      // A slug: low-cardinality, safe as a throttle key.
      reason += ` ${error}`;
      key += `:${error}`;
    } else if (error) {
      // Free text (the worker's "telegram call timed out after 4000ms" / "telegram call
      // failed: ...", wire text kept as is). Kept in the reason, sanitised and short, but never in the key, which
      // must stay low-cardinality.
      reason += ` (${sanitise(error, 80)})`;
      if (res.status === 502 && /^telegram call /.test(error)) {
        key += ":chat_unreachable";
        cause = "chat_unreachable";
      }
    }
    return { kind: "worker_failed", reason, key, cause, status: res.status };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitise(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

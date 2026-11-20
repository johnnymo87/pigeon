/**
 * HTTP client for the worker's session-free Telegram routes, `POST /messages/send` and
 * `POST /topics/unpin` (chat-transport phase 1, pigeon-lenr; design
 * docs/plans/2026-11-20-telegram-single-egress-design.md). The wire shapes are the worker's
 * (`packages/worker/src`), which is the source of truth.
 *
 * Every answer is reduced to one of three behaviours, and the whole point of the route's
 * shape is that the daemon can tell them apart:
 *
 *  - `sent`: posted.
 *  - `telegram_rejected`: Telegram itself said no (400, 429), relayed in a 200. Nothing was
 *    posted, and the worker is healthy, so a caller with a fallback must NOT fall back: the
 *    direct path would get the same answer.
 *  - `worker_failed`: anything else -- the worker is broken, absent (a 404 from a worker
 *    older than the route), misconfigured (403 `chat_not_allowed`), its own Telegram token is
 *    broken (502 carrying a Telegram 401/403/404), or it did not answer in time. This is the
 *    case a fallback exists for.
 *
 * Never throws from `sendMessage`, and is bounded even against a fetch that ignores its
 * AbortSignal or a body that stalls after the headers (the pigeon-wfj1 lesson): the alert
 * path awaits this inside the drainer and the watchdog.
 */

import type { TgEntity } from "../telegram-message";

export interface WorkerMessageBody {
  chatId: string;
  text: string;
  entities?: TgEntity[];
  messageThreadId?: number;
  urlButtons?: Array<Array<{ text: string; url: string }>>;
  /** The worker's own abort on its Telegram call. Absent: the worker's default (~4s). */
  timeoutMs?: number;
}

export type WorkerSendOutcome =
  | { kind: "sent"; messageId?: number }
  | { kind: "telegram_rejected"; status: 400 | 429; description?: string; retryAfter?: number }
  | {
      kind: "worker_failed";
      /** Human-readable, for logs and the alert's `sent direct; worker: <reason>` suffix. */
      reason: string;
      /** Stable and low-cardinality, for throttling one health alert per kind of failure. */
      key: string;
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
    const wire: Record<string, unknown> = { chatId: body.chatId, text: body.text };
    if (body.entities && body.entities.length > 0) wire.entities = body.entities;
    if (body.messageThreadId !== undefined) wire.messageThreadId = body.messageThreadId;
    if (body.urlButtons && body.urlButtons.length > 0) wire.urlButtons = body.urlButtons;
    if (body.timeoutMs !== undefined) wire.timeoutMs = body.timeoutMs;

    let res: Awaited<ReturnType<WorkerMessageClient["post"]>>;
    try {
      res = await this.post("/messages/send", wire, opts.timeoutMs);
    } catch (err) {
      if (err instanceof Timeout) return { kind: "worker_failed", reason: err.message, key: "timeout" };
      return { kind: "worker_failed", reason: `transport error: ${errText(err)}`, key: "transport" };
    }

    const obj = isObject(res.parsed) ? res.parsed : undefined;
    const tg = obj && isObject(obj.telegram) ? obj.telegram : undefined;
    const tgStatus = tg && typeof tg.status === "number" ? tg.status : undefined;
    const tgDesc = tg && typeof tg.description === "string" ? tg.description : undefined;

    if (res.status === 200) {
      if (!obj || typeof obj.ok !== "boolean") {
        return {
          kind: "worker_failed",
          reason: res.parseable ? "200 with an unexpected body" : "200 with a non-JSON body",
          key: "bad_body",
          status: 200,
        };
      }
      if (obj.ok) {
        return typeof obj.messageId === "number" ? { kind: "sent", messageId: obj.messageId } : { kind: "sent" };
      }
      if (tgStatus === 400 || tgStatus === 429) {
        const out: WorkerSendOutcome = { kind: "telegram_rejected", status: tgStatus };
        if (tgDesc !== undefined) out.description = tgDesc;
        if (tg && typeof tg.retryAfter === "number") out.retryAfter = tg.retryAfter;
        return out;
      }
      // ok:false that is not a documented rejection: not a verdict we can trust.
      return {
        kind: "worker_failed",
        reason: `200 ok:false${tgStatus !== undefined ? ` (Telegram ${tgStatus})` : ""}`,
        key: `ok_false${tgStatus !== undefined ? `:tg${tgStatus}` : ""}`,
        status: 200,
      };
    }

    const error = obj && typeof obj.error === "string" ? obj.error : undefined;
    let reason = `HTTP ${res.status}`;
    let key = `http${res.status}`;
    if (tgStatus !== undefined) {
      reason += ` (Telegram ${tgStatus}${tgDesc ? `: ${tgDesc}` : ""})`;
      key += `:tg${tgStatus}`;
    } else if (error && /^[a-z_]{1,40}$/.test(error)) {
      reason += ` ${error}`;
      key += `:${error}`;
    }
    return { kind: "worker_failed", reason, key, status: res.status };
  }

  /** `POST /topics/unpin`. Best-effort: throws on any failure, for the caller to log. */
  async unpinTopic(body: { chatId: string; messageThreadId: number }, opts: { timeoutMs: number }): Promise<void> {
    let res: Awaited<ReturnType<WorkerMessageClient["post"]>>;
    try {
      res = await this.post("/topics/unpin", body, opts.timeoutMs);
    } catch (err) {
      throw new Error(`worker /topics/unpin ${err instanceof Timeout ? err.message : `failed: ${errText(err)}`}`);
    }
    if (!res.ok) throw new Error(`worker /topics/unpin returned ${res.status}`);
    if (isObject(res.parsed) && res.parsed.ok === false) {
      throw new Error("worker /topics/unpin answered ok:false");
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

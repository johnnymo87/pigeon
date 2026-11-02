import type { StorageDb } from "./storage/database.js";
import type { SessionRecord } from "./storage/types.js";
import { GOOSE_BACKEND_KIND } from "./goose/backend-kind.js";
import { isOpencodeRoutable } from "./routing/opencode-routable.js";
import { isPullBackend } from "./adapters/goose-pull.js";
import { parseTitle } from "./text.js";
import { TopicRenameError } from "./worker/poller.js";

export interface SessionRenameDeps {
  storage: StorageDb;
  renameGoose?: (session: SessionRecord, title: string) => Promise<void>;
  renameOpencode?: (session: SessionRecord, title: string) => Promise<void>;
  renameTopic?: (
    params: { sessionId: string; title: string; dir: string },
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  topicTimeoutMs?: number;
}

/**
 * `POST /sessions/:id/rename {title}`: backend, then the daemon's stored title, then the topic.
 *
 * Status codes, for callers deciding whether to retry:
 * - 400 bad title; 409 bound_session / pull_session / unsupported_backend: terminal.
 * - 404: the daemon has no row. Long-idle rows are reaped after SESSION_TTL_MS and come back on
 *   the session's next activity, so a caller about to message the session may retry after it.
 * - 503: this daemon has no goose or opencode backend configured. Terminal.
 * - 502 step "backend": nothing was changed; safe to retry.
 * - 502 step "topic": backend and stored title are renamed; `worker_status`/`worker_error`
 *   carry the worker's answer when it gave one (5xx retryable, 4xx terminal). Retrying the whole
 *   route is safe: every step is idempotent.
 *
 * Accepted residual: a rename that lands while a young session's FIRST turns are running can be
 * overwritten by the backend's own auto-namer (goose `maybe_update_name`, opencode `ensureTitle`
 * read the title at turn start). Renaming before sending the prompt, as `./sw message --title`
 * does, avoids it.
 */
export async function handleSessionRename(
  deps: SessionRenameDeps,
  sessionId: string,
  body: unknown,
): Promise<Response> {
  const rawTitle =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).title
      : undefined;
  const title = parseTitle(rawTitle);
  if (!title) {
    return Response.json({ error: "invalid_title" }, { status: 400 });
  }

  const session = deps.storage.sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  if (session.boundTopicKey) {
    return Response.json({ error: "bound_session" }, { status: 409 });
  }

  if (isPullBackend(session)) {
    return Response.json({ error: "pull_session" }, { status: 409 });
  }

  // Backend rename must happen first: backends cache their title and attach it
  // to subsequent /stop calls; updating DB alone would be reverted on the next turn.
  if (session.backendKind === GOOSE_BACKEND_KIND) {
    if (!deps.renameGoose) {
      return Response.json({ error: "goose rename not configured" }, { status: 503 });
    }
    try {
      await deps.renameGoose(session, title);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          step: "backend",
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 502 },
      );
    }
  } else if (isOpencodeRoutable(session)) {
    if (!deps.renameOpencode) {
      return Response.json({ error: "opencode rename not configured" }, { status: 503 });
    }
    try {
      await deps.renameOpencode(session, title);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          step: "backend",
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 502 },
      );
    }
  } else {
    return Response.json({ error: "unsupported_backend" }, { status: 409 });
  }

  deps.storage.sessions.setTitle(sessionId, title);

  let topic: Record<string, unknown>;
  if (!deps.renameTopic) {
    topic = { status: "skipped", reason: "no_worker" };
  } else {
    const timeoutMs = deps.topicTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const workerResult = await deps.renameTopic(
        { sessionId, title, dir: session.cwd ?? "" },
        controller.signal,
      );
      topic = {
        status: workerResult.renamed ? "renamed" : "unchanged",
        ...workerResult,
      };
    } catch (err) {
      return Response.json(
        {
          ok: false,
          step: "topic",
          backend: "renamed",
          stored: true,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof TopicRenameError
            ? { worker_status: err.status, worker_error: err.workerError }
            : {}),
        },
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Response.json({
    ok: true,
    title,
    backend: "renamed",
    stored: true,
    topic,
  });
}

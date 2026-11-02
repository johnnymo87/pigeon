import type { StorageDb } from "./storage/database.js";
import type { SessionRecord } from "./storage/types.js";
import { GOOSE_BACKEND_KIND } from "./goose/backend-kind.js";
import { isOpencodeRoutable } from "./routing/opencode-routable.js";
import { isPullBackend } from "./adapters/goose-pull.js";
import { parseTitle } from "./text.js";

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

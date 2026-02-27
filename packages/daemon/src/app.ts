import type { StorageDb } from "./storage/database";
import type { StopNotifier, QuestionNotifier } from "./notification-service";
import type { QuestionInfoData } from "./storage/types";

interface LegacySession {
  session_id: string;
  ppid: number | null;
  pid: number | null;
  start_time: number | null;
  cwd: string | null;
  label: string | null;
  notify: boolean;
  state: string;
  nvim_socket: string | null;
  backend_kind: string | null;
  backend_protocol_version: number | null;
  backend_endpoint: string | null;
  created_at: number;
  updated_at: number;
  last_seen: number;
  expires_at: number;
}

function toLegacySession(session: {
  sessionId: string;
  ppid: number | null;
  pid: number | null;
  startTime: number | null;
  cwd: string | null;
  label: string | null;
  notify: boolean;
  state: string;
  nvimSocket: string | null;
  backendKind: string | null;
  backendProtocolVersion: number | null;
  backendEndpoint: string | null;
  backendAuthToken: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeen: number;
  expiresAt: number;
}): LegacySession {
  return {
    session_id: session.sessionId,
    ppid: session.ppid,
    pid: session.pid,
    start_time: session.startTime,
    cwd: session.cwd,
    label: session.label,
    notify: session.notify,
    state: session.state,
    nvim_socket: session.nvimSocket,
    backend_kind: session.backendKind,
    backend_protocol_version: session.backendProtocolVersion,
    backend_endpoint: session.backendEndpoint,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    last_seen: session.lastSeen,
    expires_at: session.expiresAt,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  return (await request.json()) as Record<string, unknown>;
}

function maybeNumber(value: unknown): number | undefined {
  if (value) {
    return Number(value);
  }
  return undefined;
}

interface AppOptions {
  nowFn?: () => number;
  notifier?: StopNotifier & Partial<QuestionNotifier>;
  onSessionStart?: (sessionId: string, notify: boolean, label?: string | null) => Promise<void> | void;
  onSessionDelete?: (sessionId: string) => Promise<void> | void;
}

export function createApp(storage: StorageDb, options: AppOptions = {}) {
  const nowFn = options.nowFn ?? Date.now;
  const notifier = options.notifier;
  const onSessionStart = options.onSessionStart;
  const onSessionDelete = options.onSessionDelete;

  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, service: "pigeon-daemon" });
      }

      if (request.method === "POST" && url.pathname === "/session-start") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const existing = storage.sessions.get(sessionId);

        const nvim_socket = body.nvim_socket as string | undefined;

        storage.sessions.upsert(
          {
            sessionId,
            ppid: maybeNumber(body.ppid) ?? existing?.ppid,
            pid: maybeNumber(body.pid) ?? existing?.pid,
            startTime: maybeNumber(body.start_time) ?? existing?.startTime,
            cwd: (typeof body.cwd === "string" ? body.cwd : undefined) ?? existing?.cwd,
            label: (typeof body.label === "string" && body.label !== "" ? body.label : undefined) ?? existing?.label,
            notify: (body.notify as boolean | undefined) ?? existing?.notify ?? false,
            state: existing?.state ?? "running",
            ptyPath: typeof body.tty === "string" ? body.tty : existing?.ptyPath,
            nvimSocket: nvim_socket ?? existing?.nvimSocket ?? null,
            backendKind:
              (typeof body.backend_kind === "string" ? body.backend_kind : undefined)
              ?? existing?.backendKind,
            backendProtocolVersion:
              (typeof body.backend_protocol_version === "number" ? body.backend_protocol_version : undefined)
              ?? existing?.backendProtocolVersion,
            backendEndpoint:
              (typeof body.backend_endpoint === "string" ? body.backend_endpoint : undefined)
              ?? existing?.backendEndpoint,
            backendAuthToken:
              (typeof body.backend_auth_token === "string" ? body.backend_auth_token : undefined)
              ?? existing?.backendAuthToken,
          },
          nowFn(),
        );

        if (onSessionStart && ((body.notify as boolean | undefined) ?? existing?.notify ?? false)) {
          await onSessionStart(sessionId, true, (typeof body.label === "string" ? body.label : null) ?? existing?.label);
        }

        return Response.json({ ok: true, session_id: sessionId });
      }

      if (request.method === "POST" && url.pathname === "/sessions/enable-notify") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const existing = storage.sessions.get(sessionId);
        if (!existing) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const label = typeof body.label === "string" && body.label !== "" ? body.label : null;

        storage.sessions.upsert(
          {
            sessionId,
            ppid: existing.ppid,
            pid: existing.pid,
            startTime: existing.startTime,
            cwd: existing.cwd,
            label: label ?? existing.label,
            notify: true,
            state: existing.state,
            ptyPath: existing.ptyPath,
            nvimSocket: existing.nvimSocket,
            backendKind: existing.backendKind,
            backendProtocolVersion: existing.backendProtocolVersion,
            backendEndpoint: existing.backendEndpoint,
            backendAuthToken: existing.backendAuthToken,
          },
          nowFn(),
        );

        if (onSessionStart) {
          await onSessionStart(sessionId, true, label ?? existing.label);
        }

        const session = storage.sessions.get(sessionId);
        return Response.json({ ok: true, session: session ? toLegacySession(session) : null });
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        const active = url.searchParams.get("active") === "true";
        const notify = url.searchParams.get("notify") === "true";
        const sessions = storage.sessions.list({ active, notify, now: nowFn() }).map(toLegacySession);
        return Response.json({ ok: true, sessions });
      }

      if (request.method === "POST" && url.pathname === "/cleanup") {
        const now = nowFn();
        const cleanedSessions = storage.sessions.cleanupExpired(now);
        const cleanedTokens = storage.sessionTokens.cleanupExpired(now);
        return Response.json({
          ok: true,
          cleaned: {
            sessions: cleanedSessions,
            tokens: cleanedTokens,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const session = storage.sessions.get(sessionId);
        if (!session) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        storage.sessions.touch(sessionId, nowFn());

        if (!session.notify) {
          return Response.json({ ok: true, notified: false, reason: "notify=false" });
        }

        if (!notifier) {
          return Response.json({ ok: true, notified: false, reason: "no notification handler" });
        }

        const message = typeof body.message === "string" ? body.message : null;
        const summary = typeof body.summary === "string" ? body.summary : null;
        const event = typeof body.event === "string" ? body.event : "Stop";
        const label = typeof body.label === "string" ? body.label : null;

        try {
          const result = await notifier.sendStopNotification({
            session: {
              sessionId: session.sessionId,
              label: session.label,
              cwd: session.cwd,
            },
            event,
            summary: message || summary || "Task completed",
            label: label || session.label || undefined,
          });

          return Response.json({ ok: true, notified: true, ...result });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: true, notified: false, error: errorMessage });
        }
      }

      if (request.method === "POST" && url.pathname === "/question-asked") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const requestId = typeof body.request_id === "string" ? body.request_id : "";
        if (!requestId) {
          return Response.json({ error: "request_id is required" }, { status: 400 });
        }

        const questions = body.questions as QuestionInfoData[] | undefined;
        if (!Array.isArray(questions) || questions.length === 0) {
          return Response.json({ error: "questions array is required" }, { status: 400 });
        }

        const session = storage.sessions.get(sessionId);
        if (!session) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        if (!session.notify) {
          return Response.json({ ok: true, notified: false, reason: "notify=false" });
        }

        if (!notifier || !("sendQuestionNotification" in notifier) || typeof notifier.sendQuestionNotification !== "function") {
          return Response.json({ ok: true, notified: false, reason: "no question notification handler" });
        }

        const label = typeof body.label === "string" ? body.label : null;

        try {
          const result = await notifier.sendQuestionNotification({
            session: {
              sessionId: session.sessionId,
              label: session.label,
              cwd: session.cwd,
            },
            questionRequestId: requestId,
            questions,
            label: label || session.label || undefined,
          });

          return Response.json({ ok: true, notified: true, ...result });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: true, notified: false, error: errorMessage });
        }
      }

      if (request.method === "POST" && url.pathname === "/question-answered") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const deleted = storage.pendingQuestions.delete(sessionId);
        return Response.json({ ok: true, cleared: deleted });
      }

      if (url.pathname.startsWith("/sessions/") && url.pathname !== "/sessions/enable-notify") {
        const sessionId = decodeURIComponent(url.pathname.slice("/sessions/".length));

        if (request.method === "GET") {
          const session = storage.sessions.get(sessionId);
          if (!session) {
            return Response.json({ error: "Session not found" }, { status: 404 });
          }
          return Response.json({ ok: true, session: toLegacySession(session) });
        }

        if (request.method === "DELETE") {
          storage.sessions.delete(sessionId);
          if (onSessionDelete) {
            await onSessionDelete(sessionId);
          }
          return Response.json({ ok: true });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

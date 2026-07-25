import type { StorageDb } from "./storage/database";
import type { StopNotifier, QuestionNotifier } from "./notification-service";
import { generateToken, formatTelegramNotification, formatQuestionNotification, formatQuestionWizardStep, displayName } from "./notification-service";
import { splitTelegramMessage } from "./split-message";
import type { QuestionInfoData } from "./storage/types";
import { IngressRouter, NoHealthyServeError, LeaseContendedError } from "./routing/router";
import { checkAuth } from "./auth";
import { payloadHasCloseTag } from "./swarm/envelope";
import { makeMsgId } from "./ids";

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
  chatId?: string;
  machineId?: string;
  router?: IngressRouter;
  authToken?: string;
}

export function createApp(storage: StorageDb, options: AppOptions = {}) {
  const nowFn = options.nowFn ?? Date.now;
  const notifier = options.notifier;
  const onSessionStart = options.onSessionStart;
  const onSessionDelete = options.onSessionDelete;
  const opts = options;

  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const authFailure = checkAuth(request, url, options.authToken);
    if (authFailure) return authFailure;

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, service: "pigeon-daemon" });
      }

      if (request.method === "POST" && url.pathname === "/alert") {
        const body = await readJsonBody(request);
        const text = typeof body.text === "string" ? body.text : "";
        const severityRaw = typeof body.severity === "string" ? body.severity : "info";
        const severity: "info" | "warning" | "error" =
          severityRaw === "error" || severityRaw === "warning" ? severityRaw : "info";

        if (!text) {
          return Response.json({ error: "text is required" }, { status: 400 });
        }

        if (!notifier?.sendPlainAlert) {
          return Response.json({ error: "alerting not configured" }, { status: 503 });
        }

        try {
          await notifier.sendPlainAlert(text, severity);
          return new Response(null, { status: 204 });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 502 });
        }
      }

      if (request.method === "POST" && url.pathname === "/swarm/send") {
        const body = await readJsonBody(request);
        const from = typeof body.from === "string" ? body.from : "";
        const to = typeof body.to === "string" ? body.to : null;
        const channel = typeof body.channel === "string" ? body.channel : null;
        const kind = typeof body.kind === "string" ? body.kind : "chat";
        const priority = (typeof body.priority === "string" ? body.priority : "normal") as "urgent" | "normal" | "low";
        const replyTo = typeof body.reply_to === "string" ? body.reply_to : null;
        const payload = typeof body.payload === "string" ? body.payload : "";
        const callerMsgId = typeof body.msg_id === "string" ? body.msg_id : null;

        if (!from) return Response.json({ error: "from is required" }, { status: 400 });
        if (!to && !channel) return Response.json({ error: "to or channel is required" }, { status: 400 });
        if (to && channel) return Response.json({ error: "exactly one of to or channel must be set" }, { status: 400 });
        // Cheap shape check: a `to` target must be an opencode session id
        // (matches opencode-serve's own zod prefix check). This catches typos
        // and category errors (e.g. passing a coordinator name like "lgtm")
        // before we burn ~7 minutes of arbiter retries against a 400 from
        // opencode-serve. We do NOT validate that the session exists — that
        // is a different problem (real sessions become unreachable when
        // opencode-serve restarts).
        if (to && !/^ses_[A-Za-z0-9_-]+$/.test(to)) {
          return Response.json(
            { error: "to must be a session id starting with 'ses_'" },
            { status: 400 },
          );
        }
        if (!payload) return Response.json({ error: "payload is required" }, { status: 400 });
        // Reject a payload that contains the literal </swarm_message> close
        // tag at enqueue time. renderEnvelope() guards this too, but that runs
        // later in the arbiter at delivery time — accepting it here (202) makes
        // the sender think it succeeded while the arbiter silently burns
        // retries and drops it. Fail fast so the caller finds out immediately.
        // (Same "fail fast, don't burn arbiter retries" rationale as the
        // ses_ shape check above.)
        if (payloadHasCloseTag(payload)) {
          return Response.json(
            {
              error:
                "payload must not contain the literal </swarm_message> close tag",
            },
            { status: 400 },
          );
        }

        const msgId = callerMsgId ?? makeMsgId();
        storage.swarm.insert(
          { msgId, fromSession: from, toSession: to, channel, kind, priority, replyTo, payload },
          nowFn(),
        );

        return Response.json({ accepted: true, msg_id: msgId }, { status: 202 });
      }

      if (request.method === "GET" && url.pathname === "/swarm/inbox") {
        const sessionId = url.searchParams.get("session");
        if (!sessionId) return Response.json({ error: "session is required" }, { status: 400 });
        const since = url.searchParams.get("since");
        const before = url.searchParams.get("before");
        const limitParam = url.searchParams.get("limit");
        let limit: number | undefined;
        if (limitParam !== null) {
          const parsed = Number.parseInt(limitParam, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
          }
          limit = parsed;
        }
        const page = storage.swarm.getInbox(sessionId, { since, before, limit });
        return Response.json({
          messages: page.messages.map((m) => ({
            msg_id: m.msgId,
            from: m.fromSession,
            to: m.toSession,
            channel: m.channel,
            kind: m.kind,
            priority: m.priority,
            reply_to: m.replyTo,
            payload: m.payload,
            created_at: m.createdAt,
            handed_off_at: m.handedOffAt,
          })),
          has_more: page.hasMore,
        });
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
            title: (typeof body.title === "string" && body.title !== "" ? body.title : undefined) ?? existing?.title,
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
            title: existing.title,
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
          console.log(`[stop] rejected: missing session_id`);
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }

        const session = storage.sessions.get(sessionId);
        if (!session) {
          console.log(`[stop] rejected: session not found sessionId=${sessionId}`);
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        storage.sessions.touch(sessionId, nowFn());

        if (!session.notify) {
          console.log(`[stop] skipped: notify=false sessionId=${sessionId}`);
          return Response.json({ ok: true, notified: false, reason: "notify=false" });
        }

        const message = typeof body.message === "string" ? body.message : null;
        const summary = typeof body.summary === "string" ? body.summary : null;
        const event = typeof body.event === "string" ? body.event : "Stop";
        const label = typeof body.label === "string" ? body.label : null;
        const requestTitle = typeof body.title === "string" && body.title !== "" ? body.title : undefined;

        if (requestTitle !== undefined) {
          storage.sessions.setTitle(sessionId, requestTitle, nowFn());
        }
        const effectiveTitle = requestTitle ?? session.title;

        const now = nowFn();
        const notificationId = `s:${sessionId}:${now}`;

        // Check if already queued (idempotent within same timestamp)
        const existing = storage.outbox.getByNotificationId(notificationId);
        if (existing) {
          console.log(`[stop] already queued sessionId=${sessionId} notificationId=${notificationId}`);
          return Response.json(
            { ok: true, deliveryState: existing.state === "sent" ? "sent" : "queued", notificationId },
            { status: existing.state === "sent" ? 200 : 202 },
          );
        }

        // Generate token for reply routing
        const token = generateToken();
        storage.sessionTokens.mint({
          token,
          sessionId,
          chatId: opts.chatId ?? "",
          context: { event, summary: (message || summary || "Task completed").slice(0, 200) },
        }, now);

        // Format notification for the outbox
        const notification = formatTelegramNotification({
          event,
          label: displayName({ title: effectiveTitle, label: label || session.label, sessionId }),
          summary: message || summary || "Task completed",
          cwd: session.cwd,
          token,
          machineId: opts.machineId,
          sessionId,
        });

        const chunks = splitTelegramMessage(notification.header, notification.body, notification.footer);
        const notificationPayload = {
          messages: chunks.map(c => ({ text: c.text, entities: c.entities })),
          replyMarkup: notification.replyMarkup,
          notificationId,
        };

        // Queue in outbox — OutboxSender will deliver with retry
        storage.outbox.upsert({
          notificationId,
          sessionId,
          requestId: `stop-${now}`,
          kind: "stop",
          payload: JSON.stringify(notificationPayload),
          token,
        }, now);

        console.log(`[stop] queued sessionId=${sessionId} notificationId=${notificationId} label=${displayName({ title: effectiveTitle, label: label || session.label, sessionId })}`);
        return Response.json({ ok: true, deliveryState: "queued", notificationId }, { status: 202 });
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

        storage.sessions.touch(sessionId, nowFn());

        if (!session.notify) {
          return Response.json({ ok: true, notified: false, reason: "notify=false" });
        }

        const label = typeof body.label === "string" ? body.label : null;
        const requestTitle = typeof body.title === "string" && body.title !== "" ? body.title : undefined;

        if (requestTitle !== undefined) {
          storage.sessions.setTitle(sessionId, requestTitle, nowFn());
        }
        const effectiveTitle = requestTitle ?? session.title;

        const now = nowFn();

        // Generate stable notification ID for idempotency
        const notificationId = `q:${sessionId}:${requestId}`;

        // Check if already in outbox (idempotent)
        const existing = storage.outbox.getByNotificationId(notificationId);
        if (existing) {
          return Response.json(
            { ok: true, deliveryState: existing.state === "sent" ? "sent" : "queued", notificationId },
            { status: existing.state === "sent" ? 200 : 202 },
          );
        }

        // Generate token for Telegram inline buttons
        const token = generateToken();

        // Store pending question
        storage.pendingQuestions.store({
          sessionId,
          requestId,
          questions,
          token,
        }, now);

        // Mint session token
        storage.sessionTokens.mint({
          token,
          sessionId,
          chatId: opts.chatId ?? "",
          context: { type: "question", questionRequestId: requestId },
        }, now);

        // Format the notification payload for the outbox
        let notificationPayload: { message: { text: string; entities: unknown[] }; replyMarkup: unknown; notificationId: string };

        if (questions.length > 1) {
          // Multi-question: wizard mode — show step 1
          const notification = formatQuestionWizardStep({
            label: displayName({ title: effectiveTitle, label: label || session.label, sessionId }),
            questions,
            currentStep: 0,
            cwd: session.cwd,
            token,
            version: 0,
            machineId: opts.machineId,
            sessionId,
          });
          notificationPayload = {
            message: { text: notification.message.text, entities: notification.message.entities },
            replyMarkup: notification.replyMarkup,
            notificationId,
          };
        } else {
          // Single-question: existing behavior
          const notification = formatQuestionNotification({
            label: displayName({ title: effectiveTitle, label: label || session.label, sessionId }),
            questions,
            cwd: session.cwd,
            token,
            machineId: opts.machineId,
            sessionId,
          });
          notificationPayload = {
            message: { text: notification.message.text, entities: notification.message.entities },
            replyMarkup: notification.replyMarkup,
            notificationId,
          };
        }

        // Store in outbox — background sender will deliver to Telegram
        storage.outbox.upsert({
          notificationId,
          sessionId,
          requestId,
          kind: "question",
          payload: JSON.stringify(notificationPayload),
          token,
        }, now);

        return Response.json(
          { ok: true, deliveryState: "accepted", notificationId },
          { status: 202 },
        );
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

      if (request.method === "POST" && url.pathname === "/place") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!sessionId) {
          return Response.json({ error: "session_id is required" }, { status: 400 });
        }
        if (!options.router) {
          return Response.json({ error: "routing not configured" }, { status: 503 });
        }

        try {
          const now = nowFn();
          const r = options.router.ensureRouted(sessionId, now);
          return Response.json({
            ok: true,
            session_id: sessionId,
            serve_id: r.serveId,
            api_base: r.apiBase,
            event_url: r.eventUrl,
            owner_generation: r.ownerGeneration,
            instance_uuid: r.instanceUuid,
            expires_at: r.expiresAt,
          });
        } catch (err) {
          if (err instanceof NoHealthyServeError) {
            return Response.json({ error: "no healthy serve" }, { status: 503 });
          }
          if (err instanceof LeaseContendedError) {
            return Response.json({ error: "lease contended", session_id: sessionId }, { status: 409 });
          }
          throw err;
        }
      }

      if (request.method === "GET" && url.pathname === "/route") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) {
          return Response.json({ error: "invalid session_id" }, { status: 400 });
        }
        if (!options.router) {
          return Response.json({ error: "routing not configured" }, { status: 503 });
        }
        // Read-only discovery. Prefer the ACTIVE route (valid lease); if the
        // session is idle (no lease), fall back to a read-only PROSPECTIVE route
        // so idle attach TUIs distribute across the pool instead of all landing
        // on the default serve. Both are null for an unknown/deleted sid -> 404.
        // Neither call writes: this endpoint MUST NOT manufacture an
        // assignment/lease — a GET with a write side-effect masked the real
        // "session not found" condition (see pigeon-eup). Placement still happens
        // on the in-process control/swarm paths via
        // OpencodeClientFactory.forSession -> ensureRouted.
        // See docs/plans/2026-06-24-prospective-route-idle-sessions-design.md.
        const now = nowFn();
        const route =
          options.router.resolveRoute(sessionId, now) ??
          options.router.resolveProspectiveRoute(sessionId, now);
        if (!route) {
          return Response.json({ error: "session not routed" }, { status: 404 });
        }
        return Response.json(route);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

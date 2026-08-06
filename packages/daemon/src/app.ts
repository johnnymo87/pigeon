import type { StorageDb } from "./storage/database";
import { isNotifyPolicy, NOTIFY_POLICIES } from "./storage/session-origin-repo";
import type { StopNotifier } from "./notification-service";
import { generateToken, formatTelegramNotification, formatQuestionNotification, formatQuestionWizardStep, displayName } from "./notification-service";
import { splitTelegramMessage } from "./split-message";
import type { QuestionInfoData } from "./storage/types";
import { IngressRouter, NoHealthyServeError, LeaseContendedError } from "./routing/router";
import { checkAuth } from "./auth";
import { payloadHasCloseTag } from "./swarm/envelope";
import { parseScheduleTime } from "./swarm/schedule-time";
import type { Priority } from "./storage/swarm-repo";
import { makeMsgId } from "./ids";
import { clampPreservingSurrogates } from "./text";

interface LegacySession {
  session_id: string;
  ppid: number | null;
  pid: number | null;
  start_time: number | null;
  cwd: string | null;
  label: string | null;
  title: string | null;
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
  title: string | null;
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
    title: session.title,
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

/**
 * Maximum session title length (200 characters).
 * Bounded to prevent header overhead from breaking Telegram's 4096-char message limit
 * and to accommodate Phase 2 forum topic names (capped at 128 chars).
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Titles of automation sessions whose routine Stop notifications are suppressed.
 *
 * Tuned against production, NOT guessed. Measured over 181 distinct live session
 * titles (59 mentioning lgtm) plus real-work-on-lgtm probes:
 *
 *   \.lgtm-                              74.6% caught, 0 false positives  (first attempt)
 *   lgtm-(review|gather)-prompt          81.4% caught, 0 false positives
 *   this pattern                         96.6% caught, 0 false positives
 *   bare "lgtm"                         100.0% caught, 4 false positives
 *
 * The leading-dot form was too strict: the model-generated title often drops the
 * dot ("Review PR with lgtm-review-prompt"), and prose variants ("PR review with
 * LGTM prompt") name the tool without the filename at all. Requiring a hyphen or
 * space before "prompt" is what keeps real work ON lgtm deliverable -- "Fix lgtm
 * dispatcher timeout" and "Fix lgtm-run timer flake" both correctly miss.
 *
 * Deliberately still missed: "LGTM for PR #3944" and "LGTM auto-reviews on
 * reviewer add". Both are ambiguous, and the second is probably genuine work on
 * the lgtm tool -- which must be delivered. A false positive silently hides real
 * work, so ambiguity resolves toward delivering.
 */
const DEFAULT_QUIET_TITLE_PATTERN = "lgtm-(review|gather)-prompt|lgtm[ -]prompt";

export interface SwarmSendFields {
  from: string;
  to: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
  callerMsgId: string | null;
}

export type ParseSwarmSendBodyResult =
  | { ok: true; fields: SwarmSendFields }
  | { ok: false; response: Response };

export function parseSwarmSendBody(
  body: Record<string, unknown>,
  defaultKind = "chat",
): ParseSwarmSendBodyResult {
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : null;
  const channel = typeof body.channel === "string" ? body.channel : null;
  const kind = typeof body.kind === "string" ? body.kind : defaultKind;
  const priority = (typeof body.priority === "string" ? body.priority : "normal") as Priority;
  const replyTo = typeof body.reply_to === "string" ? body.reply_to : null;
  const payload = typeof body.payload === "string" ? body.payload : "";
  const callerMsgId = typeof body.msg_id === "string" ? body.msg_id : null;

  if (typeof body.kind === "string" && body.kind.startsWith("swarm.")) {
    return {
      ok: false,
      response: Response.json(
        { error: "kind cannot start with 'swarm.' (reserved for pigeon-generated messages)" },
        { status: 400 },
      ),
    };
  }

  // Reserve ':' in the msg_id namespace, for the same reason `kind` reserves
  // the "swarm." prefix directly above.
  //
  // Durable operational_alerts are deduped by a UNIQUE index on ref_msg_id
  // ALONE, and pigeon keys its OWN alerts on ':'-delimited synthetic refs
  // ("wake-lost:<msgId>", "watchdog-stall:<ts>") precisely so they cannot
  // occupy the dedupe slot belonging to a real message. That separation is
  // only structural if a msg_id can never contain ':'. Without this guard it
  // was merely conventional: msg_id is accepted verbatim from the request
  // body, so a caller minting "wake-lost:msg_real" takes the slot belonging
  // to real row msg_real's payload-carrying alert — and enqueue's ON CONFLICT
  // DO NOTHING drops it SILENTLY, since callers discard the return value.
  // That is the exact silent loss this alert exists to prevent.
  //
  // Costs nothing real: every msg_id pigeon has ever minted is
  // `msg_<base36>_<uuid8>` (daemon ids.ts and the plugin agree), and all 745
  // rows in the production DB match it with zero colons.
  if (callerMsgId !== null && callerMsgId.includes(":")) {
    return {
      ok: false,
      response: Response.json(
        {
          error:
            "msg_id cannot contain ':' (reserved as pigeon's alert-reference delimiter)",
        },
        { status: 400 },
      ),
    };
  }

  if (!from) return { ok: false, response: Response.json({ error: "from is required" }, { status: 400 }) };
  if (!to && !channel) return { ok: false, response: Response.json({ error: "to or channel is required" }, { status: 400 }) };
  if (to && channel) return { ok: false, response: Response.json({ error: "exactly one of to or channel must be set" }, { status: 400 }) };
  if (to && !/^ses_[A-Za-z0-9_-]+$/.test(to)) {
    return {
      ok: false,
      response: Response.json(
        { error: "to must be a session id starting with 'ses_'" },
        { status: 400 },
      ),
    };
  }
  if (!payload) return { ok: false, response: Response.json({ error: "payload is required" }, { status: 400 }) };
  if (payloadHasCloseTag(payload)) {
    return {
      ok: false,
      response: Response.json(
        {
          error:
            "payload must not contain the literal </swarm_message> close tag",
        },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    fields: {
      from,
      to,
      channel,
      kind,
      priority,
      replyTo,
      payload,
      callerMsgId,
    },
  };
}

export function isQuietTitle(
  title: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!title) return false;

  const rawPattern = env.PIGEON_QUIET_TITLE_PATTERN?.trim();
  let regex: RegExp;

  if (rawPattern) {
    try {
      regex = new RegExp(rawPattern, "i");
    } catch (err) {
      console.error(
        `[stop] invalid PIGEON_QUIET_TITLE_PATTERN regex "${rawPattern}", falling back to default automation-title pattern:`,
        err,
      );
      regex = new RegExp(DEFAULT_QUIET_TITLE_PATTERN, "i");
    }
  } else {
    regex = new RegExp(DEFAULT_QUIET_TITLE_PATTERN, "i");
  }

  return regex.test(title);
}

function parseTitle(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (trimmed === "") return undefined;
  // Surrogate-safe: a bare .slice() here can leave a lone high surrogate that Telegram
  // cannot encode, silently killing every notification for the session. See text.ts.
  return clampPreservingSurrogates(trimmed, MAX_TITLE_LENGTH);
}

interface AppOptions {
  nowFn?: () => number;
  notifier?: StopNotifier;
  onSessionStart?: (sessionId: string, notify: boolean, label?: string | null) => Promise<void> | void;
  onSessionDelete?: (sessionId: string) => Promise<void> | void;
  chatId?: string;
  machineId?: string;
  router?: IngressRouter;
  authToken?: string;
  isSchedulerRunning?: () => boolean;
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

      if (request.method === "GET" && url.pathname === "/outbox/stats") {
        return Response.json(storage.outbox.getStats(nowFn()));
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
        const parsed = parseSwarmSendBody(body, "chat");
        if (!parsed.ok) return parsed.response;

        const f = parsed.fields;
        const msgId = f.callerMsgId ?? makeMsgId();
        storage.swarm.insert(
          {
            msgId,
            fromSession: f.from,
            toSession: f.to,
            channel: f.channel,
            kind: f.kind,
            priority: f.priority,
            replyTo: f.replyTo,
            payload: f.payload,
          },
          nowFn(),
        );

        return Response.json({ accepted: true, msg_id: msgId }, { status: 202 });
      }

      if (request.method === "POST" && url.pathname === "/swarm/schedule") {
        if (options.isSchedulerRunning && !options.isSchedulerRunning()) {
          return Response.json(
            {
              error:
                "scheduler is not running on this daemon (no opencode URL and no ingress router), " +
                "so a scheduled message could never be delivered; refusing to accept it rather " +
                "than banking a wake that will silently never fire",
            },
            { status: 503 },
          );
        }
        const body = await readJsonBody(request);
        const parsed = parseSwarmSendBody(body, "wake");
        if (!parsed.ok) return parsed.response;

        // Length correlates only loosely with self-containedness: it cannot detect a
        // 60-char payload that says "continue what you were doing", and it will
        // occasionally reject a legitimately terse-but-durable wake. It is a speed
        // bump against the dominant failure mode (forgetting context after compaction),
        // not strict enforcement.
        const trimmedPayload = parsed.fields.payload.trim();
        if (trimmedPayload.length < 40) {
          return Response.json(
            {
              error: `scheduled wake payload is too short (${trimmedPayload.length} chars, minimum 40): a wake must be self-contained because the session receiving it may have compacted away the reason it was scheduled. Include a durable pointer -- a beads id, a PR number, a file path -- not 'check on it'. Example: 'Resume pigeon-c68: run bd show pigeon-c68, then continue the W4 plugin tools in .worktrees/wake-w4.'`,
            },
            { status: 400 },
          );
        }

        let ref: string | null = null;
        if (body.ref !== undefined && body.ref !== null) {
          if (typeof body.ref !== "string") {
            return Response.json(
              { error: "ref must be a string" },
              { status: 400 },
            );
          }
          if (body.ref.length > 200) {
            return Response.json(
              { error: "ref exceeds maximum length of 200 characters" },
              { status: 400 },
            );
          }
          if (/[\r\n\t]/.test(body.ref)) {
            return Response.json(
              { error: "ref must not contain control characters (newline, carriage return, tab)" },
              { status: 400 },
            );
          }
          if (body.ref.length > 0) {
            ref = body.ref;
          }
        }

        const sched = parseScheduleTime({
          at: body.at,
          after: body.after,
          expiresIn: body.expires_in,
          now: nowFn(),
        });
        if (!sched.ok) {
          return Response.json({ error: sched.error }, { status: 400 });
        }

        const f = parsed.fields;
        if (f.channel) {
          return Response.json(
            { error: "scheduled delivery requires a session target (to), not a channel" },
            { status: 400 },
          );
        }
        const msgId = f.callerMsgId ?? makeMsgId();
        const inserted = storage.swarm.insert(
          {
            msgId,
            fromSession: f.from,
            toSession: f.to,
            channel: f.channel,
            kind: f.kind,
            priority: f.priority,
            replyTo: f.replyTo,
            payload: f.payload,
            deliverAt: sched.deliverAt,
            expiresAt: sched.expiresAt,
            ref,
          },
          nowFn(),
        );

        if (!inserted) {
          const stored = storage.swarm.getByMsgId(msgId);
          return Response.json(
            {
              error: `message with msg_id '${msgId}' already exists`,
              msg_id: msgId,
              deliver_at: stored?.deliverAt ?? null,
              expires_at: stored?.expiresAt ?? null,
            },
            { status: 409 },
          );
        }

        return Response.json(
          {
            accepted: true,
            msg_id: msgId,
            deliver_at: sched.deliverAt,
            expires_at: sched.expiresAt,
          },
          { status: 202 },
        );
      }

      if (request.method === "GET" && url.pathname === "/swarm/scheduled") {
        const sessionId = url.searchParams.get("session");
        if (!sessionId) {
          return Response.json({ error: "session is required" }, { status: 400 });
        }

        const windowMs = 24 * 60 * 60 * 1000;
        const includeTerminalSince = nowFn() - windowMs;
        const rows = storage.swarm.listScheduled(sessionId, { includeTerminalSince });

        return Response.json({
          scheduled: rows.map((m) => ({
            msg_id: m.msgId,
            from: m.fromSession,
            to: m.toSession,
            kind: m.kind,
            priority: m.priority,
            payload: m.payload,
            state: m.state,
            deliver_at: m.deliverAt,
            expires_at: m.expiresAt,
            created_at: m.createdAt,
            ref: m.ref,
          })),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname.startsWith("/swarm/scheduled/") &&
        url.pathname.endsWith("/cancel")
      ) {
        const sub = url.pathname.slice("/swarm/scheduled/".length, -"/cancel".length);
        const msgId = decodeURIComponent(sub);

        const body = await readJsonBody(request);
        const from = typeof body.from === "string" ? body.from : "";
        if (!from) {
          return Response.json({ error: "from is required" }, { status: 400 });
        }

        const record = storage.swarm.getByMsgId(msgId);
        if (!record || record.deliverAt === null) {
          return Response.json({ error: "scheduled message not found" }, { status: 404 });
        }

        if (record.fromSession !== from) {
          return Response.json(
            { error: "only the original sender may cancel a scheduled message" },
            { status: 403 },
          );
        }

        const cancelled = storage.swarm.markCancelled(msgId, nowFn());
        if (cancelled) {
          return Response.json({ cancelled: true, msg_id: msgId }, { status: 200 });
        }

        const currentRecord = storage.swarm.getByMsgId(msgId);
        const currentState = currentRecord?.state ?? record.state;
        return Response.json(
          {
            error: `cannot cancel message in state '${currentState}'`,
            state: currentState,
          },
          { status: 409 },
        );
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
            title: parseTitle(body.title) ?? existing?.title,
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

      if (request.method === "POST" && url.pathname === "/session-origin") {
        const body = await readJsonBody(request);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) {
          return Response.json({ error: "session_id must match ^ses_[A-Za-z0-9_-]+$" }, { status: 400 });
        }

        const origin = typeof body.origin === "string" ? body.origin.trim() : "";
        if (!origin) {
          return Response.json({ error: "origin is required" }, { status: 400 });
        }

        // Reject rather than default. On the READ path an unknown policy degrades to "all"
        // (deliver), because a corrupt row must never silence real work. On the WRITE path
        // the opposite is right: a typo'd policy that silently became "all" is
        // indistinguishable from the feature not being deployed.
        const notifyPolicy = body.notify_policy;
        if (!isNotifyPolicy(notifyPolicy)) {
          return Response.json(
            { error: `notify_policy must be one of: ${NOTIFY_POLICIES.join(", ")}` },
            { status: 400 },
          );
        }

        // Deliberately NOT gated on the session existing. The launcher writes between
        // session creation and the first prompt, which is BEFORE the plugin registers the
        // session with the daemon — that ordering is the whole point of the launcher writer.
        storage.sessionOrigins.record(
          { sessionId, origin, notifyPolicy, source: "declared" },
          nowFn(),
        );

        console.log(`[session-origin] declared sessionId=${sessionId} origin=${origin} policy=${notifyPolicy}`);
        return Response.json({
          ok: true,
          session_id: sessionId,
          origin,
          notify_policy: notifyPolicy,
          source: "declared",
        });
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
        const requestTitle = parseTitle(body.title);

        if (requestTitle !== undefined) {
          storage.sessions.setTitle(sessionId, requestTitle, nowFn());
        }
        const effectiveTitle = requestTitle ?? session.title;

        if (event === "Stop" && isQuietTitle(effectiveTitle)) {
          console.log(`[stop] quieted sessionId=${sessionId} event=${event} title="${effectiveTitle}"`);
          return Response.json({ ok: true, notified: false, reason: "quiet_title" });
        }

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
          title: effectiveTitle ?? undefined,
          dir: session.cwd ?? undefined,
          threaded: true,
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
        const requestTitle = parseTitle(body.title);

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
          if (existing.state === "failed") {
            console.warn(`[question] outbox row failed sessionId=${sessionId} notificationId=${notificationId} failedReason=${existing.failedReason}`);
            return Response.json(
              { ok: false, deliveryState: "failed", notificationId },
              { status: 200 },
            );
          }
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
        let notificationPayload: {
          message: { text: string; entities: unknown[] };
          replyMarkup: unknown;
          notificationId: string;
          title?: string;
          dir?: string;
          threaded?: boolean;
        };

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
            title: effectiveTitle ?? undefined,
            dir: session.cwd ?? undefined,
            threaded: true,
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
            title: effectiveTitle ?? undefined,
            dir: session.cwd ?? undefined,
            threaded: true,
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

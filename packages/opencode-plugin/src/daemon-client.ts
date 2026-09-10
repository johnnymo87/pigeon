import { resolveDaemonToken, invalidateDaemonToken } from "./auth-token"

type LogFn = (message: string, data?: unknown) => void

type RegisterSessionOpts = {
  sessionId: string
  cwd: string
  label: string
  title?: string
  pid: number
  ppid: number
  tty?: string
  backendKind?: string
  backendProtocolVersion?: number
  backendEndpoint?: string
  backendAuthToken?: string
  daemonUrl?: string
  log: LogFn
}

type FileMedia = {
  mime: string;
  filename: string;
  url: string;
}

type NotifyStopOpts = {
  sessionId: string
  event?: string
  message: string
  label: string
  title?: string
  media?: FileMedia[]
  errorKind?: string | null
  daemonUrl?: string
  log: LogFn
}

type QuestionOption = {
  label: string
  description: string
}

type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

type NotifyQuestionAskedOpts = {
  sessionId: string
  requestId: string
  questions: QuestionInfo[]
  label: string
  title?: string
  daemonUrl?: string
  log: LogFn
}

type NotifyQuestionAnsweredOpts = {
  sessionId: string
  requestId?: string
  daemonUrl?: string
  log: LogFn
}

type PostMirrorOpts = {
  sessionId: string
  messageId: string
  text: string
  daemonUrl?: string
  log?: LogFn
}

type DaemonResult = { ok: boolean; deliveryState?: string; notified?: boolean } | null

const BreakerState = { Closed: 0, Open: 1, HalfOpen: 2 } as const
type BreakerState = (typeof BreakerState)[keyof typeof BreakerState]

let breakerState: BreakerState = BreakerState.Closed
let breakerOpenUntil = 0
let breakerBackoff = 30_000

function getDaemonUrl(override?: string): string {
  if (override) return override
  if (process.env.PIGEON_DAEMON_URL) return process.env.PIGEON_DAEMON_URL
  const port = process.env.TELEGRAM_WEBHOOK_PORT ?? "4731"
  return `http://127.0.0.1:${port}`
}

function checkBreaker(): boolean {
  if (breakerState === BreakerState.Closed) return true
  if (Date.now() >= breakerOpenUntil) {
    breakerState = BreakerState.HalfOpen
    return true
  }
  return false
}

function onSuccess(): void {
  breakerState = BreakerState.Closed
  breakerBackoff = 30_000
}

/**
 * Open the breaker. ONLY call this for a transport failure -- see `isTransportFailure`.
 *
 * `route` and `reason` are logged because the trip used to be invisible: diagnosing
 * pigeon-mavq meant correlating a `registerSession failed` line against a
 * `blocked by circuit breaker` line for a different session 19 seconds later.
 */
function onTransportFailure(route: string, err: unknown, log?: LogFn): void {
  if (breakerState === BreakerState.HalfOpen) {
    breakerBackoff = Math.min(breakerBackoff * 2, 60_000)
  }
  breakerState = BreakerState.Open
  breakerOpenUntil = Date.now() + breakerBackoff
  log?.("breaker opened", {
    route,
    reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    openUntil: breakerOpenUntil,
  })
}

/**
 * True when the daemon never answered, which is the only thing the breaker models.
 *
 * Deliberately positional rather than error-shaped: anything thrown AFTER `fetch`
 * resolved -- a `SyntaxError` from a truncated body, or the same abort landing on
 * `res.json()` as a `TimeoutError` instead -- proves headers arrived, so the daemon was
 * reachable and prompt. Classifying by error name got the observed case right and the
 * sibling case wrong; the flag cannot be fooled by which of the two the runtime picks.
 * Treating a cut-short body as unreachable is what opened the breaker in pigeon-mavq.
 */
function isTransportFailure(responded: boolean): boolean {
  return !responded
}

/**
 * Record a failure that came back as an HTTP response.
 *
 * Intentionally a no-op on the breaker. Any status -- 404 for a reaped session, 500
 * from a bug -- proves the daemon is reachable and answering promptly, which is the
 * only question the breaker exists to answer. Before this, one session's 404 opened
 * the breaker for every session sharing the serve process.
 */
function onHttpError(): void {
  // no breaker effect by design; callers log the status themselves
}

function daemonHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = resolveDaemonToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function fetchDaemon(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = { ...daemonHeaders(), ...(init.headers as Record<string, string> | undefined) }
  let res = await fetch(url, { ...init, headers })
  if (res.status === 401) {
    invalidateDaemonToken()
    const retryHeaders = { ...daemonHeaders(), ...(init.headers as Record<string, string> | undefined) }
    res = await fetch(url, { ...init, headers: retryHeaders })
  }
  return res
}

export async function registerSession(opts: RegisterSessionOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)
  let responded = false

   try {
       const res = await fetchDaemon(`${url}/session-start`, {
         method: "POST",
         body: JSON.stringify({
          session_id: opts.sessionId,
          notify: true,
          cwd: opts.cwd,
          label: opts.label,
          ...(opts.title ? { title: opts.title } : {}),
          pid: opts.pid,
          ppid: opts.ppid,
          tty: opts.tty,
          backend_kind: opts.backendKind,
          backend_protocol_version: opts.backendProtocolVersion,
          backend_endpoint: opts.backendEndpoint,
          backend_auth_token: opts.backendAuthToken,
        }),
        // 3s, not 1s: the daemon is local but shares a machine with a serve pool, and a
        // 1s abort produced *phantom* failures (headers back, body cut) that opened the
        // breaker while the daemon had in fact registered the session (pigeon-mavq).
        signal: AbortSignal.timeout(3000),
      })
     responded = true

     if (!res.ok) {
       const text = await res.text().catch(() => "")
       opts.log("daemon returned error", { status: res.status, body: text })
       onHttpError()
       return null
     }

     const data = (await res.json()) as { ok: boolean; notified?: boolean }
     onSuccess()
     return data
  } catch (err) {
    if (isTransportFailure(responded)) onTransportFailure("/session-start", err, opts.log)
    opts.log("registerSession failed:", err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err))
    return null
  }
}

/**
 * Outcome of one stop delivery attempt.
 *
 * `unregistered` is separate from `terminal` because it is the one failure the caller
 * can actually repair: the daemon's session reaper deletes a row after 7 days idle
 * while the plugin still believes it is registered, so `ensureRegistered` never
 * re-registers and the answer to a long-idle session's prompt would be dropped
 * forever. The caller re-registers and hands it back.
 */
export type StopOutcome = "success" | "retry" | "unregistered" | "terminal"

/**
 * Whether this daemon has proved it honours a client-supplied notification id.
 *
 * Deploy skew matters here in one direction only. Against an OLD daemon our id is
 * ignored and a fresh one is minted per request, so retrying a POST that timed out
 * *after* being processed posts to Telegram twice. A duplicate in every topic is worse
 * than the status quo, so until a response echoes the exact id we sent, an ambiguous
 * timeout stays terminal -- which is precisely today's behaviour, no worse.
 *
 * Sticky and process-global: one echo from one session proves it for the daemon, and
 * the plugin talks to exactly one daemon.
 */
let daemonEchoesStopKey = false

export async function sendStop(
  opts: NotifyStopOpts & { notificationId: string },
): Promise<StopOutcome> {
  const url = getDaemonUrl(opts.daemonUrl)

  try {
    const res = await fetchDaemon(`${url}/stop`, {
      method: "POST",
      body: JSON.stringify({
        session_id: opts.sessionId,
        event: opts.event ?? "Stop",
        message: opts.message,
        label: opts.label,
        notification_id: opts.notificationId,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.media && opts.media.length > 0 ? { media: opts.media } : {}),
        ...(opts.errorKind ? { error_kind: opts.errorKind } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    })

    if (res.status === 404) {
      opts.log("sendStop: session unknown to daemon", { sessionId: opts.sessionId })
      return "unregistered"
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // 5xx is the daemon having a bad moment; 4xx means it understood us and said no,
      // and repeating the identical request cannot change that answer.
      const outcome: StopOutcome = res.status >= 500 ? "retry" : "terminal"
      opts.log("sendStop: daemon returned error", {
        sessionId: opts.sessionId,
        status: res.status,
        body: text,
        outcome,
      })
      return outcome
    }

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      deliveryState?: string
      notified?: boolean
      notificationId?: string
    }
    // Both directions. An id that is present but NOT ours is positive evidence of a
    // daemon that mints its own -- i.e. a ROLLBACK to a version that ignores the key --
    // and leaving the flag stuck true there would start retrying ambiguous timeouts
    // against a daemon that cannot dedupe them, producing the duplicates this flag
    // exists to prevent.
    if (data.notificationId !== undefined) {
      daemonEchoesStopKey = data.notificationId === opts.notificationId
    }
    // ANY 2xx is delivered. Notably `{ok:true, notified:false}` -- a quiet session --
    // is a decision, not a failure; retrying it would burn the TTL and then warn.
    opts.log("sendStop: daemon response", { sessionId: opts.sessionId, ...data })
    return "success"
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    if (timedOut && !daemonEchoesStopKey) {
      opts.log("sendStop: timeout against a daemon that has not echoed our key; not retrying", {
        sessionId: opts.sessionId,
        notificationId: opts.notificationId,
      })
      return "terminal"
    }
    opts.log(
      "sendStop failed:",
      err instanceof Error ? { message: err.message, name: err.name } : String(err),
    )
    return "retry"
  }
}

export async function notifyQuestionAsked(opts: NotifyQuestionAskedOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)
  let responded = false

  try {
    const res = await fetchDaemon(`${url}/question-asked`, {
      method: "POST",
      body: JSON.stringify({
        session_id: opts.sessionId,
        request_id: opts.requestId,
        questions: opts.questions,
        label: opts.label,
        ...(opts.title ? { title: opts.title } : {}),
      }),
      signal: AbortSignal.timeout(1000),
    })
    responded = true

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      opts.log("daemon returned error for question-asked", { status: res.status, body: text })
      onHttpError()
      return null
    }

    const data = (await res.json()) as { ok: boolean; notified?: boolean }
    onSuccess()
    return data
  } catch (err) {
    if (isTransportFailure(responded)) onTransportFailure("/question-asked", err, opts.log)
    opts.log("notifyQuestionAsked failed:", err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err))
    return null
  }
}

export async function notifyQuestionAnswered(opts: NotifyQuestionAnsweredOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)
  let responded = false

  const body: Record<string, string> = {
    session_id: opts.sessionId,
  }
  if (opts.requestId) {
    body.request_id = opts.requestId
  }

  try {
    const res = await fetchDaemon(`${url}/question-answered`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    })
    responded = true

    if (!res.ok) {
      onHttpError()
      return null
    }

    const data = (await res.json()) as { ok: boolean }
    onSuccess()
    return data
  } catch (err) {
    if (isTransportFailure(responded)) onTransportFailure("/question-answered", err, opts.log)
    opts.log("notifyQuestionAnswered failed:", err instanceof Error ? { message: err.message } : String(err))
    return null
  }
}

export async function sendQuestionAsked(opts: NotifyQuestionAskedOpts): Promise<DaemonResult> {
  const url = getDaemonUrl(opts.daemonUrl)

  const res = await fetchDaemon(`${url}/question-asked`, {
    method: "POST",
    body: JSON.stringify({
      session_id: opts.sessionId,
      request_id: opts.requestId,
      questions: opts.questions,
      label: opts.label,
      ...(opts.title ? { title: opts.title } : {}),
    }),
    signal: AbortSignal.timeout(3000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    opts.log("daemon returned error for question-asked (direct)", { status: res.status, body: text })
    throw new Error(`daemon error: ${res.status}`)
  }

  const data = (await res.json()) as { ok: boolean; deliveryState?: string; notified?: boolean }
  return data
}

export async function postMirror(opts: PostMirrorOpts): Promise<{ mirrored: boolean } | null> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)

  try {
    const res = await fetchDaemon(`${url}/mirror`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: opts.sessionId,
        messageId: opts.messageId,
        text: opts.text,
      }),
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      opts.log?.("daemon returned error for mirror", { status: res.status, body: text })
      return null
    }

    const data = (await res.json()) as { mirrored: boolean }
    onSuccess()
    return data
  } catch (err) {
    opts.log?.("postMirror failed:", err instanceof Error ? { message: err.message } : String(err))
    return null
  }
}

export function _resetBreakerForTesting(): void {
  breakerState = BreakerState.Closed
  breakerOpenUntil = 0
  breakerBackoff = 30_000
}

export function _resetStopSkewForTesting(): void {
  daemonEchoesStopKey = false
}

type LogFn = (message: string, data?: unknown) => void

type RegisterSessionOpts = {
  sessionId: string
  cwd: string
  label: string
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
  message: string
  label: string
  media?: FileMedia[]
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
  daemonUrl?: string
  log: LogFn
}

type NotifyQuestionAnsweredOpts = {
  sessionId: string
  daemonUrl?: string
  log: LogFn
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

function onFailure(): void {
  if (breakerState === BreakerState.HalfOpen) {
    breakerBackoff = Math.min(breakerBackoff * 2, 60_000)
  }
  breakerState = BreakerState.Open
  breakerOpenUntil = Date.now() + breakerBackoff
}

export async function registerSession(opts: RegisterSessionOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)

   try {
      const res = await fetch(`${url}/session-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: opts.sessionId,
          notify: true,
          cwd: opts.cwd,
          label: opts.label,
          pid: opts.pid,
          ppid: opts.ppid,
          tty: opts.tty,
          backend_kind: opts.backendKind,
          backend_protocol_version: opts.backendProtocolVersion,
          backend_endpoint: opts.backendEndpoint,
          backend_auth_token: opts.backendAuthToken,
        }),
        signal: AbortSignal.timeout(1000),
      })

     if (!res.ok) {
       const text = await res.text().catch(() => "")
       opts.log("daemon returned error", { status: res.status, body: text })
       onFailure()
       return null
     }

     const data = (await res.json()) as { ok: boolean; notified?: boolean }
     onSuccess()
     return data
  } catch (err) {
    onFailure()
    opts.log("registerSession failed:", err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err))
    return null
  }
}

export async function notifyStop(opts: NotifyStopOpts): Promise<DaemonResult> {
  if (!checkBreaker()) {
    opts.log("notifyStop blocked by circuit breaker", { sessionId: opts.sessionId, breakerState, breakerOpenUntil })
    return null
  }

  const url = getDaemonUrl(opts.daemonUrl)

   try {
     const res = await fetch(`${url}/stop`, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: opts.sessionId,
          event: "Stop",
          message: opts.message,
          label: opts.label,
          ...(opts.media && opts.media.length > 0 ? { media: opts.media } : {}),
        }),
       signal: AbortSignal.timeout(3000),
     })

     if (!res.ok) {
       const text = await res.text().catch(() => "")
       opts.log("notifyStop daemon returned error", { sessionId: opts.sessionId, status: res.status, body: text })
       onFailure()
       return null
     }

     const data = (await res.json()) as { ok: boolean; deliveryState?: string; notified?: boolean }
     opts.log("notifyStop daemon response", { sessionId: opts.sessionId, ...data })
     onSuccess()
     return data
  } catch (err) {
    onFailure()
    opts.log("notifyStop failed:", err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err))
    return null
  }
}

export async function notifyQuestionAsked(opts: NotifyQuestionAskedOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)

  try {
    const res = await fetch(`${url}/question-asked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: opts.sessionId,
        request_id: opts.requestId,
        questions: opts.questions,
        label: opts.label,
      }),
      signal: AbortSignal.timeout(1000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      opts.log("daemon returned error for question-asked", { status: res.status, body: text })
      onFailure()
      return null
    }

    const data = (await res.json()) as { ok: boolean; notified?: boolean }
    onSuccess()
    return data
  } catch (err) {
    onFailure()
    opts.log("notifyQuestionAsked failed:", err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err))
    return null
  }
}

export async function notifyQuestionAnswered(opts: NotifyQuestionAnsweredOpts): Promise<DaemonResult> {
  if (!checkBreaker()) return null

  const url = getDaemonUrl(opts.daemonUrl)

  try {
    const res = await fetch(`${url}/question-answered`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: opts.sessionId,
      }),
      signal: AbortSignal.timeout(1000),
    })

    if (!res.ok) {
      onFailure()
      return null
    }

    const data = (await res.json()) as { ok: boolean }
    onSuccess()
    return data
  } catch (err) {
    onFailure()
    opts.log("notifyQuestionAnswered failed:", err instanceof Error ? { message: err.message } : String(err))
    return null
  }
}

export async function sendQuestionAsked(opts: NotifyQuestionAskedOpts): Promise<DaemonResult> {
  const url = getDaemonUrl(opts.daemonUrl)

  const res = await fetch(`${url}/question-asked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: opts.sessionId,
      request_id: opts.requestId,
      questions: opts.questions,
      label: opts.label,
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

export function _resetBreakerForTesting(): void {
  breakerState = BreakerState.Closed
  breakerOpenUntil = 0
  breakerBackoff = 30_000
}

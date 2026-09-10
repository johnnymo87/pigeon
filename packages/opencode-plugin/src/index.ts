import type { Plugin } from "@opencode-ai/plugin"
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  ResultErrorCode,
  type ExecuteCommandEnvelope,
} from "../../daemon/src/opencode-direct/contracts"
import { registerSession, notifyQuestionAnswered, sendQuestionAsked, sendStop, postMirror } from "./daemon-client"
import { QuestionDeliveryQueue } from "./question-queue"
import { StopDeliveryQueue, StopKeyMinter } from "./stop-queue"
import { detectEnvironment, type EnvironmentInfo } from "./env-detect"
import { startDirectChannelServer } from "./direct-channel"
import { MessageTail } from "./message-tail"
import { TokenTracker, ProviderCache, type MessageTokenInfo } from "./token-tracker"
import { SessionManager, normalizeTitle } from "./session-state"
import { createSwarmReadTool, SWARM_READ_TOOL_NAME } from "./swarm-tool"
import { createSwarmSendTool, SWARM_SEND_TOOL_NAME } from "./swarm-send-tool"
import { createSwarmListTool, SWARM_LIST_TOOL_NAME } from "./swarm-list-tool"
import { createSwarmScheduleTool, SWARM_SCHEDULE_TOOL_NAME } from "./swarm-schedule-tool"
import { createSwarmScheduledTool, SWARM_SCHEDULED_TOOL_NAME } from "./swarm-scheduled-tool"
import { resolveServeAuthHeader } from "./serve-auth"
import { errorMessage, serializeError, isAbortError } from "./utils"

const plugin: Plugin = async (ctx) => {
  try {
    // OpenCode's SDK client uses a custom in-process fetch that calls
    // Server.App().fetch() directly (no network I/O). In TUI mode, no HTTP
    // server is running, so raw fetch() to ctx.serverUrl fails. Extract
    // the SDK client's internal fetch to use for question reply calls.
    const sdkClientConfig = (ctx.client as any)._client?.getConfig?.()
    const internalFetch: typeof fetch = sdkClientConfig?.fetch ?? globalThis.fetch

    // SDK-native logging wrapper
    const log = (message: string, data?: unknown): void => {
      try {
        const serializedData = data ? serializeError(data) : undefined
        ctx.client.app.log({
          body: {
            service: "opencode-pigeon",
            level: "info",
            message,
            extra: serializedData ? { data: serializedData } : undefined,
          },
        })
      } catch {}
    }

    const sessionManager = new SessionManager()

    const daemonUrl =
      process.env.PIGEON_DAEMON_URL ??
      `http://127.0.0.1:${process.env.TELEGRAM_WEBHOOK_PORT ?? "4731"}`

    const messageTail = new MessageTail({
      postMirror: (opts) => postMirror({ ...opts, daemonUrl, log }),
      // Deliberately the STRICT predicate, not `isMainSession`. A session whose
      // parentage could not be established is treated as main everywhere else so it
      // keeps notifying, but it must not mirror: if it turns out to be a subagent,
      // the mirror posts a full task brief into a Telegram topic (`pigeon-kq6h`).
      isMainSession: (sessionId) => sessionManager.isConfirmedMain(sessionId),
      getDiscoveryPromise: (sessionId) => sessionManager.getDiscoveryPromise(sessionId),
      log,
    })

    // Start TTL eviction for stale sessions (24h staleness, 1h interval)
    sessionManager.startEviction()
    messageTail.startEviction()

    const tokenTracker = new TokenTracker()
    const providerCache = new ProviderCache(log)

    const questionQueue = new QuestionDeliveryQueue({
      log,
      onExpired: (sessionId, requestId) => {
        log("WARN: question delivery permanently failed", { sessionId, requestId })
      },
    })
    /**
     * Stop/error notifications go through a retry queue for the same reason questions
     * do: the POST to the daemon is the one hop that was neither breaker-free nor
     * durable, so a stop that landed while the breaker was open was dropped outright
     * and nothing ever retried it (pigeon-mavq). Past the daemon's front door the
     * outbox already guarantees delivery.
     */
    const stopKeys = new StopKeyMinter()
    const stopQueue = new StopDeliveryQueue({
      log,
      onExpired: (entry, info) => {
        log("WARN: stop delivery permanently failed", {
          sessionId: entry.sessionId,
          notificationId: entry.notificationId,
          event: entry.event ?? "Stop",
          ...info,
        })
      },
      onEvicted: (entry) => {
        log("WARN: stop dropped, queue at capacity", {
          sessionId: entry.sessionId,
          notificationId: entry.notificationId,
        })
      },
    })

    questionQueue.start((entry) =>
      sendQuestionAsked({
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        questions: entry.questions,
        label: entry.label,
        title: entry.title,
        daemonUrl,
        log,
      })
    )

    const directChannel = await startDirectChannelServer({
      async onExecute(request: ExecuteCommandEnvelope) {
        try {
          // Use internalFetch directly instead of ctx.client.session.promptAsync()
          // because the SDK method silently fails in serve mode — it returns
          // without error but the prompt is never actually delivered to the session.
          const promptUrl = new URL(
            `/session/${encodeURIComponent(request.sessionId)}/prompt_async`,
            ctx.serverUrl,
          )
          const headers: Record<string, string> = { "Content-Type": "application/json" }
          const authHeader = resolveServeAuthHeader()
          if (authHeader) {
            headers["Authorization"] = authHeader
          }

          // Build parts array: always include text, optionally include file
          const parts: Array<Record<string, unknown>> = []
          if (request.command) {
            parts.push({ type: "text", text: request.command })
          }
          if (request.media) {
            parts.push({
              type: "file",
              mime: request.media.mime,
              filename: request.media.filename,
              url: request.media.url,
            })
          }
          if (parts.length === 0) {
            parts.push({ type: "text", text: "" })
          }

          const modelOverride = request.metadata?.model as string | undefined

          const promptBody: Record<string, unknown> = {
            parts,
            noReply: false,
          }

          if (modelOverride) {
            const slashIndex = modelOverride.indexOf("/")
            const providerID = slashIndex >= 0 ? modelOverride.slice(0, slashIndex) : modelOverride
            const modelID = slashIndex >= 0 ? modelOverride.slice(slashIndex + 1) : ""
            promptBody.model = { providerID, modelID }
          }

          const res = await internalFetch(
            new Request(promptUrl.toString(), {
              method: "POST",
              headers,
              body: JSON.stringify(promptBody),
              signal: AbortSignal.timeout(10_000),
            }),
          )

          if (!res.ok) {
            const text = await res.text().catch(() => "")
            return {
              success: false,
              errorCode: ResultErrorCode.ExecutionError,
              errorMessage: `prompt_async failed: ${res.status} ${text}`,
            }
          }

          return {
            success: true,
            output: "queued",
          }
        } catch (error) {
          return {
            success: false,
            errorCode: ResultErrorCode.ExecutionError,
            errorMessage: error instanceof Error ? error.message : String(error),
          }
        }
      },

      async onQuestionReply(request) {
        try {
          // Use the SDK client's in-process fetch — in TUI mode no HTTP server
          // is running, so raw fetch() to ctx.serverUrl would fail.
          const replyUrl = new URL(
            `/question/${encodeURIComponent(request.questionRequestId)}/reply`,
            ctx.serverUrl,
          )
          log("question-reply: attempting fetch", {
            serverUrl: String(ctx.serverUrl),
            replyUrl: replyUrl.toString(),
            questionRequestId: request.questionRequestId,
            directory: ctx.directory,
          })
          // Build a Request object — the in-process Hono fetch expects
          // a Request, not a bare URL object.
          // CRITICAL: include x-opencode-directory so the server resolves
          // the correct Instance context (where the pending question lives).
          // Without this, opencode serve falls back to process.cwd() which
          // is the wrong project, causing "reply for unknown request".
          const replyHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            "x-opencode-directory": ctx.directory,
          }
          const authHeader = resolveServeAuthHeader()
          if (authHeader) {
            replyHeaders["Authorization"] = authHeader
          }
          const res = await internalFetch(
            new Request(replyUrl.toString(), {
              method: "POST",
              headers: replyHeaders,
              body: JSON.stringify({ answers: request.answers }),
              signal: AbortSignal.timeout(10_000),
            }),
          )

          if (!res.ok) {
            const text = await res.text().catch(() => "")
            return {
              success: false,
              errorCode: ResultErrorCode.ExecutionError,
              errorMessage: `OpenCode question reply failed: ${res.status} ${text}`,
            }
          }

          return { success: true }
        } catch (error) {
          log("question-reply: fetch error", {
            serverUrl: ctx.serverUrl,
            error: error instanceof Error ? { message: error.message, name: error.name, stack: error.stack } : String(error),
          })
          return {
            success: false,
            errorCode: ResultErrorCode.ExecutionError,
            errorMessage: error instanceof Error ? error.message : String(error),
          }
        }
      },
    })

    const envInfoP = detectEnvironment(ctx.$, log).catch((err) => {
      log("env detection failed, using fallback", serializeError(err))
      return { pid: process.pid, ppid: process.ppid } as EnvironmentInfo
    })

    const label = ctx.directory.split("/").filter(Boolean).pop() ?? "unknown"

    /**
     * Initiates background session registration with the daemon.
     *
     * CRITICAL: MUST remain synchronous. Do NOT make this function `async` or
     * `await regPromise` inside it. It immediately records
     * `regPromise` on `sessionManager` so downstream handlers calling
     * `awaitRegistration(sessionID)` wait on the HTTP request without blocking
     * the plugin's event dispatcher.
     *
     * `envInfo` is passed as an already-resolved value (leaving `await envInfoP`
     * at call sites) so `regPromise` recorded in `sessionManager` is the actual
     * `registerSession` promise. `title` is optional by design because the fallback
     * path in `lateDiscoverSession` (where `session.get()` fails) has no title.
     */
    const doRegisterSession = (
      sessionID: string,
      envInfo: EnvironmentInfo,
      title?: string,
    ): Promise<void> => {
      const regPromise = registerSession({
        sessionId: sessionID,
        cwd: ctx.directory,
        label,
        title,
        pid: envInfo.pid,
        ppid: envInfo.ppid,
        tty: envInfo.tty,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: OPENCODE_DIRECT_PROTOCOL_VERSION,
        backendEndpoint: directChannel.endpoint,
        backendAuthToken: directChannel.authToken,
        daemonUrl,
        log,
      })
        .then((result) => {
          log("registerSession result", { sessionID, result })
          if (result?.ok) {
            sessionManager.onRegistered(sessionID)
          }
        })
        .catch((err) => {
          log("registerSession error:", serializeError(err))
        })
      sessionManager.setRegistrationPromise(sessionID, regPromise)
      // Returned as well as recorded: a caller repairing a 404 (see stopQueue below)
      // may be acting for a session whose plugin-side entry is already gone, and
      // `awaitRegistration` has nothing to wait on in that case.
      return regPromise
    }

    /**
     * Deliver one queued stop, repairing the one failure a retry alone cannot fix.
     *
     * A 404 means the daemon does not know this session. That is not necessarily a
     * dead session: the daemon's reaper deletes a row after 7 days idle while the
     * plugin still believes it is registered, so `ensureRegistered` never re-registers
     * and the answer to a long-idle session's next prompt would be dropped forever.
     * Re-register from the entry's own fields and try once more; a second 404 is
     * terminal, since repeating it cannot produce a different answer.
     */
    stopQueue.start(async (entry) => {
      const outcome = await sendStop({ ...entry, daemonUrl, log })
      if (outcome !== "unregistered") return outcome

      log("stop delivery hit an unknown session; re-registering", {
        sessionId: entry.sessionId,
      })
      const envInfo = await envInfoP
      await doRegisterSession(entry.sessionId, envInfo, entry.title)

      return await sendStop({ ...entry, daemonUrl, log })
    })

    // Late session discovery: if we miss session.created (plugin loaded after session exists),
    // register the session when we first see its ID in any event.
    const lateDiscoverSession = async (sessionID: string) => {
      if (sessionManager.isKnown(sessionID)) return

      let promise = sessionManager.getDiscoveryPromise(sessionID)
      if (promise) {
        await promise
        return
      }

      promise = (async () => {
        log("late session discovery", { sessionID })

        const envInfo = await envInfoP

        try {
          const session = await ctx.client.session.get({ path: { id: sessionID } })
          const parentID = session.data?.parentID
          const title = session.data?.title

          sessionManager.onSessionCreated(sessionID, parentID, title)

          if (!parentID) {
            doRegisterSession(sessionID, envInfo, title)
          }
        } catch (err) {
          // Fallback: parentage is UNKNOWN, not "no parent". The session is still
          // treated as main so stops/errors/questions keep flowing (failing closed
          // here is what makes a real session go silent, invisibly), but it is not
          // *confirmed* main, so it will not mirror prompts. A later `session.updated`
          // can only resolve this ONE way: if the session is really a subagent it is
          // demoted, while a genuine main session stays unconfirmed and never mirrors
          // again (`pigeon-nwrt`). See `pigeon-kq6h`.
          log("session.get failed, registering with unknown parentage", serializeError(err))
          sessionManager.onSessionCreated(sessionID, undefined, undefined, "unknown")
          doRegisterSession(sessionID, envInfo)
        }
      })()

      sessionManager.setDiscoveryPromise(sessionID, promise)
      try {
        await promise
      } finally {
        sessionManager.clearDiscoveryPromise(sessionID)
      }
    }

    /**
     * Settle discovery and registration for a session, retrying a registration
     * that previously failed.
     *
     * A failed registration (daemon timeout, transient 5xx) used to leave a
     * session known-but-unregistered forever: `lateDiscoverSession` returns
     * early on `isKnown`, so nothing retried. Every notification path below is
     * gated on `isRegistered`, so the session then went permanently silent --
     * and invisibly so, because the daemon may well have recorded the session
     * before the client's 1s timeout fired.
     *
     * Retrying here, at the notification sites, is self-limiting: these events
     * are human-paced, and the daemon client's circuit breaker bounds the cost
     * when the daemon is genuinely down.
     */
    const ensureRegistered = async (sessionID: string): Promise<void> => {
      await lateDiscoverSession(sessionID)
      await sessionManager.awaitRegistration(sessionID)

      if (
        sessionManager.isMainSession(sessionID) &&
        !sessionManager.isRegistered(sessionID)
      ) {
        log("retrying failed session registration", { sessionID })
        const envInfo = await envInfoP
        doRegisterSession(sessionID, envInfo, sessionManager.getTitle(sessionID))
        await sessionManager.awaitRegistration(sessionID)
      }
    }

    return {
      tool: {
        // Anthropic rejects tool names with characters outside
        // ^[a-zA-Z0-9_-]{1,128}$ -- so this MUST stay underscore-joined.
        // See SWARM_READ_TOOL_NAME comment in swarm-tool.ts for history.
        [SWARM_READ_TOOL_NAME]: createSwarmReadTool(daemonUrl),
        [SWARM_SEND_TOOL_NAME]: createSwarmSendTool(daemonUrl),
        [SWARM_LIST_TOOL_NAME]: createSwarmListTool(String(ctx.serverUrl), internalFetch),
        [SWARM_SCHEDULE_TOOL_NAME]: createSwarmScheduleTool(daemonUrl),
        [SWARM_SCHEDULED_TOOL_NAME]: createSwarmScheduledTool(daemonUrl),
      },
      event: async (input) => {
        const { event } = input
        // Widen event.type to string to support newer event types (question.*) not yet in SDK
        const eventType = event.type as string
        const props = event.properties as Record<string, unknown> | undefined

        if (eventType === "session.created") {
          const sessionInfo = props?.info as
            | { id?: string; title?: string; parentID?: string }
            | undefined

          const sessionID = sessionInfo?.id
          const parentID = sessionInfo?.parentID
          const title = sessionInfo?.title

          log("session.created", { sessionID, parentID, title })

          if (!sessionID) return

          sessionManager.onSessionCreated(sessionID, parentID, title)

          if (!parentID) {
            const envInfo = await envInfoP
            // Note: session.created fires before opencode generates the title,
            // so sessionInfo.title here is usually a placeholder.
            // Session titles are subsequently updated when session.updated events arrive.
            doRegisterSession(sessionID, envInfo, title)
          }

          return
        }

        if (eventType === "session.updated") {
          const sessionInfo = props?.info as
            | { id?: string; title?: string; parentID?: string }
            | undefined

          const sessionID = sessionInfo?.id
          const parentID = sessionInfo?.parentID
          const rawTitle = sessionInfo?.title

          if (!sessionID) return

          // A `parentID` here is free, authoritative evidence, and it is the one
          // repair available for a session whose `session.get` failed during late
          // discovery: it demotes a subagent that was optimistically treated as main,
          // stopping both its stop-notifications and its prompt mirror
          // (`pigeon-kq6h`). Runs before the early returns below, which discard it.
          //
          // Only a PRESENT parentID is acted on, and only for a session whose
          // parentage is still unknown -- non-promotion lives in `resolveParentage`
          // itself, which returns early when `parentID` is absent. (The separate
          // `isMainSession` guard below, pinned since `2fd9a56`, is what stops an
          // omitted parentID reaching the title path.)
          //
          // Awaiting an in-flight discovery first: `lateDiscoverSession` is dispatched
          // fire-and-forget, and the session is not `isKnown` until it settles. A slow
          // `session.get` timeout makes that window seconds wide, and a short-lived
          // subagent may emit its only `session.updated` inside it -- discarding this
          // event would forfeit the one repair available.
          if (parentID && !sessionManager.isKnown(sessionID)) {
            const discovery = sessionManager.getDiscoveryPromise(sessionID)
            if (discovery) await discovery.catch(() => {})
          }

          if (sessionManager.resolveParentage(sessionID, parentID)) {
            log("demoted a registered session to subagent; its daemon registration is now stale", {
              sessionID,
              parentID,
            })
          }

          if (parentID) return
          if (!sessionManager.isKnown(sessionID) || !sessionManager.isMainSession(sessionID)) return

          const title = typeof rawTitle === "string" ? normalizeTitle(rawTitle) : undefined
          if (!title) return
          if (sessionManager.getTitle(sessionID) === title) return

          log("session.updated", { sessionID, parentID, rawTitle })

          sessionManager.setTitle(sessionID, title)

          const envInfo = await envInfoP
          doRegisterSession(sessionID, envInfo, title)

          return
        }

         if (eventType === "session.idle") {
           const sessionID = props?.sessionID as string | undefined

           if (!sessionID) return

           log("DEBUG session.idle received", { sessionID })

           // Ensure discovery + registration have settled before checking isRegistered
           await ensureRegistered(sessionID)

           log("DEBUG session.idle after awaitRegistration", {
             sessionID,
             isMain: sessionManager.isMainSession(sessionID),
             isRegistered: sessionManager.isRegistered(sessionID),
             currentMsgId: messageTail.getCurrentMessageId(sessionID),
           })

           // Deliberately NOT gated on isRegistered. A registration that failed (the
           // daemon was restarting, the breaker was open) used to make the session
           // return here and lose the notification entirely. The queue's sender
           // re-registers on a 404, so enqueueing is strictly safer than dropping.
           if (sessionManager.isMainSession(sessionID)) {
             const currentMsgId = messageTail.getCurrentMessageId(sessionID)
             if (!sessionManager.shouldNotify(sessionID, currentMsgId)) {
               log("DEBUG session.idle shouldNotify=false; returning", { sessionID, currentMsgId })
               return
             }

              // Set dedup guard SYNCHRONOUSLY before the async work below
              sessionManager.setNotified(sessionID, currentMsgId!)

              // Copy: getFiles returns the live array that tool attachments push into,
              // so a retry could otherwise carry files from a later turn.
              const files = [...messageTail.getFiles(sessionID)]
              const summary = messageTail.consume(sessionID) || "Task completed"
              const tokenFooter = await tokenTracker.getFooter(sessionID, ctx.client, providerCache)
              const messageWithFooter = tokenFooter ? `${summary}\n\n${tokenFooter}` : summary
              log("enqueueing stop", { sessionID, summary: summary.slice(0, 100), hasTokenFooter: !!tokenFooter })
              stopQueue.enqueue({
                sessionId: sessionID,
                notificationId: stopKeys.mint(sessionID, currentMsgId ?? "idle"),
                message: messageWithFooter,
                label,
                title: sessionManager.getTitle(sessionID),
                media: files.length > 0 ? files : undefined,
              })
           }

           return
         }

        if (eventType === "message.updated") {
          const info = props?.info as
            | { id?: string; sessionID?: string; role?: string }
            | undefined

          if (info?.id && info?.sessionID && info?.role) {
            lateDiscoverSession(info.sessionID).catch(() => {})

            const role = info.role as string
            if (role === "user" || role === "assistant") {
              messageTail.onMessageUpdated({
                id: info.id,
                sessionID: info.sessionID,
                role,
              })

              if (role === "assistant") {
                tokenTracker.onMessageUpdated(props?.info as MessageTokenInfo)
              }
            }

            if (info.sessionID) {
              sessionManager.onBusy(info.sessionID)
            }
          }

          return
        }

        if (eventType === "message.part.updated") {
          const part = props?.part as any
          const delta = props?.delta as string | undefined

          if (part?.id && part?.sessionID && part?.messageID && part?.type) {
            lateDiscoverSession(part.sessionID).catch(() => {})
            messageTail.onPartUpdated(part, delta)
          }

          return
        }

        if (eventType === "session.deleted") {
          const sessionInfo = props?.info as { id?: string } | undefined
          const sessionID = sessionInfo?.id

          if (sessionID) {
            sessionManager.onDeleted(sessionID)
            messageTail.clear(sessionID)
            tokenTracker.clear(sessionID)
          }

          return
        }

        if (eventType === "session.error") {
          const sessionID = props?.sessionID as string | undefined
          const error = props?.error

          if (sessionID) {
            await ensureRegistered(sessionID)

            if (sessionManager.isMainSession(sessionID)) {
              const errorMarker = `error:${sessionID}`
              if (!sessionManager.shouldNotify(sessionID, errorMarker)) {
                sessionManager.onDeleted(sessionID)
                messageTail.clear(sessionID)
                tokenTracker.clear(sessionID)
                return
              }

              sessionManager.setNotified(sessionID, errorMarker)

              const errorMsg = error
                ? `Error: ${errorMessage(error)}`
                : "Session error occurred"

              // The accumulated narration explains what the session was doing when it
              // failed. It is a send site like any other, so it consumes -- clear-on-send
              // stays structural.
              const narration = messageTail.consume(sessionID)
              const body = narration ? `${narration}\n\n${errorMsg}` : errorMsg

              const errorKind = isAbortError(error) ? "aborted" : undefined

              // Enqueued BEFORE onDeleted below wipes this session's plugin state --
              // the entry carries everything the delivery (and a re-registration)
              // needs, so it survives the teardown that follows.
              stopQueue.enqueue({
                sessionId: sessionID,
                notificationId: stopKeys.mint(sessionID, "error"),
                event: "Error",
                message: body,
                label,
                title: sessionManager.getTitle(sessionID),
                errorKind,
              })
            }

            sessionManager.onDeleted(sessionID)
            messageTail.clear(sessionID)
            tokenTracker.clear(sessionID)
          }

          return
        }

        if (eventType === "question.asked") {
          const questionProps = props as {
            id?: string
            sessionID?: string
            questions?: Array<{
              question: string
              header: string
              options: Array<{ label: string; description: string }>
              multiple?: boolean
              custom?: boolean
            }>
          } | undefined

          const sessionID = questionProps?.sessionID
          const requestId = questionProps?.id
          const questions = questionProps?.questions

          if (!sessionID || !requestId || !questions || questions.length === 0) return

          // Only notify for main sessions that are registered
          await ensureRegistered(sessionID)

          if (
            !sessionManager.isMainSession(sessionID) ||
            !sessionManager.isRegistered(sessionID)
          ) return

           log("question.asked", { sessionID, requestId, questionCount: questions.length })

           // Enqueue question delivery FIRST — this bypasses the circuit breaker
           // and retries automatically until the daemon accepts.
           questionQueue.enqueue({
             sessionId: sessionID,
             requestId,
             questions,
             label,
             title: sessionManager.getTitle(sessionID),
           })

           // Flush any unnotified assistant text as a stop notification.
           // Fire-and-forget: stop flush failure must NOT block question delivery.
            const currentMsgId = messageTail.getCurrentMessageId(sessionID)
            if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
              sessionManager.setNotified(sessionID, currentMsgId!)
               // Copy: getFiles returns the live array tool attachments push into.
               const files = [...messageTail.getFiles(sessionID)]
               const summary = messageTail.consume(sessionID)
               if (summary || files.length > 0) {
                 // Enqueue with the text we have NOW; append the footer only if it
                 // arrives. The footer fetch has no timeout of its own and used to sit
                 // between consume() and the send, so a hang there consumed the text
                 // and then never sent it.
                 const body = summary || "Output files attached"
                 const entry = {
                   sessionId: sessionID,
                   notificationId: stopKeys.mint(sessionID, currentMsgId ?? "question"),
                   message: body,
                   label,
                   title: sessionManager.getTitle(sessionID),
                   media: files.length > 0 ? files : undefined,
                 }
                 void (async () => {
                   try {
                     const tokenFooter = await tokenTracker.getFooter(sessionID, ctx.client, providerCache)
                     if (tokenFooter) entry.message = `${body}\n\n${tokenFooter}`
                   } catch (err) {
                     log("token footer failed before question flush (non-blocking):", serializeError(err))
                   }
                 })()
                 stopQueue.enqueue(entry)
               }
            }

          return
        }

        if (eventType === "session.status") {
          const sessionID = props?.sessionID as string | undefined
          const status = props?.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined

          if (!sessionID || !status || status.type !== "retry") return

          // Only notify for main sessions that are registered
          await ensureRegistered(sessionID)
          if (
            !sessionManager.isMainSession(sessionID) ||
            !sessionManager.isRegistered(sessionID)
          ) return

          const retryMsg = `Retry #${status.attempt ?? "?"}: ${status.message ?? "unknown error"}`
          const nextAt = status.next ? new Date(status.next).toLocaleTimeString() : "unknown"
          log("session retry detected", { sessionID, attempt: status.attempt, message: status.message, next: nextAt })

          // Single attempt, deliberately NOT queued. A rate-limit storm emits one of
          // these per session every 30-60s, so queueing them would let a daemon outage
          // fill the queue with notices that are stale by the next attempt anyway --
          // evicting the actual answers the queue exists to protect.
          sendStop({
            sessionId: sessionID,
            notificationId: stopKeys.mint(sessionID, `retry${status.attempt ?? 0}`),
            event: "Retry",
            message: `${retryMsg}\nNext attempt at ${nextAt}`,
            label,
            title: sessionManager.getTitle(sessionID),
            daemonUrl,
            log,
          }).catch((err) => {
            log("retry notification error:", serializeError(err))
          })

          return
        }

        if (eventType === "question.replied" || eventType === "question.rejected") {
          const sessionID = props?.sessionID as string | undefined
          const requestID = props?.requestID as string | undefined

          if (!sessionID) return

          // Clear pending question in daemon (it may have been answered from the TUI)
          notifyQuestionAnswered({
            sessionId: sessionID,
            requestId: requestID,
            daemonUrl,
            log,
          }).catch((err) => {
            log("notifyQuestionAnswered error:", serializeError(err))
          })

          return
        }
      },
    }
  } catch (err) {
    const errorLog = (message: string, data?: unknown): void => {
      try {
        const serializedData = data ? serializeError(data) : undefined
        ctx.client.app.log({
          body: {
            service: "opencode-pigeon",
            level: "error",
            message,
            extra: serializedData ? { data: serializedData } : undefined,
          },
        })
      } catch {}
    }
    errorLog("plugin initialization error:", serializeError(err))
    throw err
  }
}

export default plugin

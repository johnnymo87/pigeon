import type { Plugin } from "@opencode-ai/plugin"
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  ResultErrorCode,
  type ExecuteCommandEnvelope,
} from "../../daemon/src/opencode-direct/contracts"
import { registerSession, notifyStop, notifyQuestionAnswered, sendQuestionAsked } from "./daemon-client"
import { QuestionDeliveryQueue } from "./question-queue"
import { detectEnvironment, type EnvironmentInfo } from "./env-detect"
import { startDirectChannelServer } from "./direct-channel"
import { MessageTail } from "./message-tail"
import { SessionManager } from "./session-state"
import { errorMessage, serializeError } from "./utils"

const plugin: Plugin = async (ctx) => {
  try {
    // OpenCode's SDK client uses a custom in-process fetch that calls
    // Server.App().fetch() directly (no network I/O). In TUI mode, no HTTP
    // server is running, so raw fetch() to ctx.serverUrl fails. Extract
    // the SDK client's internal fetch to use for question reply calls.
    const sdkClientConfig = (ctx.client as any)._client?.getConfig?.()
    const internalFetch: typeof fetch = sdkClientConfig?.fetch ?? globalThis.fetch

    const messageTail = new MessageTail()
    const sessionManager = new SessionManager()

    // Start TTL eviction for stale sessions (24h staleness, 1h interval)
    sessionManager.startEviction()
    messageTail.startEviction()

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

    const daemonUrl =
      process.env.PIGEON_DAEMON_URL ??
      `http://127.0.0.1:${process.env.TELEGRAM_WEBHOOK_PORT ?? "4731"}`

    const questionQueue = new QuestionDeliveryQueue({
      log,
      onExpired: (sessionId, requestId) => {
        log("WARN: question delivery permanently failed", { sessionId, requestId })
      },
    })
    questionQueue.start((entry) =>
      sendQuestionAsked({
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        questions: entry.questions,
        label: entry.label,
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
          const res = await internalFetch(
            new Request(replyUrl.toString(), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-opencode-directory": ctx.directory,
              },
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

    // Late session discovery: if we miss session.created (plugin loaded after session exists),
    // register the session when we first see its ID in any event.
     const lateDiscoverSession = async (sessionID: string) => {
       if (sessionManager.isKnown(sessionID)) return

       log("late session discovery", { sessionID })

       const envInfo = await envInfoP

       try {
         const session = await ctx.client.session.get({ path: { id: sessionID } })
         const parentID = session.data?.parentID

         sessionManager.onSessionCreated(sessionID, parentID)

          if (!parentID) {
            const regPromise = registerSession({
              sessionId: sessionID,
              cwd: ctx.directory,
              label,
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
         }
       } catch (err) {
         // Fallback: register without parentID
         log("session.get failed, registering without parentID", serializeError(err))
         sessionManager.onSessionCreated(sessionID, undefined)
          const regPromise = registerSession({
            sessionId: sessionID,
            cwd: ctx.directory,
            label,
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
        }
      }

    return {
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

          log("session.created", { sessionID, parentID })

          if (!sessionID) return

           sessionManager.onSessionCreated(sessionID, parentID)

            if (!parentID) {
              const envInfo = await envInfoP
              const regPromise = registerSession({
                sessionId: sessionID,
                cwd: ctx.directory,
                label,
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
           }

          return
        }

         if (eventType === "session.idle") {
           const sessionID = props?.sessionID as string | undefined

           if (!sessionID) return

           // Await pending registration before checking isRegistered
           await sessionManager.awaitRegistration(sessionID)

           if (
             sessionManager.isMainSession(sessionID) &&
             sessionManager.isRegistered(sessionID)
           ) {
             const currentMsgId = messageTail.getCurrentMessageId(sessionID)
             if (!sessionManager.shouldNotify(sessionID, currentMsgId)) return

             // Set dedup guard SYNCHRONOUSLY before async notifyStop
             sessionManager.setNotified(sessionID, currentMsgId!)

              const summary = messageTail.getSummary(sessionID) || "Task completed"
              const files = messageTail.getFiles(sessionID)
              log("sending notifyStop", { sessionID, summary: summary.slice(0, 100) })
              notifyStop({
                sessionId: sessionID,
                message: summary,
                label,
                media: files.length > 0 ? files : undefined,
                daemonUrl,
                log,
              }).catch((err) => {
                 log("notifyStop error:", serializeError(err))
               })
           }

           return
         }

        if (eventType === "message.updated") {
          const info = props?.info as
            | { id?: string; sessionID?: string; role?: string }
            | undefined

          if (info?.id && info?.sessionID && info?.role) {
            lateDiscoverSession(info.sessionID)

            const role = info.role as string
            if (role === "user" || role === "assistant") {
              messageTail.onMessageUpdated({
                id: info.id,
                sessionID: info.sessionID,
                role,
              })
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
          }

          return
        }

        if (eventType === "session.error") {
          const sessionID = props?.sessionID as string | undefined
          const error = props?.error

          if (sessionID) {
            if (
              sessionManager.isMainSession(sessionID) &&
              sessionManager.isRegistered(sessionID)
            ) {
              const errorMarker = `error:${sessionID}`
              if (!sessionManager.shouldNotify(sessionID, errorMarker)) {
                sessionManager.onDeleted(sessionID)
                messageTail.clear(sessionID)
                return
              }

              sessionManager.setNotified(sessionID, errorMarker)

              const errorMsg = error
                ? `Error: ${errorMessage(error)}`
                : "Session error occurred"

              notifyStop({
                sessionId: sessionID,
                message: errorMsg,
                label,
                daemonUrl,
                log,
              }).catch((err) => {
                 log("notifyStop error:", serializeError(err))
               })
            }

            sessionManager.onDeleted(sessionID)
            messageTail.clear(sessionID)
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
          await lateDiscoverSession(sessionID)
          await sessionManager.awaitRegistration(sessionID)

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
           })

           // Flush any unnotified assistant text as a stop notification.
           // Fire-and-forget: stop flush failure must NOT block question delivery.
           const currentMsgId = messageTail.getCurrentMessageId(sessionID)
           if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
             sessionManager.setNotified(sessionID, currentMsgId!)
             const summary = messageTail.getSummary(sessionID)
             if (summary) {
               const files = messageTail.getFiles(sessionID)
               notifyStop({
                 sessionId: sessionID,
                 message: summary,
                 label,
                 media: files.length > 0 ? files : undefined,
                 daemonUrl,
                 log,
               }).catch((err) => {
                 log("stop flush before question failed (non-blocking):", serializeError(err))
               })
             }
           }

          return
        }

        if (eventType === "question.replied" || eventType === "question.rejected") {
          const sessionID = props?.sessionID as string | undefined

          if (!sessionID) return

          // Clear pending question in daemon (it may have been answered from the TUI)
          notifyQuestionAnswered({
            sessionId: sessionID,
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

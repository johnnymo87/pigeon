import type { Plugin } from "@opencode-ai/plugin"
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  ResultErrorCode,
  type ExecuteCommandEnvelope,
} from "../../daemon/src/opencode-direct/contracts"
import { registerSession, notifyStop } from "./daemon-client"
import { detectEnvironment, type EnvironmentInfo } from "./env-detect"
import { startDirectChannelServer } from "./direct-channel"
import { MessageTail } from "./message-tail"
import { SessionManager } from "./session-state"
import { serializeError } from "./utils"

const plugin: Plugin = async (ctx) => {
  try {
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

    const directChannel = await startDirectChannelServer({
      async onExecute(request: ExecuteCommandEnvelope) {
        try {
          await ctx.client.session.promptAsync({
            path: { id: request.sessionId },
            body: {
              parts: [
                {
                  type: "text",
                  text: request.command,
                },
              ],
              noReply: false,
            },
          })

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
        const props = event.properties as Record<string, unknown> | undefined

        if (event.type === "session.created") {
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

         if (event.type === "session.idle") {
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
             log("sending notifyStop", { sessionID, summary: summary.slice(0, 100) })
             notifyStop({
               sessionId: sessionID,
               message: summary,
               label,
               daemonUrl,
               log,
             }).catch((err) => {
                log("notifyStop error:", serializeError(err))
              })
           }

           return
         }

        if (event.type === "message.updated") {
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

        if (event.type === "message.part.updated") {
          const part = props?.part as any
          const delta = props?.delta as string | undefined

          if (part?.id && part?.sessionID && part?.messageID && part?.type) {
            messageTail.onPartUpdated(part, delta)
          }

          return
        }

        if (event.type === "session.deleted") {
          const sessionInfo = props?.info as { id?: string } | undefined
          const sessionID = sessionInfo?.id

          if (sessionID) {
            sessionManager.onDeleted(sessionID)
            messageTail.clear(sessionID)
          }

          return
        }

        if (event.type === "session.error") {
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
                ? `Error: ${String(error)}`
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

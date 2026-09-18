import { serializeError } from "./utils"

export const PIGEON_LOG_SERVICE = "opencode-pigeon"

export type LogSink = (line: string) => void

export type LogClient = {
  app: { log: (args: unknown) => unknown }
}

export type CreateLogOptions = {
  level?: "debug" | "info" | "warn" | "error"
  /** Where to report a log that could not be delivered. Defaults to stderr. */
  fallback?: LogSink
  serialize?: (data: unknown) => unknown
}

const defaultFallback: LogSink = (line) => {
  // Deliberately not log() -- the whole point is that log() is the thing failing.
  process.stderr.write(`${line}\n`)
}

/**
 * Build the plugin's logging function.
 *
 * Two non-obvious constraints, both established empirically on 2026-09-18 rather
 * than read off the types:
 *
 * NESTED BODY. The runtime hands plugins the v1 SDK client, whose `app.log`
 * takes `{ body: {...} }`. The v2 client takes flat parameters instead. A probe
 * plugin confirmed the split: nested returned `{data: true}` and its line landed
 * in opencode.log; flat returned BadRequest "Expected object, got undefined".
 *
 * SERVICE MUST TRAVEL IN `extra`. opencode's /log handler accepts `service` in
 * its schema and then throws it away -- it calls Effect.logInfo(message)
 * annotated with `extra` only. `extra` keys ARE rendered, so putting service
 * there produces `service=opencode-pigeon` on the line, which is precisely the
 * form people search for. Without it the plugin's logs are real but
 * unattributable, which is how ~12,700 live log lines were mistaken for "the
 * plugin has no log path" and an investigation was forced onto correlational
 * evidence instead. The top-level field is kept too, so that a server version
 * which stops discarding it needs no change here.
 */
export function createLog(client: LogClient, opts: CreateLogOptions = {}) {
  const level = opts.level ?? "info"
  const fallback = opts.fallback ?? defaultFallback
  const serialize = opts.serialize ?? serializeError

  const report = (reason: unknown, message: string): void => {
    try {
      const detail = reason instanceof Error ? reason.message : JSON.stringify(reason)
      fallback(`[${PIGEON_LOG_SERVICE}] log delivery failed: ${detail} -- original message: ${message}`)
    } catch {
      // A failing fallback must never propagate into a caller that only wanted
      // to log something.
    }
  }

  return (message: string, data?: unknown): void => {
    try {
      const serialized = data === undefined ? undefined : serialize(data)
      const result = client.app.log({
        body: {
          service: PIGEON_LOG_SERVICE,
          level,
          message,
          extra: serialized === undefined ? { service: PIGEON_LOG_SERVICE } : { service: PIGEON_LOG_SERVICE, data: serialized },
        },
      })

      // hey-api clients RESOLVE with {error} rather than rejecting, so an
      // unchecked return -- not the old empty catch -- is what would hide a
      // silent regression such as a move to the v2 client shape.
      const settled = result as { then?: unknown } | undefined
      if (settled && typeof settled.then === "function") {
        Promise.resolve(settled as Promise<{ error?: unknown }>).then(
          (value) => {
            if (value && typeof value === "object" && "error" in value && value.error) {
              report(value.error, message)
            }
          },
          (err) => report(err, message),
        )
      }
    } catch (err) {
      report(err, message)
    }
  }
}

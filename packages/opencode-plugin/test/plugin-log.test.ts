import { describe, expect, it, vi } from "vitest"
import { PIGEON_LOG_SERVICE, createLog } from "../src/plugin-log"

/**
 * These tests pin behaviour that was established empirically on 2026-09-18, not
 * guessed. Two findings drive them:
 *
 *   1. opencode's /log handler DISCARDS the `service` field of the payload
 *      (server/routes/instance/httpapi/handlers/control.ts -- it calls
 *      Effect.logInfo(message) annotated with `extra` only). Anything we want to
 *      search by must travel in `extra`, which IS annotated. Verified against a
 *      live serve: posting extra {service: "opencode-pigeon"} renders the line as
 *      `... message="..." service=opencode-pigeon data.sessionID=ses_x`.
 *
 *   2. The runtime plugin client is the v1 SDK, which takes a NESTED
 *      {body: {...}} argument. Verified with a probe plugin: nested returned
 *      {data: true} and its line landed in opencode.log; the flat v2 shape
 *      returned BadRequest "Expected object, got undefined".
 *
 * The consequence of (1) was three days of plugin logs that existed but could not
 * be found by the obvious search, which is what made this bug look like "the
 * plugin has no log path".
 */

const flush = () => new Promise((r) => setTimeout(r, 0))

function clientReturning(ret: unknown) {
  const log = vi.fn().mockReturnValue(ret)
  return { client: { app: { log } } as any, log }
}

describe("createLog", () => {
  it("uses the exact service string people grep for", () => {
    // Pinned as a literal: every other assertion compares against the exported
    // constant, so renaming it would otherwise pass while breaking the searches
    // this whole change exists to enable.
    expect(PIGEON_LOG_SERVICE).toBe("opencode-pigeon")
  })

  it("sends the NESTED v1 body shape the runtime client actually accepts", () => {
    const { client, log } = clientReturning({ data: true })
    createLog(client)("hello")
    expect(log).toHaveBeenCalledTimes(1)
    const arg = log.mock.calls[0][0]
    // Nested, not flat: a flat payload is rejected by the server as BadRequest.
    expect(arg).toHaveProperty("body")
    expect(arg.body.message).toBe("hello")
    expect(arg.body.level).toBe("info")
  })

  it("carries service in `extra` so the line is searchable by service=", () => {
    // Regression guard for the actual defect: the server drops payload.service,
    // so a line whose service lives only there is unattributable in the log file.
    const { client, log } = clientReturning({ data: true })
    createLog(client)("hello")
    expect(log.mock.calls[0][0].body.extra?.service).toBe(PIGEON_LOG_SERVICE)
  })

  it("still sets the top-level service field for future server versions", () => {
    const { client, log } = clientReturning({ data: true })
    createLog(client)("hello")
    expect(log.mock.calls[0][0].body.service).toBe(PIGEON_LOG_SERVICE)
  })

  it("puts caller data under extra.data without losing service", () => {
    const { client, log } = clientReturning({ data: true })
    createLog(client)("hello", { sessionID: "ses_1" })
    const extra = log.mock.calls[0][0].body.extra
    expect(extra.data).toEqual({ sessionID: "ses_1" })
    expect(extra.service).toBe(PIGEON_LOG_SERVICE)
  })

  it("omits extra.data when no data is supplied, but keeps service", () => {
    const { client, log } = clientReturning({ data: true })
    createLog(client)("hello")
    const extra = log.mock.calls[0][0].body.extra
    // toStrictEqual, not toEqual: toEqual treats {data: undefined} as absent and
    // would pass against a version that always attaches the key.
    expect(extra).toStrictEqual({ service: PIGEON_LOG_SERVICE })
    expect("data" in extra).toBe(false)
  })

  it("honours the configured level", () => {
    const { client, log } = clientReturning({ data: true })
    createLog(client, { level: "error" })("boom")
    expect(log.mock.calls[0][0].body.level).toBe("error")
  })

  it("reports an SDK result carrying `error` to the fallback sink", async () => {
    // hey-api clients RESOLVE with {error} rather than throwing. An unchecked
    // return is what would hide a future shape drift -- e.g. a move to the v2
    // client, where this nested call silently becomes a 400 no-op and every
    // plugin log vanishes. That must be loud.
    const fallback = vi.fn()
    const { client } = clientReturning(Promise.resolve({ error: { name: "BadRequest" } }))
    createLog(client, { fallback })("hello")
    await flush()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0][0]).toContain("hello")
    // Pin the reason too: stringifying the error object as "[object Object]"
    // would satisfy a message-only assertion while losing the diagnosis.
    expect(fallback.mock.calls[0][0]).toContain("BadRequest")
  })

  it("reports a rejected promise to the fallback sink", async () => {
    const fallback = vi.fn()
    const { client } = clientReturning(Promise.reject(new Error("socket died")))
    createLog(client, { fallback })("hello")
    await flush()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0][0]).toContain("socket died")
  })

  it("reports a synchronous throw to the fallback sink", async () => {
    const fallback = vi.fn()
    const client = {
      app: {
        log: () => {
          throw new Error("client exploded")
        },
      },
    } as any
    expect(() => createLog(client, { fallback })("hello")).not.toThrow()
    await flush()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0][0]).toContain("client exploded")
  })

  it("stays silent on success", async () => {
    const fallback = vi.fn()
    const { client } = clientReturning(Promise.resolve({ data: true }))
    createLog(client, { fallback })("hello")
    await flush()
    expect(fallback).not.toHaveBeenCalled()
  })

  it("tolerates a client that returns a non-promise", async () => {
    const fallback = vi.fn()
    const { client } = clientReturning(undefined)
    expect(() => createLog(client, { fallback })("hello")).not.toThrow()
    await flush()
    expect(fallback).not.toHaveBeenCalled()
  })

  it("never lets a throwing fallback escape into the caller", async () => {
    const fallback = vi.fn(() => {
      throw new Error("sink exploded")
    })
    const { client } = clientReturning(Promise.reject(new Error("socket died")))
    expect(() => createLog(client, { fallback })("hello")).not.toThrow()
    await flush()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("does not block the caller on the network round trip", () => {
    // Logging sits in hot paths (session.idle, message tails). It must remain
    // fire-and-forget: a pending promise must not stop log() from returning.
    const { client } = clientReturning(new Promise(() => {}))
    const started = Date.now()
    expect(createLog(client)("hello")).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it("serializes data with the injected serializer", () => {
    const { client, log } = clientReturning({ data: true })
    const serialize = vi.fn().mockReturnValue({ shaped: true })
    createLog(client, { serialize })("hello", new Error("x"))
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0].body.extra.data).toEqual({ shaped: true })
  })
})

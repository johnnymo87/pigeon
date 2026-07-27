import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { resolveServeAuthHeader, invalidateServeAuthHeader } from "../src/serve-auth"

describe("resolveServeAuthHeader", () => {
  const origPass = process.env.OPENCODE_SERVER_PASSWORD
  const origUser = process.env.OPENCODE_SERVER_USERNAME

  beforeEach(() => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_USERNAME
    invalidateServeAuthHeader()
  })

  afterEach(() => {
    if (origPass !== undefined) {
      process.env.OPENCODE_SERVER_PASSWORD = origPass
    } else {
      delete process.env.OPENCODE_SERVER_PASSWORD
    }
    if (origUser !== undefined) {
      process.env.OPENCODE_SERVER_USERNAME = origUser
    } else {
      delete process.env.OPENCODE_SERVER_USERNAME
    }
    invalidateServeAuthHeader()
  })

  it("returns undefined when OPENCODE_SERVER_PASSWORD is unset", () => {
    expect(resolveServeAuthHeader()).toBeUndefined()
  })

  it("returns undefined when OPENCODE_SERVER_PASSWORD is empty string", () => {
    process.env.OPENCODE_SERVER_PASSWORD = ""
    expect(resolveServeAuthHeader()).toBeUndefined()
  })

  it("returns undefined when OPENCODE_SERVER_PASSWORD is whitespace-only", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "   \n\t "
    expect(resolveServeAuthHeader()).toBeUndefined()
  })

  it("returns Basic base64(opencode:pass) when password set and username unset", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret-pass"
    const expectedBase64 = Buffer.from("opencode:secret-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expectedBase64}`)
  })

  it("returns Basic base64(opencode:pass) when username is empty or whitespace-only", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret-pass"
    process.env.OPENCODE_SERVER_USERNAME = "   "
    const expectedBase64 = Buffer.from("opencode:secret-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expectedBase64}`)
  })

  it("returns Basic base64(custom_user:pass) when username is set", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret-pass"
    process.env.OPENCODE_SERVER_USERNAME = "myuser"
    const expectedBase64 = Buffer.from("myuser:secret-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expectedBase64}`)
  })

  it("trims whitespace from password and username", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "  secret-pass  \n"
    process.env.OPENCODE_SERVER_USERNAME = "  myuser  \t"
    const expectedBase64 = Buffer.from("myuser:secret-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expectedBase64}`)
  })

  it("caches resolved header until invalidateServeAuthHeader is called", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "first-pass"
    const expected1 = Buffer.from("opencode:first-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expected1}`)

    process.env.OPENCODE_SERVER_PASSWORD = "second-pass"
    expect(resolveServeAuthHeader()).toBe(`Basic ${expected1}`)

    invalidateServeAuthHeader()
    const expected2 = Buffer.from("opencode:second-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expected2}`)
  })

  it("supports forceRefresh option", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "first-pass"
    const expected1 = Buffer.from("opencode:first-pass").toString("base64")
    expect(resolveServeAuthHeader()).toBe(`Basic ${expected1}`)

    process.env.OPENCODE_SERVER_PASSWORD = "second-pass"
    const expected2 = Buffer.from("opencode:second-pass").toString("base64")
    expect(resolveServeAuthHeader({ forceRefresh: true })).toBe(`Basic ${expected2}`)
  })
})

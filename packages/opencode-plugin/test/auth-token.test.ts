import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { resolveDaemonToken, invalidateDaemonToken } from "../src/auth-token"

describe("resolveDaemonToken", () => {
  const origEnv = process.env.PIGEON_DAEMON_AUTH_TOKEN
  const origFileEnv = process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
  let tmpDir: string
  let tmpFilePath: string

  beforeEach(() => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-auth-test-"))
    tmpFilePath = path.join(tmpDir, "secret_token")
  })

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.PIGEON_DAEMON_AUTH_TOKEN = origEnv
    } else {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    }
    if (origFileEnv !== undefined) {
      process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = origFileEnv
    } else {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    }
    invalidateDaemonToken()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns token when PIGEON_DAEMON_AUTH_TOKEN env var is set and trimmed", () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN = "  env-secret-123  \n"
    expect(resolveDaemonToken()).toBe("env-secret-123")
  })

  it("returns token when env is unset but secret file is readable", () => {
    fs.writeFileSync(tmpFilePath, "  file-secret-456  \n", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = tmpFilePath
    expect(resolveDaemonToken()).toBe("file-secret-456")
  })

  it("returns undefined when neither env nor readable secret file is available", () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = path.join(tmpDir, "nonexistent")
    expect(resolveDaemonToken()).toBeUndefined()
  })

  it("env var takes precedence over the secret file", () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN = "env-wins"
    fs.writeFileSync(tmpFilePath, "file-loses", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = tmpFilePath
    expect(resolveDaemonToken()).toBe("env-wins")
  })

  it("whitespace-only env var falls through to the file", () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN = "   \n\t "
    fs.writeFileSync(tmpFilePath, "file-fallback-token", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = tmpFilePath
    expect(resolveDaemonToken()).toBe("file-fallback-token")
  })

  it("caches resolved token until invalidateDaemonToken is called", () => {
    fs.writeFileSync(tmpFilePath, "initial-token", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = tmpFilePath

    expect(resolveDaemonToken()).toBe("initial-token")

    // Update file on disk
    fs.writeFileSync(tmpFilePath, "updated-token", "utf8")

    // Should still return cached value
    expect(resolveDaemonToken()).toBe("initial-token")

    // Invalidate cache
    invalidateDaemonToken()

    // Should return updated value
    expect(resolveDaemonToken()).toBe("updated-token")
  })

  it("caches undefined resolution until invalidateDaemonToken is called", () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = tmpFilePath
    expect(resolveDaemonToken()).toBeUndefined()

    // Now write secret file
    fs.writeFileSync(tmpFilePath, "late-arriving-token", "utf8")

    // Still returns cached undefined
    expect(resolveDaemonToken()).toBeUndefined()

    // Invalidate cache
    invalidateDaemonToken()

    // Now resolves new token
    expect(resolveDaemonToken()).toBe("late-arriving-token")
  })
})

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { detectEnvironment } from "../src/env-detect"

/**
 * Creates a mock PluginInput["$"] that captures shell commands.
 * `shellResponses` maps command substrings to response text.
 * E.g. { "lsof": "p123\nf0\nn/dev/ttys003\n" }
 */
const createPluginInput = (shellResponses: Record<string, string> = {}) =>
  ({
    nothrow() {
      return (strings: TemplateStringsArray, ...values: unknown[]) => {
        const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")
        const matchKey = Object.keys(shellResponses).find((k) => cmd.includes(k))
        return {
          async text() {
            return matchKey ? shellResponses[matchKey] : ""
          },
        }
      }
    },
  }) as any

const noopLog = () => {}

describe("detectEnvironment tty detection", () => {
  const readlinkSpy = spyOn(fs, "readlink")

  beforeEach(() => {
    delete process.env.TMUX
    readlinkSpy.mockReset()
  })

  afterEach(() => {
    readlinkSpy.mockReset()
  })

  test("returns EnvironmentInfo with tty when /proc/self/fd/0 is a PTY", async () => {
    readlinkSpy.mockResolvedValue("/dev/pts/12" as any)

    const info = await detectEnvironment(createPluginInput(), noopLog)

    expect(info.pid).toBe(process.pid)
    expect(info.ppid).toBe(process.ppid)
    expect("tty" in info).toBe(true)
    expect((info as any).tty).toBe("/dev/pts/12")
    expect(readlinkSpy).toHaveBeenCalledWith("/proc/self/fd/0")
  })

  test("falls back to /proc/<ppid>/fd/0 when self fd is not a PTY", async () => {
    readlinkSpy.mockImplementation(async (path: any) => {
      if (path === "/proc/self/fd/0") {
        return "pipe:[12345]" as any
      }
      if (path === `/proc/${process.ppid}/fd/0`) {
        return "/dev/pts/8" as any
      }
      throw new Error(`unexpected path: ${String(path)}`)
    })

    const info = await detectEnvironment(createPluginInput(), noopLog)

    expect((info as any).tty).toBe("/dev/pts/8")
    expect(readlinkSpy).toHaveBeenNthCalledWith(1, "/proc/self/fd/0")
    expect(readlinkSpy).toHaveBeenNthCalledWith(2, `/proc/${process.ppid}/fd/0`)
  })

  test("sets tty to undefined when neither self nor ppid fd points to a PTY", async () => {
    readlinkSpy.mockImplementation(async (path: any) => {
      if (path === "/proc/self/fd/0") {
        return "/dev/null" as any
      }
      if (path === `/proc/${process.ppid}/fd/0`) {
        return "pipe:[555]" as any
      }
      throw new Error(`unexpected path: ${String(path)}`)
    })

    const info = await detectEnvironment(createPluginInput(), noopLog)

    expect((info as any).tty).toBeUndefined()
    expect(readlinkSpy).toHaveBeenNthCalledWith(1, "/proc/self/fd/0")
    expect(readlinkSpy).toHaveBeenNthCalledWith(2, `/proc/${process.ppid}/fd/0`)
  })

  test("only accepts tty paths matching /^\\/dev\\/(pts\\/\\d+|tty\\w*)$/", async () => {
    readlinkSpy.mockImplementation(async (path: any) => {
      if (path === "/proc/self/fd/0") {
        return "/dev/pts/not-a-number" as any
      }
      if (path === `/proc/${process.ppid}/fd/0`) {
        return "/dev/ttyS0" as any
      }
      throw new Error(`unexpected path: ${String(path)}`)
    })

    const info = await detectEnvironment(createPluginInput(), noopLog)

    expect((info as any).tty).toBe("/dev/ttyS0")
  })

  test("rejects pipe paths like pipe:[12345]", async () => {
    readlinkSpy.mockResolvedValue("pipe:[12345]" as any)

    const info = await detectEnvironment(createPluginInput(), noopLog)

    expect((info as any).tty).toBeUndefined()
  })
})

describe("detectEnvironment macOS tty detection (lsof fallback)", () => {
  const readlinkSpy = spyOn(fs, "readlink")

  beforeEach(() => {
    delete process.env.TMUX
    readlinkSpy.mockReset()
    // Simulate macOS: /proc doesn't exist, readlink always throws
    readlinkSpy.mockRejectedValue(new Error("ENOENT"))
  })

  afterEach(() => {
    readlinkSpy.mockReset()
  })

  test("detects TTY via lsof when /proc is unavailable (macOS)", async () => {
    const $ = createPluginInput({
      [`lsof -p ${process.pid}`]: `p${process.pid}\nf0\nn/dev/ttys003\n`,
    })

    const info = await detectEnvironment($, noopLog)

    expect(info.tty).toBe("/dev/ttys003")
  })

  test("falls back to lsof on ppid when self has no TTY", async () => {
    const $ = createPluginInput({
      [`lsof -p ${process.pid}`]: `p${process.pid}\nf0\nn/dev/null\n`,
      [`lsof -p ${process.ppid}`]: `p${process.ppid}\nf0\nn/dev/ttys007\n`,
    })

    const info = await detectEnvironment($, noopLog)

    expect(info.tty).toBe("/dev/ttys007")
  })

  test("returns undefined when lsof finds no TTY on either pid", async () => {
    const $ = createPluginInput({
      [`lsof -p ${process.pid}`]: `p${process.pid}\nf0\nnpipe\n`,
      [`lsof -p ${process.ppid}`]: `p${process.ppid}\nf0\nnpipe\n`,
    })

    const info = await detectEnvironment($, noopLog)

    expect(info.tty).toBeUndefined()
  })

  test("handles lsof not being available (returns empty)", async () => {
    const $ = createPluginInput({})

    const info = await detectEnvironment($, noopLog)

    expect(info.tty).toBeUndefined()
  })
})

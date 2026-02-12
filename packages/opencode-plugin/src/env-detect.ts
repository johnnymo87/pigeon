import type { PluginInput } from "@opencode-ai/plugin"
import { readlink } from "node:fs/promises"

type LogFn = (message: string, data?: unknown) => void

export type EnvironmentInfo = {
  tty?: string
  pid: number
  ppid: number
}

async function ttyFromLsof($: PluginInput["$"], pid: number, ttyRegex: RegExp): Promise<string | undefined> {
  try {
    const safe = $.nothrow()
    const result = await safe`lsof -p ${String(pid)} -a -d 0 -Fn`.text()
    const match = result.match(/\nn(\/dev\/\S+)/)
    const device = match?.[1]
    if (device && ttyRegex.test(device)) {
      return device
    }
  } catch {}
  return undefined
}

export async function detectEnvironment($: PluginInput["$"], log: LogFn): Promise<EnvironmentInfo> {
  const info: EnvironmentInfo = {
    pid: process.pid,
    ppid: process.ppid,
  }

  // TTY detection
  let tty: string | undefined
  const ttyRegex = /^\/dev\/(pts\/\d+|tty\w*)$/

  try {
    const selfPath = await readlink("/proc/self/fd/0")
    if (ttyRegex.test(selfPath)) {
      tty = selfPath
    }
  } catch {}

  if (!tty) {
    try {
      const ppidPath = await readlink(`/proc/${String(process.ppid)}/fd/0`)
      if (ttyRegex.test(ppidPath)) {
        tty = ppidPath
      }
    } catch {}
  }

  // macOS fallback: /proc doesn't exist, use lsof to find stdin's device
  if (!tty) {
    tty = await ttyFromLsof($, process.pid, ttyRegex)
  }
  if (!tty) {
    tty = await ttyFromLsof($, process.ppid, ttyRegex)
  }

  if (tty) {
    info.tty = tty
  }

  return info
}

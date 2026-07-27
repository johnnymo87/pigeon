import * as fs from "node:fs"

let cachedToken: string | undefined | null = null

/**
 * Resolve pigeon daemon bearer token at call time using contract:
 * 1. process.env.PIGEON_DAEMON_AUTH_TOKEN (trimmed)
 * 2. secret file (e.g. /run/secrets/pigeon_daemon_auth_token or process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE) (trimmed)
 * 3. undefined
 *
 * Lazily caches resolved value until invalidateDaemonToken() is called.
 */
export function resolveDaemonToken(opts?: {
  forceRefresh?: boolean
  tokenFilePath?: string
}): string | undefined {
  if (opts?.forceRefresh) {
    cachedToken = null
  }

  if (cachedToken !== null) {
    return cachedToken
  }

  // 1. process.env.PIGEON_DAEMON_AUTH_TOKEN
  const envToken = process.env.PIGEON_DAEMON_AUTH_TOKEN?.trim()
  if (envToken) {
    cachedToken = envToken
    return cachedToken
  }

  // 2. Secret file
  const filePath =
    opts?.tokenFilePath ??
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE ??
    "/run/secrets/pigeon_daemon_auth_token"

  try {
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, "utf8").trim()
      if (fileContent) {
        cachedToken = fileContent
        return cachedToken
      }
    }
  } catch {
    // Ignore unreadable file / permission errors
  }

  // 3. Fallback
  cachedToken = undefined
  return cachedToken
}

/**
 * Invalidate cached daemon token (e.g. on 401 response).
 * Next call to resolveDaemonToken will re-check env and secret file.
 */
export function invalidateDaemonToken(): void {
  cachedToken = null
}

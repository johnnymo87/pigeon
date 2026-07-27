let cachedHeader: string | undefined | null = null

/**
 * Resolve opencode serve HTTP Basic auth header at call time.
 *
 * 1. Read process.env.OPENCODE_SERVER_PASSWORD (trimmed).
 * 2. If password is unset or empty, returns undefined (auth is off).
 * 3. Read process.env.OPENCODE_SERVER_USERNAME (trimmed, default "opencode").
 * 4. Return "Basic <base64>" for username:password.
 *
 * Lazily caches resolved value until invalidateServeAuthHeader() is called.
 */
export function resolveServeAuthHeader(opts?: {
  forceRefresh?: boolean
}): string | undefined {
  if (opts?.forceRefresh) {
    cachedHeader = null
  }

  if (cachedHeader !== null) {
    return cachedHeader
  }

  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim()
  if (!password) {
    cachedHeader = undefined
    return cachedHeader
  }

  const envUsername = process.env.OPENCODE_SERVER_USERNAME?.trim()
  const username = envUsername || "opencode"

  const credentials = `${username}:${password}`
  cachedHeader = `Basic ${Buffer.from(credentials).toString("base64")}`
  return cachedHeader
}

/**
 * Invalidate cached serve auth header (e.g. on potential credential updates).
 * Next call to resolveServeAuthHeader will re-check process.env.
 */
export function invalidateServeAuthHeader(): void {
  cachedHeader = null
}

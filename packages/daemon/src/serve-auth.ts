import * as fs from "node:fs";

let cachedHeader: string | undefined | null = null;

/**
 * Resolve opencode serve HTTP Basic auth header at call time.
 *
 * 1. Read process.env.OPENCODE_SERVER_PASSWORD (trimmed).
 * 2. If password env is unset/empty, read secret file (trimmed):
 *    opts.passwordFilePath ?? process.env.OPENCODE_SERVER_PASSWORD_FILE ?? "/run/secrets/opencode_server_password"
 * 3. If password is unset or empty, returns undefined (auth is off).
 * 4. Read process.env.OPENCODE_SERVER_USERNAME (trimmed, default "opencode").
 * 5. Return "Basic <base64>" for username:password.
 *
 * Lazily caches resolved value until invalidateServeAuthHeader() is called.
 */
export function resolveServeAuthHeader(opts?: {
  forceRefresh?: boolean;
  passwordFilePath?: string;
}): string | undefined {
  if (opts?.forceRefresh) {
    cachedHeader = null;
  }

  if (cachedHeader !== null) {
    return cachedHeader;
  }

  let password = process.env.OPENCODE_SERVER_PASSWORD?.trim();

  if (!password) {
    const filePath =
      opts?.passwordFilePath ??
      process.env.OPENCODE_SERVER_PASSWORD_FILE ??
      "/run/secrets/opencode_server_password";

    try {
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, "utf8").trim();
        if (fileContent) {
          password = fileContent;
        }
      }
    } catch {
      // Ignore unreadable file / permission errors
    }
  }

  if (!password) {
    cachedHeader = undefined;
    return cachedHeader;
  }

  const envUsername = process.env.OPENCODE_SERVER_USERNAME?.trim();
  const username = envUsername || "opencode";

  const credentials = `${username}:${password}`;
  cachedHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;
  return cachedHeader;
}

/**
 * Invalidate cached serve auth header (e.g. on 401 response).
 * Next call to resolveServeAuthHeader will re-check process.env and secret file.
 */
export function invalidateServeAuthHeader(): void {
  cachedHeader = null;
}

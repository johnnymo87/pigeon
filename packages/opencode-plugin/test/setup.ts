import { beforeEach } from "vitest"

// Force PIGEON_DAEMON_URL to an unroutable address for all plugin tests.
// Defaults in src/index.ts and src/daemon-client.ts fall back to http://127.0.0.1:4731,
// which is the live production daemon on this machine.
// Setting PIGEON_DAEMON_URL to port 1 ensures unmocked daemon client calls fail
// loudly with ECONNREFUSED rather than silently writing to the developer's live daemon.
process.env.PIGEON_DAEMON_URL = "http://127.0.0.1:1"

// Same isolation principle, second production resource (dx8p Stage 1).
// resolveDaemonToken() (src/auth-token.ts) resolves the bearer at CALL TIME and
// falls back to /run/secrets/pigeon_daemon_auth_token when the env var is unset.
// That file DOES NOT exist on a dev box but WILL exist on cloudbox once the
// sops secret is deployed -- at which point an unpinned test would read the real
// production token and, worse, could hand it to a mock server. Pin it to an
// unreadable path so no test can ever reach the live secret.
const TEST_NO_TOKEN_PATH = "/nonexistent/pigeon-test-no-token"
process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = TEST_NO_TOKEN_PATH

beforeEach(() => {
  if (!process.env.PIGEON_DAEMON_URL) {
    process.env.PIGEON_DAEMON_URL = "http://127.0.0.1:1"
  }
  if (
    process.env.PIGEON_DAEMON_URL.includes(":4731") ||
    process.env.TELEGRAM_WEBHOOK_PORT === "4731"
  ) {
    throw new Error(
      "Test isolation guard: PIGEON_DAEMON_URL or TELEGRAM_WEBHOOK_PORT targets live production daemon port 4731!"
    )
  }
  if (process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE === "/run/secrets/pigeon_daemon_auth_token") {
    throw new Error(
      "Test isolation guard: PIGEON_DAEMON_AUTH_TOKEN_FILE targets the live production secret!"
    )
  }
})

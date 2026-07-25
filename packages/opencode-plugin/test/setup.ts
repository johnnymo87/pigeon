import { beforeEach } from "vitest"

// Force PIGEON_DAEMON_URL to an unroutable address for all plugin tests.
// Defaults in src/index.ts and src/daemon-client.ts fall back to http://127.0.0.1:4731,
// which is the live production daemon on this machine.
// Setting PIGEON_DAEMON_URL to port 1 ensures unmocked daemon client calls fail
// loudly with ECONNREFUSED rather than silently writing to the developer's live daemon.
process.env.PIGEON_DAEMON_URL = "http://127.0.0.1:1"

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
})

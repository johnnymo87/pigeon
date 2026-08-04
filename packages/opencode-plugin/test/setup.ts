import { beforeEach } from "vitest"
import * as fs from "node:fs"
import { invalidateDaemonToken } from "../src/auth-token"

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
  // RE-pin, do not merely check. Pinning once at module load was not enough:
  // the several tests that legitimately point this at a tmpdir token file
  // `delete` the variable in their finally block rather than restoring the
  // pin, which leaves resolveDaemonToken() falling back to its hardcoded
  // /run/secrets/pigeon_daemon_auth_token default. On cloudbox that file
  // exists, so whichever test ran next read the LIVE production token and
  // handed it to a mock fetch -- precisely the outcome the comment above says
  // must never happen. Observed as an order-dependent failure of "includes
  // Authorization Bearer header only when authToken is set", which asserts no
  // header and instead saw a real `Bearer <production token>`; reproduced on
  // unmodified main under `--sequence.shuffle --sequence.seed=2`.
  //
  // The guard below could not catch it because it tests for the production
  // path STRING, while the leak works by the variable being ABSENT. Restoring
  // the pin every test makes the unpinned state unobservable regardless of
  // what the previous test did or forgot to undo.
  process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = TEST_NO_TOKEN_PATH
  delete process.env.PIGEON_DAEMON_AUTH_TOKEN
  // The resolver memoises, so a stale cache would outlive the re-pin.
  invalidateDaemonToken()

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
  // Enforce the property the pin exists for, rather than trusting the path
  // string: whatever it points at must be UNREADABLE, so a token can only ever
  // come from something a test created on purpose.
  if (fs.existsSync(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE!)) {
    throw new Error(
      `Test isolation guard: PIGEON_DAEMON_AUTH_TOKEN_FILE (${process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE}) ` +
        "is readable at test start; tests must not begin with a resolvable daemon token."
    )
  }
})

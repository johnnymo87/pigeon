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
const PRODUCTION_TOKEN_PATH = "/run/secrets/pigeon_daemon_auth_token"
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
  // The string guard below could not catch it because it tests for the
  // production path STRING, while the leak works by the variable being ABSENT.
  // Restoring the pin every test makes the unpinned state unobservable
  // regardless of what the previous test did or forgot to undo.
  //
  // Repair rather than report. 34 call sites across 6 test files delete this
  // variable in a finally block, and for at least one of them that is CORRECT
  // -- auth-token.test.ts deletes it precisely to exercise the resolver's
  // fallback to the production path. So an unpinned hand-off is not itself a
  // test bug, and warning about it would emit 30+ lines per run that everyone
  // would learn to ignore. The invariant is enforced by the guard below
  // instead, which is checked on every single test.
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
  if (process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE === PRODUCTION_TOKEN_PATH) {
    throw new Error(
      "Test isolation guard: PIGEON_DAEMON_AUTH_TOKEN_FILE targets the live production secret!"
    )
  }
  // THE structural guard: assert no token is RESOLVABLE at test start, rather
  // than that a particular variable holds a particular string.
  //
  // It deliberately reproduces resolveDaemonToken()'s own fallback, because
  // the leak that motivated this fires when the variable is ABSENT -- and a
  // check written against the variable cannot see that (`existsSync(undefined)`
  // is simply false). Computing the EFFECTIVE path is what makes this catch the
  // absent case, so it still fires if someone deletes the re-pin above.
  //
  // existsSync rather than a readability probe: a token can only come from a
  // file that exists, so non-existence is the property that actually matters.
  const effectiveTokenPath =
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE ?? PRODUCTION_TOKEN_PATH
  if (process.env.PIGEON_DAEMON_AUTH_TOKEN || fs.existsSync(effectiveTokenPath)) {
    throw new Error(
      "Test isolation guard: a daemon auth token is resolvable at test start " +
        `(PIGEON_DAEMON_AUTH_TOKEN ${process.env.PIGEON_DAEMON_AUTH_TOKEN ? "is set" : "unset"}, ` +
        `effective token file ${effectiveTokenPath}). Tests must only ever see a ` +
        "token they created themselves."
    )
  }
})

import { afterEach, beforeEach } from "vitest"
import { invalidateDaemonToken, resolveDaemonToken } from "../src/auth-token"

// Force PIGEON_DAEMON_URL to an unroutable address for all plugin tests.
// Defaults in src/index.ts and src/daemon-client.ts fall back to http://127.0.0.1:4731,
// which is the live production daemon on this machine.
// Setting PIGEON_DAEMON_URL to port 1 ensures unmocked daemon client calls fail
// loudly with ECONNREFUSED rather than silently writing to the developer's live daemon.
process.env.PIGEON_DAEMON_URL = "http://127.0.0.1:1"

// Same isolation principle, second production resource (dx8p Stage 1).
// resolveDaemonToken() (src/auth-token.ts) resolves the bearer at CALL TIME and
// falls back to /run/secrets/pigeon_daemon_auth_token when the env var is unset.
// That file DOES NOT exist on a dev box but DOES exist on cloudbox, readable by
// the user running the tests -- at which point an unpinned test would read the
// real production token and, worse, could hand it to a mock server. Pin it to an
// unreadable path so no test can ever reach the live secret.
const PRODUCTION_TOKEN_PATH = "/run/secrets/pigeon_daemon_auth_token"
const TEST_NO_TOKEN_PATH = "/nonexistent/pigeon-test-no-token"

/**
 * Restore the pin and drop any memoised token.
 *
 * Applied both BEFORE and AFTER every test. Pinning once at module load was not
 * enough: 10 call sites across the suite point this variable at a tmpdir token
 * file and then `delete` it in a finally block rather than restoring the pin,
 * which leaves resolveDaemonToken() falling back to its hardcoded
 * /run/secrets/pigeon_daemon_auth_token default. On cloudbox that file exists,
 * so whichever test ran next read the LIVE production token and handed it to a
 * mock fetch -- precisely the outcome the comment above says must never happen.
 * Observed as an order-dependent failure of "includes Authorization Bearer
 * header only when authToken is set", which asserts no header and instead saw a
 * real `Bearer <production token>`; reproduced on unmodified main under
 * `--sequence.shuffle --sequence.seed=2`.
 *
 * Repairing in a hook rather than at the call sites is deliberate: the invariant
 * then lives in ONE place and cannot be forgotten by a future test. The afterEach
 * closes the window between a test's finally block and the next test's
 * beforeEach, which is where stragglers and afterAll hooks run.
 */
function pinTokenFile(): void {
  process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = TEST_NO_TOKEN_PATH
  delete process.env.PIGEON_DAEMON_AUTH_TOKEN
  // The resolver memoises, so a stale cache would outlive the re-pin.
  invalidateDaemonToken()
}

// NOTE: this mechanism relies on hooks running in "stack" order, which vitest
// resolves by default and which vitest.config.ts now pins explicitly. Under
// "stack", this setup file's afterEach runs LAST (reverse registration order),
// so it overwrites anything a test file's own afterEach did to the variable.
//
// It also assumes tests do not run concurrently within a file: process.env is
// process-global, so `test.concurrent` would interleave mid-body and no hook
// discipline could save it. There are currently zero uses of `test.concurrent`
// in this package, and they must not be introduced without revisiting this.
beforeEach(() => {
  pinTokenFile()

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
  // Cheap early tripwire for the most obvious way to get this wrong.
  if (process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE === PRODUCTION_TOKEN_PATH) {
    throw new Error(
      "Test isolation guard: PIGEON_DAEMON_AUTH_TOKEN_FILE targets the live production secret!"
    )
  }

  // THE structural guard: assert no token is RESOLVABLE at test start, rather
  // than that a particular variable holds a particular string.
  //
  // It asks the REAL resolver rather than re-implementing its precedence here.
  // An earlier version duplicated the `env ?? hardcoded default` fallback, which
  // would have kept passing -- while guarding the wrong thing -- if auth-token.ts
  // ever changed its default path or precedence. Probing the resolver means this
  // tracks those semantics for free.
  //
  // The probe is why the pin must come first: post-pin the effective path is
  // /nonexistent/..., so this costs one failed existsSync and reads the
  // production file only in the case where the leak has ALREADY happened.
  const resolvable = resolveDaemonToken({ forceRefresh: true })
  invalidateDaemonToken() // never leave a probed token in the memo
  if (resolvable) {
    // Deliberately does NOT print the token: it may be the live secret, and
    // test output ends up in CI logs.
    throw new Error(
      "Test isolation guard: a daemon auth token is resolvable at test start " +
        `(PIGEON_DAEMON_AUTH_TOKEN ${process.env.PIGEON_DAEMON_AUTH_TOKEN ? "is set" : "unset"}, ` +
        `effective token file ${process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE ?? PRODUCTION_TOKEN_PATH}). ` +
        "Tests must only ever see a token they created themselves."
    )
  }
})

// Repair the pin as soon as the test body (and the test file's own afterEach
// hooks) are done, so the unpinned state is never observable between tests --
// by an afterAll hook, a straggler promise, or anything else. The beforeEach
// above would paper over a missing afterEach, so test/setup-isolation.test.ts
// asserts this hook's effect directly.
afterEach(() => {
  pinTokenFile()
})

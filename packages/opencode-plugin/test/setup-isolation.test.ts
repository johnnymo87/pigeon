import { afterAll, describe, expect, test } from "vitest"
import { resolveDaemonToken, invalidateDaemonToken } from "../src/auth-token"

/**
 * Regression tests for the token-pin harness in test/setup.ts.
 *
 * These exist because the harness is the ONLY thing standing between the test
 * suite and the live production bearer at /run/secrets/pigeon_daemon_auth_token,
 * which on cloudbox exists and is readable by the user running the tests. A
 * previous version pinned PIGEON_DAEMON_AUTH_TOKEN_FILE once at module load;
 * tests that deleted the variable in a `finally` left the resolver falling back
 * to that production path, and real tokens reached mock fetch servers.
 *
 * The harness now re-pins in BOTH beforeEach and afterEach. Nothing else in the
 * suite would fail if the afterEach were deleted -- the beforeEach would paper
 * over it -- so without the test below that removal would be silent.
 */
describe("test/setup.ts token-pin harness", () => {
  const PINNED = "/nonexistent/pigeon-test-no-token"

  test("beforeEach pins the token file path before each test", () => {
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBe(PINNED)
  })

  test("no daemon token is resolvable inside a test", () => {
    expect(resolveDaemonToken({ forceRefresh: true })).toBeUndefined()
    invalidateDaemonToken()
  })

  test("simulates a call site that deletes the pin in a finally block", () => {
    // Verbatim the shape of the 10 cleanup sites across the suite. Deliberately
    // leaves the variable unset at test end; the afterAll below asserts that
    // setup.ts's afterEach repaired it.
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBeUndefined()
  })

  // afterAll runs after the last test's afterEach hooks, so this observes the
  // state setup.ts's afterEach left behind. It is order-independent: whichever
  // test runs last, the pin must be restored by the time we get here.
  afterAll(() => {
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBe(PINNED)
    expect(resolveDaemonToken({ forceRefresh: true })).toBeUndefined()
    invalidateDaemonToken()
  })
})

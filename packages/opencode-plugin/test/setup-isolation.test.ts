import { afterAll, describe, expect, test } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
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
 *
 * `shuffle: false` is required, not cosmetic. The detector works by leaving the
 * variable unset at the end of one test and asserting in afterAll that the
 * harness repaired it; if the shuffled order puts that test anywhere but last,
 * the next test's beforeEach papers over the damage and the detector silently
 * loses its power. Verified: with the afterEach removed, seeds 1/2/4/5 fail but
 * seed 3 passes. Vitest shuffles tests WITHIN a suite under --sequence.shuffle,
 * so this suite opts out.
 */
describe("test/setup.ts token-pin harness", { shuffle: false }, () => {
  const PINNED = "/nonexistent/pigeon-test-no-token"

  test("beforeEach pins the token file path before each test", () => {
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBe(PINNED)
  })

  test("no daemon token is resolvable inside a test", () => {
    // typeof, not toBeUndefined(): a failure message from the latter would print
    // the resolved value, which in the failing case is a real production token.
    expect(typeof resolveDaemonToken({ forceRefresh: true })).toBe("undefined")
    invalidateDaemonToken()
  })

  test("simulates a call site that deletes the pin in a finally block", () => {
    // Verbatim the shape of the 10 cleanup sites across the suite. Deliberately
    // leaves the variable unset at test end; the afterAll below asserts that
    // setup.ts's afterEach repaired it. MUST be the last test in this suite.
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBeUndefined()
  })

  // afterAll runs after the last test's afterEach hooks, so this observes the
  // state setup.ts's afterEach left behind.
  afterAll(() => {
    expect(process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE).toBe(PINNED)
    expect(typeof resolveDaemonToken({ forceRefresh: true })).toBe("undefined")
    invalidateDaemonToken()
  })
})

/**
 * The harness's correctness depends on tests not running concurrently within a
 * file: process.env is process-global, so `test.concurrent` bodies would
 * interleave and no beforeEach/afterEach discipline could keep the pin stable
 * for the duration of a test body.
 *
 * setup.ts states that ban in a comment. This enforces it, because "a comment
 * asserting a property the code does not enforce" is the single most common
 * defect shape in this repo's history.
 */
describe("test.concurrent ban", () => {
  test("no test file uses concurrent execution", () => {
    const testDir = path.dirname(new URL(import.meta.url).pathname)
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".ts"))
    // Guard the detector itself: if the directory layout changes (e.g. tests
    // move into subdirectories) a flat readdir would silently scan nothing and
    // this test would pass vacuously.
    expect(files.length).toBeGreaterThan(15)

    const offenders: string[] = []
    for (const entry of files) {
      const source = fs.readFileSync(path.join(testDir, entry), "utf8")
      source.split("\n").forEach((line, i) => {
        // Anchored at statement position so prose in comments (including the
        // ban's own rationale in setup.ts) does not register as a violation.
        if (/^\s*(?:await\s+)?(?:test|it|describe)\s*\.\s*concurrent\b/.test(line)) {
          offenders.push(`${entry}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

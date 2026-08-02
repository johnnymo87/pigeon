/**
 * Guards the swarm_schedule tool PROSE against the daemon's real parser.
 *
 * The tool description is the only mechanism by which a model discovers this
 * capability, so an example inside it is executable documentation: an agent
 * will copy it verbatim on its first attempt. W4 shipped `at: '09:00'` as the
 * worked example, which `parseScheduleTime` rejects outright (bare wall-clock
 * times were deliberately refused in W1 as ambiguous). Every existing test
 * passed, because they assert the tool FORWARDS `at` verbatim and leave
 * parsing to the daemon — so no test ever ran the example string through the
 * thing that validates it. The prose was checked against intent, never against
 * the parser. See pigeon-way.
 *
 * These tests close that gap by extracting the literal examples out of the
 * description and feeding them to the daemon's own parseScheduleTime. The
 * cross-package relative import is deliberate: it makes the real coupling
 * explicit, so that changing the parser breaks the docs that describe it.
 */

import { describe, it, expect } from "vitest"
import { createSwarmScheduleTool } from "../src/swarm-schedule-tool"
import { parseScheduleTime } from "../../daemon/src/swarm/schedule-time"

const NOW = Date.parse("2026-08-01T21:30:00-04:00")

function description(): string {
  const def = createSwarmScheduleTool("http://127.0.0.1:4731") as unknown as {
    description: string
    args: Record<string, { description?: string }>
  }
  return def.description
}

function argDescriptions(): string {
  const def = createSwarmScheduleTool("http://127.0.0.1:4731") as unknown as {
    args: Record<string, unknown>
  }
  // Zod-ish schema objects expose the text via `.description` on the shape.
  return JSON.stringify(def.args)
}

/** Every single-quoted literal in the given prose. */
function quotedLiterals(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === "string")
}

const RFC3339_SHAPED = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}/
const DURATION_SHAPED = /^\d+[smhd]$/
const BARE_CLOCK_TIME = /^\d{1,2}:\d{2}$/

describe("swarm_schedule description is executable documentation", () => {
  it("offers no bare wall-clock time as an `at` example (pigeon-way regression)", () => {
    const prose = description() + argDescriptions()
    // A bare '09:00' must never appear as something to PASS. It may only
    // appear as an explicit counter-example of what is rejected, so we assert
    // on the specific shape that reads as an instruction.
    expect(prose).not.toMatch(/at:\s*'\d{1,2}:\d{2}'/)
  })

  it("every RFC3339-shaped example in the prose is accepted by parseScheduleTime", () => {
    const candidates = quotedLiterals(description() + argDescriptions()).filter(
      (s) => RFC3339_SHAPED.test(s),
    )
    // The prose must actually contain at least one, or this test is vacuous.
    expect(candidates.length).toBeGreaterThan(0)

    for (const at of candidates) {
      const result = parseScheduleTime({ at, now: NOW })
      expect(
        result.ok,
        `description offers at: '${at}', which the daemon rejects: ${
          result.ok ? "" : result.error
        }`,
      ).toBe(true)
    }
  })

  it("every duration-shaped example in the prose is accepted by parseScheduleTime", () => {
    const candidates = quotedLiterals(description() + argDescriptions()).filter(
      (s) => DURATION_SHAPED.test(s),
    )
    expect(candidates.length).toBeGreaterThan(0)

    for (const after of candidates) {
      const result = parseScheduleTime({ after, now: NOW })
      expect(
        result.ok,
        `description offers after: '${after}', which the daemon rejects: ${
          result.ok ? "" : result.error
        }`,
      ).toBe(true)
    }
  })

  it("confirms the trap it is guarding: a bare '09:00' really is rejected", () => {
    // If this ever starts passing, the daemon has begun accepting bare times
    // and the prose guard above should be revisited rather than trusted.
    const result = parseScheduleTime({ at: "09:00", now: NOW })
    expect(result.ok).toBe(false)
  })

  it("steers toward `after` as the unambiguous form", () => {
    // schedule-time.ts itself documents `after` as PREFERRED. The description
    // must not contradict the code it is describing.
    expect(description()).toMatch(/prefer\s+`?after`?/i)
  })
})

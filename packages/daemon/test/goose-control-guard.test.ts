import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gooseControlVerdict } from "../src/goose/control-guard.js";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind.js";

const lookup = (kind: string | null | undefined) => ({
  backendKindOf: () => kind,
  gooseBackendKind: GOOSE_BACKEND_KIND,
});

describe("gooseControlVerdict", () => {
  it("leaves opencode sessions entirely alone", () => {
    for (const cmd of ["kill", "interrupt", "compact", "mcp", "model"] as const) {
      expect(gooseControlVerdict(cmd, "s", lookup("opencode-plugin-direct")).kind).toBe("not-goose");
    }
  });

  it("leaves a session it has never heard of alone", () => {
    // Deliberately NOT treated as goose. An unknown id is the opencode path's
    // problem to report, and claiming it as goose would hide a real bug.
    expect(gooseControlVerdict("kill", "s", lookup(undefined)).kind).toBe("not-goose");
    expect(gooseControlVerdict("kill", "s", lookup(null)).kind).toBe("not-goose");
  });

  it("refuses /interrupt without pretending to have stopped anything", () => {
    // Measured on goose 1.48.0: there is NO cancel method on the ACP surface at
    // all, and a turn survives a client disconnect. A reply that implied the
    // turn had been stopped would mislead the human at the exact moment they
    // are trying to stop something expensive or destructive.
    const v = gooseControlVerdict("interrupt", "s", lookup(GOOSE_BACKEND_KIND));
    expect(v.kind).toBe("refuse");
    const reply = (v as { reply: string }).reply;
    expect(reply).toMatch(/no interrupt/i);
    expect(reply).toMatch(/\/kill/);
    // It must not claim a steer is a stop.
    expect(reply).toMatch(/not a stop/i);
  });

  it("routes /kill to the goose teardown rather than the opencode client", () => {
    expect(gooseControlVerdict("kill", "s", lookup(GOOSE_BACKEND_KIND)).kind).toBe("kill");
  });

  it("refuses the commands goose has no equivalent for", () => {
    for (const cmd of ["compact", "mcp", "model"] as const) {
      const v = gooseControlVerdict(cmd, "s", lookup(GOOSE_BACKEND_KIND));
      expect(v.kind).toBe("refuse");
      expect((v as { reply: string }).reply).toMatch(/not supported/i);
    }
  });
});

/**
 * A source-level check, which is unusual enough to justify.
 *
 * The hazard is not a wrong answer from a function — it is a handler in index.ts
 * that forgets to ask. `clientForSession` mints a session_assignment AND a live
 * lease for any unknown id, and live leases are counted against activeTurnCap,
 * so one unguarded handler silently narrows placement for real opencode
 * sessions. No behavioural test of THIS module can see that omission, and the
 * count has already been got wrong once: an earlier survey said six sites when
 * there are nine.
 *
 * So the test reads the wiring file and asserts every `clientForSession` call is
 * preceded by a guard. It fails loudly when someone adds a tenth handler, which
 * is exactly when a human needs to be told this file exists.
 */
describe("index.ts control-path wiring", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("guards every session-scoped clientForSession call site", () => {
    const lines = src.split("\n");
    const callSites: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes("clientForSession(msg.sessionId)")) callSites.push(i);
    });

    // If this number changes, a handler was added or removed: check the new one
    // guards itself before updating the expectation.
    expect(callSites.length).toBe(9);

    const unguarded = callSites.filter((i) => {
      const window = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
      return !/handleGooseControl\(|isGooseSession\(/.test(window);
    });

    expect(unguarded.map((i) => `${i + 1}: ${lines[i]!.trim()}`)).toEqual([]);
  });

  it("keeps the goose registry out of the picture entirely when goose is unconfigured", () => {
    // `config.gooseAcpUrl ? ... : undefined` is what makes a goose session
    // unroutable rather than half-routable on a daemon with no goose, because
    // selectAdapter returns null without a runner factory.
    expect(src).toMatch(/config\.gooseAcpUrl\s*\n?\s*\?\s*new GooseRunnerRegistry/);
  });
});

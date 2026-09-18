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
 * A source-level check on the wiring, which is unusual enough to justify.
 *
 * The hazard is not a wrong answer from a function -- it is a CALLER that
 * forgets to ask. `clientForSession` mints a session_assignment and a live lease
 * for any unknown id, and live leases count against activeTurnCap, so one
 * unguarded caller silently narrows placement for real opencode sessions.
 *
 * The first version of this guard sat in the nine control handlers, and a review
 * found that insufficient: `clientForSession` is ALSO passed whole to the swarm
 * arbiter and to /launch's owner resolution, so a /swarm/send aimed at a goose id
 * would still have minted the lease. The guard therefore moved INTO
 * `clientForSession` itself, and what is worth pinning is that it stays there --
 * a behavioural test cannot see a guard that was moved back out to a subset of
 * callers.
 */
describe("index.ts control-path wiring", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("guards goose sessions inside clientForSession itself, not at its call sites", () => {
    // The choke point: every caller, present and future, is covered by this.
    const decl = src.slice(src.indexOf("const clientForSession = ("));
    const body = decl.slice(0, decl.indexOf("\n};"));
    expect(body).toMatch(/if \(isGooseSession\(sessionId\)\) return undefined;/);
    // And the guard must come before any routing call, not after it.
    expect(body.indexOf("isGooseSession")).toBeLessThan(body.indexOf("clientFactory"));
  });

  it("still asks the control guard first, so a goose session gets an answer rather than silence", () => {
    // clientForSession returning undefined only makes a handler log "not
    // routable" and go quiet. The honest replies are the point.
    for (const handler of ["onKill", "onInterrupt", "onCompact", "onMcpList", "onMcpEnable", "onMcpDisable", "onModelList", "onModelSet"]) {
      const at = src.indexOf(`${handler}: async (msg) => {`);
      expect(at, `${handler} not found`).toBeGreaterThan(-1);
      const head = src.slice(at, at + 400);
      expect(head, `${handler} does not consult handleGooseControl`).toMatch(/handleGooseControl\(/);
    }
  });

  it("keeps the goose registry out of the picture entirely when goose is unconfigured", () => {
    // `config.gooseAcpUrl ? ... : undefined` is what makes a goose session
    // unroutable rather than half-routable on a daemon with no goose, because
    // selectAdapter returns null without a runner factory.
    expect(src).toMatch(/config\.gooseAcpUrl\s*\n?\s*\?\s*new GooseRunnerRegistry/);
  });
});

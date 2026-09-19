import { describe, it, expect } from "vitest";
import {
  advertisedBackends,
  checkLaunchServable,
  BACKENDS_HEADER,
  NO_BACKENDS_SENTINEL,
} from "../src/worker/backends";

describe("advertisedBackends", () => {
  it("advertises both backends when both are configured", () => {
    expect(advertisedBackends({ opencode: true, goose: true })).toBe("opencode,goose");
  });

  it("advertises only what is configured", () => {
    expect(advertisedBackends({ opencode: true, goose: false })).toBe("opencode");
    expect(advertisedBackends({ opencode: false, goose: true })).toBe("goose");
  });

  /**
   * The case the sentinel exists for. A daemon with neither backend must not
   * render an empty value, because the worker reads an ABSENT header as
   * "legacy, opencode-only" and an empty one would be indistinguishable from
   * absent the moment any intermediary normalised it away -- which would let
   * the worker hand an opencode launch to a daemon that cannot serve it, the
   * exact bug the gate exists to kill.
   */
  it("never renders an empty value", () => {
    const value = advertisedBackends({ opencode: false, goose: false });
    expect(value).toBe(NO_BACKENDS_SENTINEL);
    expect(value.length).toBeGreaterThan(0);
  });

  /**
   * Pinned byte-exact. The worker parses this same literal in its seam test; if
   * either side is renamed, one of the two suites fails. Without this the gate
   * could be silently disabled by a spelling change, and a gate that never
   * matches is indistinguishable from a gate that always passes.
   */
  it("pins the header name and the wire spelling", () => {
    expect(BACKENDS_HEADER).toBe("X-Pigeon-Backends");
    expect(advertisedBackends({ opencode: true, goose: true })).toBe("opencode,goose");
  });

  /** Order is fixed, so the pinned literal above cannot pass by luck. */
  it("orders opencode before goose regardless of input shape", () => {
    expect(advertisedBackends({ goose: true, opencode: true })).toBe("opencode,goose");
  });
});

describe("checkLaunchServable", () => {
  const both = { opencode: true, goose: true };
  const ocOnly = { opencode: true, goose: false };
  const neither = { opencode: false, goose: false };

  it("treats an absent backend as the ordinary opencode launch", () => {
    // An OLD worker cannot send the field at all, so undefined must never read
    // as invalid -- doing so would break every launch from a lagging worker.
    expect(checkLaunchServable(undefined, ocOnly)).toEqual({ ok: true, backend: "opencode" });
  });

  it("allows each backend when it is configured", () => {
    expect(checkLaunchServable("opencode", both)).toEqual({ ok: true, backend: "opencode" });
    expect(checkLaunchServable("goose", both)).toEqual({ ok: true, backend: "goose" });
  });

  /**
   * The silent failure this exists to prevent: asked for goose, the daemon must
   * NOT quietly start an opencode session and report success.
   */
  it("refuses goose when goose cannot be launched, rather than falling back", () => {
    const res = checkLaunchServable("goose", ocOnly);
    expect(res.ok).toBe(false);
    // Says "cannot launch", not "not configured": on a machine where goose IS
    // configured but the launch path has not shipped, blaming configuration
    // sends the human to fix something already correct.
    expect(res.ok === false && res.message).toContain("cannot launch goose");
  });

  /**
   * Today this path warns and returns, which the poller reads as success and
   * ACKS -- so the command is consumed and destroyed with the human hearing
   * nothing. It must produce a message.
   */
  it("refuses an opencode launch when opencode is not configured", () => {
    const res = checkLaunchServable(undefined, neither);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("no opencode configured");
  });

  it("refuses a backend it has never heard of", () => {
    // A NEWER worker may name a backend this daemon predates. Refusing beats
    // guessing, and beats the silent drop that an unknown field would cause.
    const res = checkLaunchServable("claude-code", both);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("claude-code");
  });
});

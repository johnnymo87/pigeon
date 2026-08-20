import { describe, it, expect, vi } from "vitest";
import { shouldEmitAncillary, shouldEmitAncillaryFor } from "../src/ancillary-gate";
import { DEFAULT_DECLARED_QUIET_TTL_MS } from "../src/notify-policy";

function storageWith(row: unknown) {
  return {
    sessionOrigins: {
      get: () => row,
    },
  } as never;
}

describe("shouldEmitAncillary", () => {
  it("suppresses for the quiet policies", () => {
    expect(shouldEmitAncillary("none")).toBe(false);
    expect(shouldEmitAncillary("errors-only")).toBe(false);
  });

  it("emits for 'all' and for no policy at all", () => {
    expect(shouldEmitAncillary("all")).toBe(true);
    expect(shouldEmitAncillary(null)).toBe(true);
  });

  it("emits for an unrecognised policy string rather than guessing silence", () => {
    expect(shouldEmitAncillary("something-new")).toBe(true);
  });
});

describe("shouldEmitAncillaryFor", () => {
  const now = 10_000_000;

  it("suppresses a declared quiet lgtm session (the reported bug)", () => {
    const storage = storageWith({
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: now - 1000,
      declaredAt: now - 1000,
    });
    expect(shouldEmitAncillaryFor(storage, "ses_a", now, {})).toBe(false);
  });

  it("emits when the session has no origin row", () => {
    expect(shouldEmitAncillaryFor(storageWith(null), "ses_a", now, {})).toBe(true);
  });

  it("emits when policy is 'all'", () => {
    const storage = storageWith({
      notifyPolicy: "all",
      source: "declared",
      createdAt: now - 1000,
      declaredAt: now - 1000,
    });
    expect(shouldEmitAncillaryFor(storage, "ses_a", now, {})).toBe(true);
  });

  it("emits once the declared quiet TTL has expired, on the same clock as POST /stop", () => {
    const storage = storageWith({
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: now - DEFAULT_DECLARED_QUIET_TTL_MS - 1000,
      declaredAt: now - DEFAULT_DECLARED_QUIET_TTL_MS - 1000,
    });
    expect(shouldEmitAncillaryFor(storage, "ses_a", now, {})).toBe(true);
  });

  it("FAILS OPEN when the provenance read throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = {
      sessionOrigins: {
        get: () => {
          throw new Error("db exploded");
        },
      },
    } as never;

    expect(shouldEmitAncillaryFor(storage, "ses_a", now, {})).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

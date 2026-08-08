import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECLARED_QUIET_TTL_MS,
  decideNotify,
  effectiveNotifyPolicy,
  explainQuiet,
} from "../src/notify-policy";

describe("decideNotify", () => {
  it("delivers everything when there is no origin row and the title does not match", () => {
    for (const event of ["Stop", "Error", "Retry"]) {
      expect(decideNotify({ event, policy: null, title: "Feature work" }, {})).toEqual({
        deliver: true,
        layer: "default",
      });
    }
  });

  it("policy=all delivers every event, even when the title matches quiet pattern", () => {
    for (const event of ["Stop", "Error", "Retry"]) {
      expect(
        decideNotify({ event, policy: "all", title: "Task .lgtm-review-prompt.md" }, {}),
      ).toEqual({
        deliver: true,
        layer: "origin",
      });
    }
  });

  it("policy=errors-only suppresses Stop but DELIVERS Error and Retry", () => {
    // This mirrors current production behaviour exactly: the old gate tested
    // `event === "Stop"`, so lgtm errors and retries have always been
    // delivered. Suppressing them here would be a silent regression.
    expect(decideNotify({ event: "Stop", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
    expect(decideNotify({ event: "Retry", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("policy=none suppresses Stop, Error and Retry alike", () => {
    for (const event of ["Stop", "Error", "Retry"]) {
      expect(decideNotify({ event, policy: "none", title: "PR review" }, {})).toEqual({
        deliver: false,
        layer: "origin",
      });
    }
  });

  it("an unknown event under errors-only or none is DELIVERED", () => {
    // Fail open on anything the matrix does not name.
    expect(
      decideNotify({ event: "Whatever", policy: "errors-only", title: "PR review" }, {}),
    ).toEqual({
      deliver: true,
      layer: "origin",
    });
    expect(decideNotify({ event: "Whatever", policy: "none", title: "PR review" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("falls back to the title layer only when there is no origin row", () => {
    expect(
      decideNotify({ event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" }, {}),
    ).toEqual({
      deliver: false,
      layer: "title",
    });
    // ...and the title layer keeps its old event scope: Stop only.
    expect(
      decideNotify({ event: "Error", policy: null, title: "Task .lgtm-review-prompt.md" }, {}),
    ).toEqual({
      deliver: true,
      layer: "default",
    });
  });

  it("an origin row wins over a matching title", () => {
    expect(
      decideNotify({ event: "Stop", policy: "all", title: "Task .lgtm-review-prompt.md" }, {}),
    ).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("the title layer can be disabled by env recognised off values", () => {
    const offValues = ["off", "OFF", "Off", " off ", "false", "0", "no"];
    for (const val of offValues) {
      expect(
        decideNotify(
          { event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" },
          { PIGEON_QUIET_TITLE_LAYER: val },
        ),
      ).toEqual({ deliver: true, layer: "default" });
    }
  });

  it("the title layer remains enabled for recognised on values and empty/unset", () => {
    const onValues = ["on", "ON", "On", "1", "true", "yes", ""];
    for (const val of onValues) {
      expect(
        decideNotify(
          { event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" },
          { PIGEON_QUIET_TITLE_LAYER: val },
        ),
      ).toEqual({ deliver: false, layer: "title" });
    }
    expect(
      decideNotify(
        { event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toEqual({ deliver: false, layer: "title" });
  });

  it("unrecognised PIGEON_QUIET_TITLE_LAYER value stays enabled and logs console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unrecognisedValues = ["disabled", "nope"];

    for (const val of unrecognisedValues) {
      expect(
        decideNotify(
          { event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" },
          { PIGEON_QUIET_TITLE_LAYER: val },
        ),
      ).toEqual({ deliver: false, layer: "title" });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(val),
      );
    }

    warnSpy.mockRestore();
  });
});

describe("explainQuiet", () => {
  it("returns unregistered when registered is false, even if notify is true and policy/origin set", () => {
    expect(
      explainQuiet(
        { registered: false, notify: true, policy: null, origin: null, title: "Fix bug" },
        {},
      ),
    ).toEqual({
      reason: "unregistered",
      origin: null,
      policy: null,
    });

    expect(
      explainQuiet(
        { registered: false, notify: false, policy: "errors-only", origin: "lgtm", title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toEqual({
      reason: "unregistered",
      origin: "lgtm",
      policy: "errors-only",
    });
  });

  it("returns notify-flag when registered is true and notify is false, taking precedence over title match", () => {
    expect(
      explainQuiet(
        { registered: true, notify: false, policy: null, origin: null, title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toEqual({
      reason: "notify-flag",
      origin: null,
      policy: null,
    });
  });

  it("returns origin when policy is errors-only, echoing back origin and policy", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: "errors-only", origin: "lgtm", title: "Fix auth bug" },
        {},
      ),
    ).toEqual({
      reason: "origin",
      origin: "lgtm",
      policy: "errors-only",
    });
  });

  it("returns origin when policy is none", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: "none", origin: "custom", title: "Fix auth bug" },
        {},
      ),
    ).toEqual({
      reason: "origin",
      origin: "custom",
      policy: "none",
    });
  });

  it("returns null when policy is all even if title matches quiet regex", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: "all", origin: "lgtm", title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toBeNull();
  });

  it("returns title when no row (policy null) and title matches quiet pattern", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toEqual({
      reason: "title",
      origin: null,
      policy: null,
    });
  });

  it("returns null when no row and title is ordinary", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "Fix auth bug" },
        {},
      ),
    ).toBeNull();
  });

  it("returns null when title matches but PIGEON_QUIET_TITLE_LAYER=off in env", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "Task .lgtm-review-prompt.md" },
        { PIGEON_QUIET_TITLE_LAYER: "off" },
      ),
    ).toBeNull();
  });

  it("returns null when effective policy is applied to an expired declared quiet session", () => {
    const now = 10_000_000;
    const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
    const effective = effectiveNotifyPolicy(
      { policy: "errors-only", source: "declared", createdAt: now - ttl - 1000, now },
      {},
    );
    expect(effective).toEqual({ policy: "all", expired: true });

    expect(
      explainQuiet(
        {
          registered: true,
          notify: true,
          policy: effective.policy,
          origin: "lgtm",
          title: "PR review .lgtm-review-prompt.md",
        },
        {},
      ),
    ).toBeNull();
  });

  it("returns origin explanation when effective policy is applied to a non-expired declared quiet session", () => {
    const now = 10_000_000;
    const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
    const effective = effectiveNotifyPolicy(
      { policy: "errors-only", source: "declared", createdAt: now - ttl + 1000, now },
      {},
    );
    expect(effective).toEqual({ policy: "errors-only", expired: false });

    expect(
      explainQuiet(
        {
          registered: true,
          notify: true,
          policy: effective.policy,
          origin: "lgtm",
          title: "PR review .lgtm-review-prompt.md",
        },
        {},
      ),
    ).toEqual({
      reason: "origin",
      origin: "lgtm",
      policy: "errors-only",
    });
  });

  it("handles null/undefined/empty title without throwing and returns null for ordinary session", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: null },
        {},
      ),
    ).toBeNull();

    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: undefined },
        {},
      ),
    ).toBeNull();

    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "" },
        {},
      ),
    ).toBeNull();
  });
});

describe("effectiveNotifyPolicy", () => {
  const now = 10_000_000;
  const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;

  it("returns null policy unchanged and not expired when policy is null", () => {
    expect(
      effectiveNotifyPolicy({ policy: null, source: "declared", createdAt: now - ttl - 1000, now }, {}),
    ).toEqual({ policy: null, expired: false });
  });

  it("returns override rows unchanged regardless of age", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "override", createdAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "errors-only", expired: false });

    expect(
      effectiveNotifyPolicy(
        { policy: "none", source: "override", createdAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "none", expired: false });
  });

  it("returns policy=all unchanged and not expired", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "all", source: "declared", createdAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: false });
  });

  it("expires declared or inferred quiet rows (errors-only / none) when older than TTL", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - ttl - 1, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy(
        { policy: "none", source: "inferred", createdAt: now - ttl - 1, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("keeps quiet rows unchanged when within TTL", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - ttl + 1000, now },
        {},
      ),
    ).toEqual({ policy: "errors-only", expired: false });
  });

  it("treats exact TTL boundary as NOT expired (strictly greater required)", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - ttl, now },
        {},
      ),
    ).toEqual({ policy: "errors-only", expired: false });
  });

  it("keeps quiet rows unchanged when createdAt is null or not finite", () => {
    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", createdAt: null, now }, {}),
    ).toEqual({ policy: "errors-only", expired: false });

    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", createdAt: NaN, now }, {}),
    ).toEqual({ policy: "errors-only", expired: false });

    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", createdAt: Infinity, now }, {}),
    ).toEqual({ policy: "errors-only", expired: false });
  });

  it("customizes TTL via PIGEON_DECLARED_QUIET_TTL_MS env var", () => {
    const customTtlEnv = { PIGEON_DECLARED_QUIET_TTL_MS: "1000" }; // 1s
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - 500, now },
        customTtlEnv,
      ),
    ).toEqual({ policy: "errors-only", expired: false });

    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - 1001, now },
        customTtlEnv,
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("allows PIGEON_DECLARED_QUIET_TTL_MS=0 to expire immediately", () => {
    const zeroTtlEnv = { PIGEON_DECLARED_QUIET_TTL_MS: "0" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - 1, now },
        zeroTtlEnv,
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("falls back to default TTL and logs console.warn when PIGEON_DECLARED_QUIET_TTL_MS is invalid or negative", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const badEnv1 = { PIGEON_DECLARED_QUIET_TTL_MS: "not-a-number" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - ttl - 1, now },
        badEnv1,
      ),
    ).toEqual({ policy: "all", expired: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not-a-number"));

    warnSpy.mockClear();

    const badEnv2 = { PIGEON_DECLARED_QUIET_TTL_MS: "-500" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", createdAt: now - 100, now },
        badEnv2,
      ),
    ).toEqual({ policy: "errors-only", expired: false }); // 100ms < 4h default
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("-500"));

    warnSpy.mockRestore();
  });
});

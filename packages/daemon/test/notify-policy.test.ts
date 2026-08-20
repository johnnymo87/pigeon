import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECLARED_QUIET_TTL_MS,
  decideNotify,
  effectiveNotifyPolicy,
  explainQuiet,
  resolveEffectivePolicy,
} from "../src/notify-policy";

describe("decideNotify", () => {
  it("delivers everything when there is no origin row", () => {
    for (const event of ["Stop", "Error", "Retry"]) {
      expect(decideNotify({ event, policy: null, title: "Feature work" }, {})).toEqual({
        deliver: true,
        layer: "default",
      });
    }
  });

  it("delivers even when title looks like automation if policy is null", () => {
    for (const event of ["Stop", "Error", "Retry"]) {
      expect(
        decideNotify({ event, policy: null, title: "Task .lgtm-review-prompt.md" }, {}),
      ).toEqual({
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

  it("policy=errors-only suppresses Stop and Retry, but DELIVERS non-aborted Error", () => {
    expect(decideNotify({ event: "Stop", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
    expect(decideNotify({ event: "Retry", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review", errorKind: "rate_limited" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
    // Missing/null/unknown errorKind must FAIL OPEN and deliver
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review", errorKind: null }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review", errorKind: undefined }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("policy=errors-only suppresses aborted Error (errorKind=aborted)", () => {
    expect(decideNotify({ event: "Error", policy: "errors-only", title: "PR review", errorKind: "aborted" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
  });

  it("policy=none suppresses Error regardless of errorKind", () => {
    expect(decideNotify({ event: "Error", policy: "none", title: "PR review", errorKind: "aborted" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "none", title: "PR review", errorKind: "other" }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
    expect(decideNotify({ event: "Error", policy: "none", title: "PR review", errorKind: null }, {})).toEqual({
      deliver: false,
      layer: "origin",
    });
  });

  it("policy=all delivers Error even when errorKind=aborted", () => {
    expect(decideNotify({ event: "Error", policy: "all", title: "PR review", errorKind: "aborted" }, {})).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("policy=null delivers Error even when errorKind=aborted (no origin suppression)", () => {
    expect(decideNotify({ event: "Error", policy: null, title: "PR review", errorKind: "aborted" }, {})).toEqual({
      deliver: true,
      layer: "default",
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

  it("an origin row wins regardless of title", () => {
    expect(
      decideNotify({ event: "Stop", policy: "all", title: "Task .lgtm-review-prompt.md" }, {}),
    ).toEqual({
      deliver: true,
      layer: "origin",
    });
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

  it("returns null when policy is all even if title matches quiet pattern", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: "all", origin: "lgtm", title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toBeNull();
  });

  it("returns null when no row (policy null) even if title matches automation pattern", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "Task .lgtm-review-prompt.md" },
        {},
      ),
    ).toBeNull();
  });

  it("returns null when no row and title is ordinary", () => {
    expect(
      explainQuiet(
        { registered: true, notify: true, policy: null, origin: null, title: "Fix auth bug" },
        {},
      ),
    ).toBeNull();
  });

  it("returns null when effective policy is applied to an expired declared quiet session", () => {
    const now = 10_000_000;
    const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;
    const effective = effectiveNotifyPolicy(
      { policy: "errors-only", source: "declared", declaredAt: now - ttl - 1000, now },
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
      { policy: "errors-only", source: "declared", declaredAt: now - ttl + 1000, now },
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
      effectiveNotifyPolicy({ policy: null, source: "declared", declaredAt: now - ttl - 1000, now }, {}),
    ).toEqual({ policy: null, expired: false });
  });

  it("no suppression is exempt from the TTL: quiet rows (errors-only / none) expire after TTL regardless of source", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy(
        { policy: "none", source: "inferred", declaredAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });

    // Even if legacy 'override' source is passed, errors-only / none must expire after TTL
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "override" as any, declaredAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy(
        { policy: "none", source: "override" as any, declaredAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("legacy override row degrade: stored row with source='override' (or degraded 'inferred') and policy='all' resolves to deliver regardless of age", () => {
    // Legacy enable-notify always wrote policy='all'. On read, source='override' degrades to 'inferred',
    // and policy='all' stays 'all' and not expired regardless of how old the row is.
    const effectiveDegraded = effectiveNotifyPolicy(
      { policy: "all", source: "inferred", declaredAt: now - ttl - 100_000, now },
      {},
    );
    expect(effectiveDegraded).toEqual({ policy: "all", expired: false });
    expect(decideNotify({ event: "Stop", policy: effectiveDegraded.policy })).toEqual({
      deliver: true,
      layer: "origin",
    });

    const effectiveRaw = effectiveNotifyPolicy(
      { policy: "all", source: "override" as any, declaredAt: now - ttl - 100_000, now },
      {},
    );
    expect(effectiveRaw).toEqual({ policy: "all", expired: false });
    expect(decideNotify({ event: "Stop", policy: effectiveRaw.policy })).toEqual({
      deliver: true,
      layer: "origin",
    });
  });

  it("returns policy=all unchanged and not expired", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "all", source: "declared", declaredAt: now - ttl - 100_000, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: false });
  });

  it("expires declared or inferred quiet rows (errors-only / none) when older than TTL", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - ttl - 1, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy(
        { policy: "none", source: "inferred", declaredAt: now - ttl - 1, now },
        {},
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("keeps quiet rows unchanged when within TTL", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - ttl + 1000, now },
        {},
      ),
    ).toEqual({ policy: "errors-only", expired: false });
  });

  it("treats exact TTL boundary as NOT expired (strictly greater required)", () => {
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - ttl, now },
        {},
      ),
    ).toEqual({ policy: "errors-only", expired: false });
  });

  it("treats an unusable clock as expired so a corrupt declared_at cannot silence forever", () => {
    // Fail open: with no usable clock we cannot prove the suppression is still young,
    // and the dangerous direction is silence, not noise.
    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", declaredAt: null, now }, {}),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", declaredAt: NaN, now }, {}),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy({ policy: "errors-only", source: "declared", declaredAt: Infinity, now }, {}),
    ).toEqual({ policy: "all", expired: true });

    expect(
      effectiveNotifyPolicy({ policy: "none", source: "inferred", declaredAt: NaN, now }, {}),
    ).toEqual({ policy: "all", expired: true });
  });

  it("customizes TTL via PIGEON_DECLARED_QUIET_TTL_MS env var", () => {
    const customTtlEnv = { PIGEON_DECLARED_QUIET_TTL_MS: "1000" }; // 1s
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - 500, now },
        customTtlEnv,
      ),
    ).toEqual({ policy: "errors-only", expired: false });

    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - 1001, now },
        customTtlEnv,
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("allows PIGEON_DECLARED_QUIET_TTL_MS=0 to expire immediately", () => {
    const zeroTtlEnv = { PIGEON_DECLARED_QUIET_TTL_MS: "0" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - 1, now },
        zeroTtlEnv,
      ),
    ).toEqual({ policy: "all", expired: true });
  });

  it("falls back to default TTL and logs console.warn when PIGEON_DECLARED_QUIET_TTL_MS is invalid or negative", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const badEnv1 = { PIGEON_DECLARED_QUIET_TTL_MS: "not-a-number" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - ttl - 1, now },
        badEnv1,
      ),
    ).toEqual({ policy: "all", expired: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not-a-number"));

    warnSpy.mockClear();

    const badEnv2 = { PIGEON_DECLARED_QUIET_TTL_MS: "-500" };
    expect(
      effectiveNotifyPolicy(
        { policy: "errors-only", source: "declared", declaredAt: now - 100, now },
        badEnv2,
      ),
    ).toEqual({ policy: "errors-only", expired: false }); // 100ms < 4h default
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("-500"));

    warnSpy.mockRestore();
  });
});

describe("resolveEffectivePolicy", () => {
  const now = 10_000_000;
  const ttl = DEFAULT_DECLARED_QUIET_TTL_MS;

  function storageWith(row: unknown) {
    return {
      sessionOrigins: {
        get: () => row,
      },
    } as any;
  }

  it("returns null policy and not expired when session has no origin row", () => {
    const storage = storageWith(null);
    expect(resolveEffectivePolicy(storage, "ses_1", now, "stop", {})).toEqual({
      policy: null,
      expired: false,
      origin: null,
      source: null,
      declaredAt: null,
    });
  });

  it("returns stored policy unchanged and not expired when within TTL", () => {
    const storage = storageWith({
      sessionId: "ses_1",
      origin: "lgtm",
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: now - 5000,
      declaredAt: now - 5000,
      updatedAt: now - 5000,
    });
    expect(resolveEffectivePolicy(storage, "ses_1", now, "stop", {})).toEqual({
      policy: "errors-only",
      expired: false,
      origin: "lgtm",
      source: "declared",
      declaredAt: now - 5000,
    });
  });

  it("expires quiet policy to 'all' and logs message with ageMs when older than TTL", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const declaredAt = now - ttl - 5000;
    const storage = storageWith({
      sessionId: "ses_1",
      origin: "lgtm",
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: declaredAt,
      declaredAt,
      updatedAt: declaredAt,
    });

    const result = resolveEffectivePolicy(storage, "ses_1", now, "stop", {});
    expect(result).toEqual({
      policy: "all",
      expired: true,
      origin: "lgtm",
      source: "declared",
      declaredAt,
    });

    expect(logSpy).toHaveBeenCalledWith(
      `[stop] automated quiet expired sessionId=ses_1 origin=lgtm source=declared policy=errors-only ageMs=${ttl + 5000} — delivering`,
    );
    logSpy.mockRestore();
  });

  it("logs with the provided tag on expiry (e.g. ancillary)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const declaredAt = now - ttl - 1000;
    const storage = storageWith({
      sessionId: "ses_ancillary",
      origin: "ci",
      notifyPolicy: "none",
      source: "declared",
      createdAt: declaredAt,
      declaredAt,
      updatedAt: declaredAt,
    });

    const result = resolveEffectivePolicy(storage, "ses_ancillary", now, "ancillary", {});
    expect(result.policy).toBe("all");
    expect(result.expired).toBe(true);

    expect(logSpy).toHaveBeenCalledWith(
      `[ancillary] automated quiet expired sessionId=ses_ancillary origin=ci source=declared policy=none ageMs=${ttl + 1000} — delivering`,
    );
    logSpy.mockRestore();
  });

  it("fixes latent NaN: logs ageMs=unknown when declaredAt is null or non-finite", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = storageWith({
      sessionId: "ses_nan",
      origin: "lgtm",
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: NaN,
      declaredAt: NaN,
      updatedAt: NaN,
    });

    const result = resolveEffectivePolicy(storage, "ses_nan", now, "stop", {});
    expect(result.policy).toBe("all");
    expect(result.expired).toBe(true);

    expect(logSpy).toHaveBeenCalledWith(
      `[stop] automated quiet expired sessionId=ses_nan origin=lgtm source=declared policy=errors-only ageMs=unknown — delivering`,
    );
    logSpy.mockRestore();
  });

  it("fails open to policy=null if storage.sessionOrigins.get throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = {
      sessionOrigins: {
        get: () => {
          throw new Error("DB read error");
        },
      },
    } as any;

    const result = resolveEffectivePolicy(storage, "ses_err", now, "stop", {});
    expect(result).toEqual({
      policy: null,
      expired: false,
      origin: null,
      source: null,
      declaredAt: null,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[stop] session_origin read failed sessionId=ses_err, delivering:"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("fails open to policy='all' if effectiveNotifyPolicy calculation throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = storageWith({
      sessionId: "ses_calc_err",
      origin: "lgtm",
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: now - 1000,
      declaredAt: now - 1000,
      updatedAt: now - 1000,
    });

    // Pass invalid env or proxy that throws
    const throwingEnv = new Proxy({}, {
      get() {
        throw new Error("Env lookup error");
      },
    });

    const result = resolveEffectivePolicy(storage, "ses_calc_err", now, "stop", throwingEnv as any);
    expect(result).toEqual({
      policy: "all",
      expired: false,
      origin: "lgtm",
      source: "declared",
      declaredAt: now - 1000,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[stop] effective notify policy calculation failed sessionId=ses_calc_err, delivering:"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

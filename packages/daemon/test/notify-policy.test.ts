import { describe, expect, it, vi } from "vitest";
import { decideNotify, explainQuiet } from "../src/notify-policy";

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

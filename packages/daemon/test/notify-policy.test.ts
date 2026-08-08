import { describe, expect, it } from "vitest";
import { decideNotify } from "../src/notify-policy";

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

  it("the title layer can be disabled by env", () => {
    expect(
      decideNotify(
        { event: "Stop", policy: null, title: "Task .lgtm-review-prompt.md" },
        { PIGEON_QUIET_TITLE_LAYER: "off" },
      ),
    ).toEqual({ deliver: true, layer: "default" });
  });
});

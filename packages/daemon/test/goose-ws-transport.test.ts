import { describe, expect, it } from "vitest";
import { withToken } from "../src/goose/ws-transport";

/**
 * goose 1.48.0 accepts `?token=` (and `X-Secret-Key`) but NOT
 * `Authorization: Bearer`, which is what this transport used to send -- measured,
 * see the module docstring. These assertions pin the URL shape that carries the
 * credential, because getting it wrong surfaces as a 401 that reads like a wrong
 * secret rather than like a malformed request.
 */
describe("withToken", () => {
  it("adds the token to a bare url", () => {
    expect(withToken("http://127.0.0.1:3400/acp", "s3cret"))
      .toBe("http://127.0.0.1:3400/acp?token=s3cret");
  });

  it("preserves query parameters that are already present", () => {
    const out = new URL(withToken("http://127.0.0.1:3400/acp?mode=stream", "s3cret"));
    expect(out.searchParams.get("mode")).toBe("stream");
    expect(out.searchParams.get("token")).toBe("s3cret");
  });

  it("replaces rather than duplicates an existing token", () => {
    const out = new URL(withToken("http://127.0.0.1:3400/acp?token=old", "new"));
    expect(out.searchParams.getAll("token")).toEqual(["new"]);
  });

  it("url-encodes a token containing reserved characters", () => {
    const raw = "a+b/c=d&e";
    const out = new URL(withToken("http://127.0.0.1:3400/acp", raw));
    // Round-trips to the original secret rather than being silently mangled.
    expect(out.searchParams.get("token")).toBe(raw);
  });

  it("works for the websocket scheme too", () => {
    expect(withToken("ws://127.0.0.1:3400/acp", "s3cret"))
      .toBe("ws://127.0.0.1:3400/acp?token=s3cret");
  });
});

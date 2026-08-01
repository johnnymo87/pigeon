import { describe, expect, it } from "vitest";
import {
  isOutageFailure,
  TargetUnavailableError,
} from "../src/swarm/delivery-policy";
import { OpencodeHttpError, TransportError } from "../src/opencode-client";
import { RequestTimeoutError } from "../src/routing/serve-outcome";
import { PermanentDeliveryError } from "../src/swarm/envelope";

describe("isOutageFailure classifier", () => {
  it("classifies TargetUnavailableError as uncounted outage (true)", () => {
    const err = new TargetUnavailableError("no healthy serve");
    expect(isOutageFailure(err)).toBe(true);
  });

  it("classifies TransportError as uncounted outage (true)", () => {
    const err = new TransportError(new Error("connect ECONNREFUSED"));
    expect(isOutageFailure(err)).toBe(true);
  });

  it("classifies RequestTimeoutError as counted (false) to prevent duplicate non-idempotent prompts", () => {
    const err = new RequestTimeoutError(30_000, "http://localhost:4096/session/s1/prompt_async");
    expect(isOutageFailure(err)).toBe(false);
  });

  it("classifies OpencodeHttpError (5xx, 429, 404) as counted (false)", () => {
    expect(isOutageFailure(new OpencodeHttpError(500, "Internal Server Error"))).toBe(false);
    expect(isOutageFailure(new OpencodeHttpError(502, "Bad Gateway"))).toBe(false);
    expect(isOutageFailure(new OpencodeHttpError(429, "Too Many Requests"))).toBe(false);
    expect(isOutageFailure(new OpencodeHttpError(404, "Not Found"))).toBe(false);
  });

  it("classifies PermanentDeliveryError as counted/not-outage (false)", () => {
    expect(isOutageFailure(new PermanentDeliveryError("bad payload"))).toBe(false);
  });

  it("classifies generic Error or unknown throwables as counted (false, fail safe)", () => {
    expect(isOutageFailure(new Error("unexpected error"))).toBe(false);
    expect(isOutageFailure("string error")).toBe(false);
    expect(isOutageFailure(null)).toBe(false);
  });
});

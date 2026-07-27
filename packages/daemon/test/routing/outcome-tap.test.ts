/**
 * The SENSOR WIRING itself (bead pigeon-f2a, adversarial review MAJOR-3).
 *
 * WHY THIS FILE EXISTS. `serve-outcome.test.ts` proves the classification rules
 * against synthetic observations, and `flap-detector.test.ts` proves the
 * detection rule — but neither proves that a real request ever reaches either.
 * When this was first shipped, deleting BOTH `observe()` calls from
 * `OpencodeClient.fetchWithTimeout` left the entire suite green.
 *
 * That gap is the June failure shape pointed at the instrument: a future
 * refactor severs the tap, the daemon reports an empty tally, and
 * `reportNow()`'s empty-log early return makes a severed sensor look exactly
 * like a quiet, healthy pool. We would then "collect a week of calibration data"
 * and collect nothing — and, per the spine's own rule, absence of a signal
 * proves nothing.
 *
 * So: assert the plumbing, end to end, at both boundaries.
 */
import { describe, expect, it, vi } from "vitest";
import { OpencodeClient } from "../../src/opencode-client";
import { OpencodeClientFactory } from "../../src/routing/client-factory";
import {
  RequestTimeoutError,
  type OutcomeObservation,
} from "../../src/routing/serve-outcome";

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({}), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpencodeClient outcome tap", () => {
  it("reports the status of a successful response", async () => {
    const seen: OutcomeObservation[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch,
      onOutcome: (obs) => seen.push(obs),
    });

    await client.healthCheck();

    expect(seen).toEqual([{ status: 200 }]);
  });

  it("reports a 5xx status rather than swallowing it as an error", async () => {
    // The signature class of pigeon-886: answered fast, answered wrongly.
    const seen: OutcomeObservation[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(500)) as unknown as typeof fetch,
      onOutcome: (obs) => seen.push(obs),
    });

    await client.healthCheck();

    expect(seen).toEqual([{ status: 500 }]);
  });

  it("reports a transport failure as an error", async () => {
    const seen: OutcomeObservation[] = [];
    const refused = new TypeError("fetch failed");
    (refused as Error & { cause?: unknown }).cause = Object.assign(
      new Error("ECONNREFUSED"),
      { code: "ECONNREFUSED" },
    );
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: vi.fn().mockRejectedValue(refused) as unknown as typeof fetch,
      onOutcome: (obs) => seen.push(obs),
    });

    await client.healthCheck();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.error).toBe(refused);
  });

  it("reports an abort as a typed RequestTimeoutError, not a bare Error", async () => {
    // The type is what lets the sensor exclude timeouts by CLASS. The message was
    // deliberately kept byte-identical to the old plain-Error form, so a regression
    // to `new Error(...)` is invisible to every message-matching test in the repo
    // — and would silently reclassify real timeouts as `unknown`, corrupting the
    // timeout/unknown split the calibration depends on.
    const seen: OutcomeObservation[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      requestTimeoutMs: 5,
      fetchFn: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch,
      onOutcome: (obs) => seen.push(obs),
    });

    await client.healthCheck();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.error).toBeInstanceOf(RequestTimeoutError);
  });

  it("never lets a throwing tap break the request it observes", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch,
      onOutcome: () => {
        throw new Error("sensor exploded");
      },
    });

    await expect(client.healthCheck()).resolves.toBe(true);
  });
});

describe("OpencodeClientFactory outcome tap", () => {
  it("binds the endpoint so the sensor can attribute the observation", async () => {
    // Without the binding the sensor gets outcomes it cannot attribute and drops
    // every one of them — which looks identical to a healthy, quiet pool.
    const calls: Array<{ endpoint: string; obs: OutcomeObservation }> = [];
    const router = {
      ensureRouted: () => ({ apiBase: "http://127.0.0.1:4097" }),
    } as unknown as ConstructorParameters<typeof OpencodeClientFactory>[0];

    const factory = new OpencodeClientFactory(router, Date.now, (endpoint, obs) =>
      calls.push({ endpoint, obs }),
    );

    const client = factory.forSession("ses_a")!;
    // Swap in a stub transport; we are asserting the wiring, not the network.
    await client.healthCheck().catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.endpoint).toBe("http://127.0.0.1:4097");
  });

  it("keeps working when no tap is supplied", () => {
    const router = {
      ensureRouted: () => ({ apiBase: "http://127.0.0.1:4097" }),
    } as unknown as ConstructorParameters<typeof OpencodeClientFactory>[0];

    const factory = new OpencodeClientFactory(router);
    expect(() => factory.forSession("ses_a")).not.toThrow();
  });
});

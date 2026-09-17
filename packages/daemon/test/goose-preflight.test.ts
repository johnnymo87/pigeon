import { describe, expect, it } from "vitest";
import { classifyReachability } from "../src/goose/preflight";

/**
 * The distinction this makes is the difference between "retry in a minute" and
 * "stop and tell the human", and getting it backwards produces a daemon that
 * retries a wrong secret every 60 seconds until the command expires a day later.
 *
 * The status codes below are MEASURED against goose 1.48.0, not assumed:
 *
 *   GET /acp?token=<correct>    406   auth middleware passed, route declined the GET
 *   GET /acp?token=<wrong>      401
 *   GET /acp  (no token)        401
 *   nothing listening           fetch rejects, no status at all
 *
 * 406 is what makes this a good preflight: it proves the credential was accepted
 * while creating no session and having no side effect.
 */
describe("classifyReachability", () => {
  const url = "http://127.0.0.1:3400/acp";

  it("treats 401 as an auth failure, which must never be retried", async () => {
    const res = await classifyReachability(url, "wrong", {
      fetchFn: async () => new Response(null, { status: 401 }),
    });
    expect(res).toEqual({ kind: "auth-failed" });
  });

  it("treats the measured 406 as reachable-and-authenticated", async () => {
    const res = await classifyReachability(url, "right", {
      fetchFn: async () => new Response(null, { status: 406 }),
    });
    expect(res).toEqual({ kind: "ok" });
  });

  it("treats goose's own error statuses as reachable, since auth runs before the route", async () => {
    // 400/404/405/500 all mean the credential got PAST the middleware, which is
    // the only question being asked. A 2xx/3xx is handled separately below: it
    // is proof the responder is not goose at all.
    for (const status of [400, 404, 405, 500]) {
      const res = await classifyReachability(url, "right", {
        fetchFn: async () => new Response(null, { status }),
      });
      expect(res).toEqual({ kind: "ok" });
    }
  });

  it("treats a refused connection as unreachable, which IS retryable", async () => {
    const res = await classifyReachability(url, "right", {
      fetchFn: async () => { throw new TypeError("fetch failed"); },
    });
    expect(res.kind).toBe("unreachable");
  });

  it("bounds its own wait, because the poller dispatches serially", async () => {
    // An unbounded await here would freeze command delivery for EVERY session on
    // the machine, not just this one. A server that accepts the connection and
    // then says nothing is the case that matters -- it never rejects on its own.
    const res = await classifyReachability(url, "right", {
      timeoutMs: 25,
      fetchFn: (_u, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        // Otherwise never settles.
      }),
    });
    expect(res.kind).toBe("unreachable");
    expect((res as { cause: string }).cause).toMatch(/timed out|abort/i);
  });

  it("sends the token, and does not put the secret in the returned cause", async () => {
    let seenUrl = "";
    const res = await classifyReachability(url, "sup3r-secret", {
      fetchFn: async (u) => { seenUrl = String(u); throw new TypeError("fetch failed"); },
    });
    expect(seenUrl).toContain("token=sup3r-secret");
    // The cause is logged; the secret must not ride along into the log.
    expect(JSON.stringify(res)).not.toContain("sup3r-secret");
  });
});

describe("classifyReachability: cases the first version got wrong", () => {
  it("probes a ws:// url over http, instead of calling healthy goose dead", async () => {
    // THE BUG THIS PINS: fetch() rejects a ws:// url with TypeError("fetch
    // failed") -- byte-identical to a refused connection -- with the real reason
    // only in err.cause ("unknown scheme"). The natural goose url IS ws://
    // (scripts/goose-acp-probe.ts:15), so without normalisation a perfectly
    // healthy goose classifies as unreachable, forever, and the adapter retries
    // every 60s for a day. Measured on node 22.22.2.
    let seen = "";
    await classifyReachability("ws://127.0.0.1:3400/acp", "tok", {
      fetchFn: async (u) => { seen = String(u); return new Response(null, { status: 406 }); },
    });
    expect(seen.startsWith("http://")).toBe(true);
    expect(seen).toContain("token=tok");
  });

  it("maps wss:// to https://", async () => {
    let seen = "";
    await classifyReachability("wss://goose.example/acp", "tok", {
      fetchFn: async (u) => { seen = String(u); return new Response(null, { status: 406 }); },
    });
    expect(seen.startsWith("https://")).toBe(true);
  });

  it("calls a 2xx what it is -- something that is not goose", async () => {
    // goose's GET /acp can only answer 401, 406, 400 or 404. A 2xx or 3xx is
    // positive proof that whatever is on this port is NOT goose (wrong port in
    // config, or a proxy that swallowed the auth failure). Treating that as
    // "reachable" is how a misconfiguration becomes a 24h retry loop.
    for (const status of [200, 204, 302]) {
      const res = await classifyReachability("http://x/acp", "tok", {
        fetchFn: async () => new Response(null, { status }),
      });
      expect(res.kind).toBe("not-goose");
    }
  });

  it("still treats goose's own non-401 answers as reachable", async () => {
    for (const status of [400, 404, 406, 500]) {
      const res = await classifyReachability("http://x/acp", "tok", {
        fetchFn: async () => new Response(null, { status }),
      });
      expect(res.kind).toBe("ok");
    }
  });

  it("surfaces the underlying cause, so 'unknown scheme' is not read as 'dead server'", async () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: Error }).cause = new Error("connect ECONNREFUSED 127.0.0.1:3400");
    const res = await classifyReachability("http://x/acp", "tok", {
      fetchFn: async () => { throw err; },
    });
    expect((res as { cause: string }).cause).toContain("ECONNREFUSED");
  });

  it("redacts the secret even if an error carries the tokenised url", async () => {
    // Belt as well as braces. Node's own fetch errors do not carry the url, but
    // this string is logged, and a future runtime or proxy shim that does embed
    // it must not turn a log line into a credential leak.
    const res = await classifyReachability("http://x/acp", "sup3r-secret", {
      fetchFn: async () => { throw new Error("failed on http://x/acp?token=sup3r-secret"); },
    });
    expect(JSON.stringify(res)).not.toContain("sup3r-secret");
    expect((res as { cause: string }).cause).toContain("redacted");
  });

  it("releases the response body rather than leaving a stream open", async () => {
    let cancelled = false;
    await classifyReachability("http://x/acp", "tok", {
      fetchFn: async () => ({
        status: 406,
        body: { cancel: async () => { cancelled = true; } },
      } as unknown as Response),
    });
    expect(cancelled).toBe(true);
  });
});

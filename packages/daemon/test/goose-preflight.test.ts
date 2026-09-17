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
    expect(res).toEqual({ kind: "auth-failed", status: 401 });
  });

  it("treats the measured 406 as reachable-and-authenticated", async () => {
    const res = await classifyReachability(url, "right", {
      fetchFn: async () => new Response(null, { status: 406 }),
    });
    expect(res).toEqual({ kind: "ok" });
  });

  it("treats any other status as reachable, since the auth middleware runs first", async () => {
    // A 404/200/405 all mean the credential got PAST the middleware. We are
    // asking one question here and must not editorialise about the route.
    for (const status of [200, 404, 405, 500]) {
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

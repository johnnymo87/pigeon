import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SessionDirectoryRegistry } from "../src/swarm/registry";
import { invalidateServeAuthHeader } from "../src/serve-auth";

function fakeFetch(responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async (..._args: unknown[]) => {
    const r = responses[i++];
    if (!r) throw new Error("unexpected fetch call");
    if (r instanceof Error) throw r;
    return r;
  });
}

describe("SessionDirectoryRegistry", () => {
  it("fetches and caches session.directory", async () => {
    const fetchFn = fakeFetch([
      new Response(
        JSON.stringify({ id: "ses_a", directory: "/home/dev/projects/mono" }),
        { status: 200 },
      ),
    ]);
    const reg = new SessionDirectoryRegistry({
      baseUrl: "http://x",
      ttlMs: 60_000,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn: () => 1_000,
    });

    const dir1 = await reg.resolve("ses_a");
    const dir2 = await reg.resolve("ses_a");
    expect(dir1).toBe("/home/dev/projects/mono");
    expect(dir2).toBe("/home/dev/projects/mono");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches after TTL", async () => {
    const fetchFn = fakeFetch([
      new Response(JSON.stringify({ id: "ses_a", directory: "/old" }), {
        status: 200,
      }),
      new Response(JSON.stringify({ id: "ses_a", directory: "/new" }), {
        status: 200,
      }),
    ]);
    let now = 1_000;
    const reg = new SessionDirectoryRegistry({
      baseUrl: "http://x",
      ttlMs: 5_000,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn: () => now,
    });
    expect(await reg.resolve("ses_a")).toBe("/old");
    now = 10_000; // past TTL
    expect(await reg.resolve("ses_a")).toBe("/new");
  });

  it("throws on 404 (and does not cache the failure)", async () => {
    const fetchFn = fakeFetch([
      new Response("not found", { status: 404 }),
      new Response(JSON.stringify({ id: "ses_a", directory: "/d" }), {
        status: 200,
      }),
    ]);
    const reg = new SessionDirectoryRegistry({
      baseUrl: "http://x",
      ttlMs: 60_000,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn: () => 1_000,
    });
    await expect(reg.resolve("ses_a")).rejects.toThrow(/404|not found/i);
    expect(await reg.resolve("ses_a")).toBe("/d"); // recovers
  });

  it("invalidate forces a refetch on next resolve", async () => {
    const fetchFn = fakeFetch([
      new Response(JSON.stringify({ id: "ses_a", directory: "/a" }), {
        status: 200,
      }),
      new Response(JSON.stringify({ id: "ses_a", directory: "/b" }), {
        status: 200,
      }),
    ]);
    const reg = new SessionDirectoryRegistry({
      baseUrl: "http://x",
      ttlMs: 60_000,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn: () => 1_000,
    });
    expect(await reg.resolve("ses_a")).toBe("/a");
    reg.invalidate("ses_a");
    expect(await reg.resolve("ses_a")).toBe("/b");
  });

  describe("authentication", () => {
    const origEnv = process.env;

    beforeEach(() => {
      process.env = { ...origEnv };
      delete process.env.OPENCODE_SERVER_PASSWORD;
      delete process.env.OPENCODE_SERVER_PASSWORD_FILE;
      delete process.env.OPENCODE_SERVER_USERNAME;
      invalidateServeAuthHeader();
    });

    afterEach(() => {
      process.env = origEnv;
      invalidateServeAuthHeader();
    });

    it("sends Authorization header when OPENCODE_SERVER_PASSWORD is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "registrypass";
      const fetchFn = fakeFetch([
        new Response(JSON.stringify({ id: "ses_a", directory: "/home/dev/dir" }), {
          status: 200,
        }),
      ]);
      const reg = new SessionDirectoryRegistry({
        baseUrl: "http://x",
        ttlMs: 60_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        nowFn: () => 1_000,
      });

      await reg.resolve("ses_a");

      const expectedHeader = `Basic ${Buffer.from("opencode:registrypass").toString("base64")}`;
      expect(fetchFn).toHaveBeenCalledWith(
        "http://x/session/ses_a",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expectedHeader,
          }),
        }),
      );
    });

    it("omits Authorization header when OPENCODE_SERVER_PASSWORD is unset", async () => {
      const fetchFn = fakeFetch([
        new Response(JSON.stringify({ id: "ses_a", directory: "/home/dev/dir" }), {
          status: 200,
        }),
      ]);
      const reg = new SessionDirectoryRegistry({
        baseUrl: "http://x",
        ttlMs: 60_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        nowFn: () => 1_000,
      });

      await reg.resolve("ses_a");

      const callInit = fetchFn.mock.calls[0]![1];
      // No headers object at all when auth is off -- byte-identical to pre-change.
      expect((callInit as RequestInit).headers).toBeUndefined();
    });
  });

  // pigeon-wfj1. resolve() had NO bound of any kind -- no signal, no timeout,
  // on either phase. It is reached from the SwarmArbiter via
  // makeDirectoryResolver (routing/directory-resolver.ts:32), whose try/catch
  // cannot help: a hang is not a throw. An unbounded resolve there holds the
  // arbiter's at-most-one-in-flight slot for the target session forever.
  describe("request deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects when the serve accepts but never sends headers", async () => {
      vi.useFakeTimers();
      const hangingFetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      const reg = new SessionDirectoryRegistry({
        baseUrl: "http://x",
        ttlMs: 60_000,
        fetchFn: hangingFetch as unknown as typeof fetch,
        nowFn: () => 1_000,
        requestTimeoutMs: 10_000,
      });

      const pending = reg.resolve("ses_a");
      const assertion = expect(pending).rejects.toThrow(/timed out after 10000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    });

    // Same body-phase hole as the client: headers arrive, body never does.
    it("rejects when the body never arrives", async () => {
      vi.useFakeTimers();
      const stalled = {
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => {}),
        text: () => new Promise<never>(() => {}),
      } as unknown as Response;
      const fetchFn = vi.fn(async () => stalled);
      const reg = new SessionDirectoryRegistry({
        baseUrl: "http://x",
        ttlMs: 60_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        nowFn: () => 1_000,
        requestTimeoutMs: 10_000,
      });

      const pending = reg.resolve("ses_a");
      const assertion = expect(pending).rejects.toThrow(/timed out after 10000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    });

    it("passes an AbortSignal to fetch", async () => {
      const fetchFn = fakeFetch([
        new Response(JSON.stringify({ id: "ses_a", directory: "/home/dev/dir" }), {
          status: 200,
        }),
      ]);
      const reg = new SessionDirectoryRegistry({
        baseUrl: "http://x",
        ttlMs: 60_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        nowFn: () => 1_000,
      });

      await reg.resolve("ses_a");

      const callInit = fetchFn.mock.calls[0]![1] as RequestInit;
      expect(callInit.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

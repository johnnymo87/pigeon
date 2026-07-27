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
      expect((callInit as RequestInit).headers?.["Authorization" as keyof HeadersInit]).toBeUndefined();
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { makeLocalityResolver } from "../src/routing/locality";

function res(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ id: "x", directory: "/d" }) : "nope", { status });
}

function build(opts: {
  rows?: string[];
  bases?: string[];
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}) {
  const fetchFn = opts.fetchFn ?? (vi.fn() as unknown as typeof fetch);
  const resolve = makeLocalityResolver({
    hasLocalSession: (id) => (opts.rows ?? []).includes(id),
    baseUrlsFor: () => opts.bases ?? ["http://a"],
    fetchFn,
    timeoutMs: opts.timeoutMs,
  });
  return { resolve, fetchFn };
}

describe("makeLocalityResolver", () => {
  it("a local session row is local without probing any serve", async () => {
    const { resolve, fetchFn } = build({ rows: ["ses_x"] });
    expect(await resolve("ses_x")).toBe("local");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("gse_ with a local row is local", async () => {
    const { resolve } = build({ rows: ["gse_1"] });
    expect(await resolve("gse_1")).toBe("local");
  });

  it("gse_ without a local row is remote and never probes (serves answer 500 for gse_)", async () => {
    const { resolve, fetchFn } = build({});
    expect(await resolve("gse_1")).toBe("remote");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("serve 200 -> local (subagents, sessions not yet registered)", async () => {
    const fetchFn = vi.fn(async () => res(200)) as unknown as typeof fetch;
    const { resolve } = build({ fetchFn });
    expect(await resolve("ses_x")).toBe("local");
  });

  it("serve 404 -> remote", async () => {
    const fetchFn = vi.fn(async () => res(404)) as unknown as typeof fetch;
    const { resolve } = build({ fetchFn });
    expect(await resolve("ses_x")).toBe("remote");
  });

  it("probes GET <base>/session/<id> with no directory header", async () => {
    const fetchFn = vi.fn(async () => res(404)) as unknown as typeof fetch;
    const { resolve } = build({ fetchFn, bases: ["http://a/"] });
    await resolve("ses_x y");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("http://a/session/ses_x%20y");
    expect((init as RequestInit).method).toBe("GET");
    const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-opencode-directory");
  });

  it("500 / transport error / timeout is never remote: unknown", async () => {
    for (const fetchFn of [
      vi.fn(async () => res(500)),
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      vi.fn(() => new Promise<Response>(() => {})),
    ]) {
      const { resolve } = build({ fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 });
      expect(await resolve("ses_x")).toBe("unknown");
    }
  });

  it("falls through a failing serve to the next base; first definitive answer wins", async () => {
    const fetchFn = vi.fn(async (url: string) => (url.startsWith("http://a") ? res(503) : res(404)));
    const { resolve } = build({ fetchFn: fetchFn as unknown as typeof fetch, bases: ["http://a", "http://b", "http://c"] });
    expect(await resolve("ses_x")).toBe("remote");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates bases", async () => {
    const fetchFn = vi.fn(async () => res(500));
    const { resolve } = build({ fetchFn: fetchFn as unknown as typeof fetch, bases: ["http://a", "http://a/", "http://a"] });
    expect(await resolve("ses_x")).toBe("unknown");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("no bases at all -> unknown", async () => {
    const { resolve } = build({ bases: [] });
    expect(await resolve("ses_x")).toBe("unknown");
  });

  it("does not cache verdicts", async () => {
    let status = 404;
    const fetchFn = vi.fn(async () => res(status));
    const { resolve } = build({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await resolve("ses_x")).toBe("remote");
    status = 200;
    expect(await resolve("ses_x")).toBe("local");
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OpencodeClient } from "../src/opencode-client";

describe("OpencodeClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("healthCheck", () => {
    it("returns true when GET /global/health responds with 200", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.healthCheck();

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/global/health",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns false when fetch throws a network error", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.healthCheck();

      expect(result).toBe(false);
    });

    it("returns false when response is non-200", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe("createSession", () => {
    it("sends POST to /session with x-opencode-directory header and returns parsed id", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "sess-abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.createSession("/home/user/project");

      expect(result).toEqual({ id: "sess-abc" });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-opencode-directory": "/home/user/project",
          }),
        }),
      );
    });

    it("throws when response is non-OK", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad" }), {
        status: 400,
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.createSession("/home/user/project")).rejects.toThrow();
    });
  });

  describe("sendPrompt", () => {
    it("sends POST to /session/:id/prompt_async with directory header and text body", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.sendPrompt("sess-abc", "/home/user/project", "Hello, world!");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc/prompt_async",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-opencode-directory": "/home/user/project",
          }),
          body: JSON.stringify({ parts: [{ type: "text", text: "Hello, world!" }] }),
        }),
      );
    });

    it("throws when response is non-OK", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 500, statusText: "Internal Server Error" }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.sendPrompt("sess-abc", "/home/user/project", "Hello")).rejects.toThrow(
        "sendPrompt failed: 500 Internal Server Error",
      );
    });
  });

  describe("deleteSession", () => {
    it("sends DELETE to /session/:id and resolves on success", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.deleteSession("sess-abc");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("throws when response is non-OK", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404, statusText: "Not Found" }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.deleteSession("sess-abc")).rejects.toThrow(
        "deleteSession failed: 404 Not Found",
      );
    });
  });
});

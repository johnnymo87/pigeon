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

  describe("getSessionMessages", () => {
    it("calls GET /session/:id/message and returns parsed JSON array", async () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.getSessionMessages("sess-abc");

      expect(result).toEqual(messages);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc/message",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("session not found", { status: 404 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.getSessionMessages("sess-abc")).rejects.toThrow(
        "getSessionMessages failed (404): session not found",
      );
    });
  });

  describe("summarize", () => {
    it("calls POST /session/:id/summarize with correct body", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.summarize("sess-abc", "anthropic", "claude-3-5-sonnet");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc/summarize",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
          body: JSON.stringify({ providerID: "anthropic", modelID: "claude-3-5-sonnet", auto: false }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("summarize error", { status: 500 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.summarize("sess-abc", "anthropic", "claude-3-5-sonnet")).rejects.toThrow(
        "summarize failed (500): summarize error",
      );
    });
  });

  describe("mcpStatus", () => {
    it("calls GET /mcp and returns parsed status map", async () => {
      const statusMap = {
        "filesystem": { status: "connected" },
        "github": { status: "error", error: "auth failed" },
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(statusMap), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.mcpStatus();

      expect(result).toEqual(statusMap);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("internal error", { status: 500 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.mcpStatus()).rejects.toThrow("mcpStatus failed (500): internal error");
    });
  });

  describe("mcpConnect", () => {
    it("calls POST /mcp/:name/connect and returns true on success", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.mcpConnect("filesystem");

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/filesystem/connect",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("URL-encodes the server name", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpConnect("my server");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/my%20server/connect",
        expect.anything(),
      );
    });

    it("returns false on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.mcpConnect("filesystem");

      expect(result).toBe(false);
    });
  });

  describe("mcpDisconnect", () => {
    it("calls POST /mcp/:name/disconnect and returns true on success", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.mcpDisconnect("filesystem");

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/filesystem/disconnect",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("URL-encodes the server name", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpDisconnect("my server");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/my%20server/disconnect",
        expect.anything(),
      );
    });

    it("returns false on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.mcpDisconnect("filesystem");

      expect(result).toBe(false);
    });
  });

  describe("listProviders", () => {
    it("calls GET /provider and returns parsed provider list", async () => {
      const providerData = {
        all: [
          { id: "anthropic", models: { "claude-3-5-sonnet": {} } },
          { id: "openai", models: { "gpt-4": {} } },
        ],
        default: { anthropic: "claude-3-5-sonnet" },
        connected: ["anthropic"],
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(providerData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = await client.listProviders();

      expect(result).toEqual(providerData);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/provider",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("not authorized", { status: 401 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.listProviders()).rejects.toThrow("listProviders failed (401): not authorized");
    });
  });
});

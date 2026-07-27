import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OpencodeClient } from "../src/opencode-client";
import { invalidateServeAuthHeader } from "../src/serve-auth";

describe("OpencodeClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Unconditional: a test that throws before its own useRealTimers() would
    // otherwise leak fake timers into every subsequent test in this file.
    vi.useRealTimers();
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

    // pigeon-h21. A serve that ACCEPTS the connection but never responds used to
    // leave this promise pending forever. The SwarmArbiter is at-most-one-in-flight
    // per target and releases the slot in a `.finally()` (swarm/arbiter.ts:76-77),
    // so a promise that never settles wedges ALL swarm delivery to that session --
    // with no rejection to retry on and no failure to observe.
    it("aborts and rejects when the serve accepts but never responds", async () => {
      vi.useFakeTimers();

      // Mimic real fetch: stay pending until the caller's AbortSignal fires.
      // A stub that ignores the signal would hang here rather than fail, which is
      // the point -- this test can only pass if sendPrompt actually wires one up.
      const hangingFetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: hangingFetch as unknown as typeof fetch,
        requestTimeoutMs: 30_000,
      });

      const pending = client.sendPrompt("sess-abc", "/home/user/project", "Hello");
      // Assert rejection before advancing, so an unhandled rejection can't escape.
      const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/);

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;

    });

    it("passes an AbortSignal to fetch and clears the timer on success", async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
        requestTimeoutMs: 30_000,
      });

      await client.sendPrompt("sess-abc", "/home/user/project", "Hello");

      // Without this the abort would be unobservable to a stub that ignores signals.
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc/prompt_async",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // A leaked timer would keep the daemon's event loop referenced per send.
      expect(clearSpy).toHaveBeenCalled();

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

  describe("abortSession", () => {
    it("sends POST to /session/:id/abort and resolves on success", async () => {
      fetchMock.mockResolvedValueOnce(new Response("true", { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.abortSession("sess-abc");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session/sess-abc/abort",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws when response is non-OK", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404, statusText: "Not Found" }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.abortSession("sess-abc")).rejects.toThrow(
        "abortSession failed: 404 Not Found",
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

    it("sends x-opencode-directory header when directory is provided", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpStatus("/home/dev/projects/eternal-machinery");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "x-opencode-directory": "/home/dev/projects/eternal-machinery",
          }),
        }),
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

    it("sends x-opencode-directory header when directory is provided", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpConnect("tec", "/home/dev/projects/eternal-machinery");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/tec/connect",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-opencode-directory": "/home/dev/projects/eternal-machinery",
          }),
        }),
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

    it("sends x-opencode-directory header when directory is provided", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpDisconnect("tec", "/home/dev/projects/eternal-machinery");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp/tec/disconnect",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-opencode-directory": "/home/dev/projects/eternal-machinery",
          }),
        }),
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
      fetchMock.mockResolvedValue(new Response("not authorized", { status: 401 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await expect(client.listProviders()).rejects.toThrow("listProviders failed (401): not authorized");
    });
  });
  describe("getSession", () => {
    it("returns session when opencode-serve responds 200 with a directory", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ id: "ses_abc", directory: "/home/dev/projects/pigeon" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      const result = await client.getSession("ses_abc");

      expect(result).toEqual({ id: "ses_abc", directory: "/home/dev/projects/pigeon" });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4096/session/ses_abc",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns null when opencode-serve responds 404", async () => {
      const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      expect(await client.getSession("ses_gone")).toBeNull();
    });

    it("throws on other non-OK statuses (so caller can distinguish from 404)", async () => {
      const fetchMock = vi.fn(async () => new Response("oops", { status: 500 }));
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      await expect(client.getSession("ses_x")).rejects.toThrow(/getSession failed.*500/);
    });

    it("throws on network error (so caller can distinguish from 404)", async () => {
      const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      await expect(client.getSession("ses_x")).rejects.toThrow(/ECONNREFUSED/);
    });

    it("returns the directory even when other fields are missing", async () => {
      // Defensive: opencode-serve's response shape isn't formally pinned by us;
      // we only depend on { id, directory } being present.
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ id: "ses_x", directory: "/tmp", extra: "stuff" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      expect((await client.getSession("ses_x"))?.directory).toBe("/tmp");
    });

    it("throws when 200 response is missing id or directory", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ id: "ses_x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      await expect(client.getSession("ses_x")).rejects.toThrow(/missing id or directory/);
    });
  });

  describe("getSessionInfo", () => {
    it("returns session info when opencode-serve responds 200 with directory, title, and times", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({
          id: "ses_abc",
          title: "My Session",
          directory: "/home/dev/projects/pigeon",
          time: { created: 12345678, updated: 12345679 }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      const result = await client.getSessionInfo("ses_abc");

      expect(result).toEqual({
        id: "ses_abc",
        title: "My Session",
        directory: "/home/dev/projects/pigeon",
        time: { created: 12345678, updated: 12345679 }
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4096/session/ses_abc",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns null when response is 404", async () => {
      const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      expect(await client.getSessionInfo("ses_gone")).toBeNull();
    });

    it("throws on other non-OK statuses", async () => {
      const fetchMock = vi.fn(async () => new Response("oops", { status: 500 }));
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      await expect(client.getSessionInfo("ses_x")).rejects.toThrow(/getSessionInfo failed.*500/);
    });

    it("defaults missing title and times", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({
          id: "ses_abc",
          directory: "/home/dev/projects/pigeon"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      const result = await client.getSessionInfo("ses_abc");

      expect(result).toEqual({
        id: "ses_abc",
        title: "",
        directory: "/home/dev/projects/pigeon",
        time: { created: 0, updated: 0 }
      });
    });

    it("throws when response is missing id or directory", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ id: "ses_abc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: fetchMock as unknown as typeof fetch });

      await expect(client.getSessionInfo("ses_abc")).rejects.toThrow(/missing id or directory/);
    });
  });

  describe("authentication and 401 retry", () => {
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

    it("omits Authorization header entirely when password is unset", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.healthCheck();

      const callInit = fetchMock.mock.calls[0]![1];
      expect(callInit.headers?.["Authorization"]).toBeUndefined();
      expect(callInit.headers?.Authorization).toBeUndefined();
    });

    it("injects Authorization header when OPENCODE_SERVER_PASSWORD is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "testpassword";
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.healthCheck();

      const expectedHeader = `Basic ${Buffer.from("opencode:testpassword").toString("base64")}`;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/global/health",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedHeader,
          }),
        }),
      );
    });

    it("preserves caller-supplied headers alongside Authorization", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "testpassword";
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.createSession("/my/dir");

      const expectedHeader = `Basic ${Buffer.from("opencode:testpassword").toString("base64")}`;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/session",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-opencode-directory": "/my/dir",
            Authorization: expectedHeader,
          }),
        }),
      );
    });

    it("mcpStatus receives Authorization header when no directory is provided (conditional-spread path)", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "testpassword";
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      await client.mcpStatus();

      const expectedHeader = `Basic ${Buffer.from("opencode:testpassword").toString("base64")}`;
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:4320/mcp",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expectedHeader,
          }),
        }),
      );
    });

    it("on 401 response: invalidates header, re-resolves, and retries request once", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "oldpassword";
      const oldHeader = `Basic ${Buffer.from("opencode:oldpassword").toString("base64")}`;
      const newHeader = `Basic ${Buffer.from("opencode:newpassword").toString("base64")}`;

      fetchMock
        .mockImplementationOnce(async (_url, init) => {
          expect(init.headers.Authorization).toBe(oldHeader);
          process.env.OPENCODE_SERVER_PASSWORD = "newpassword";
          return new Response("unauthorized", { status: 401 });
        })
        .mockImplementationOnce(async (_url, init) => {
          expect(init.headers.Authorization).toBe(newHeader);
          return new Response(null, { status: 200 });
        });

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const ok = await client.healthCheck();

      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry a second time if the retry also returns 401", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "badpassword";
      fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

      const client = new OpencodeClient({
        baseUrl: "http://localhost:4320",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const ok = await client.healthCheck();

      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  ingestMcpListCommand,
  ingestMcpEnableCommand,
  ingestMcpDisableCommand,
  type McpListCommandInput,
  type McpEnableCommandInput,
  type McpDisableCommandInput,
} from "../src/worker/mcp-ingest";

describe("ingestMcpListCommand", () => {
  function makeInput(overrides?: Partial<McpListCommandInput>): McpListCommandInput {
    return {
      commandId: "cmd-1",
      sessionId: "sess-abc",
      chatId: "12345",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({}),
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("lists MCP servers with correct status emojis and entities", async () => {
    const input = makeInput({
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({
          filesystem: { status: "connected" },
          slack: { status: "disabled" },
          browser: { status: "failed", error: "connection timeout" },
          github: { status: "needs_auth" },
          jira: { status: "needs_client_registration" },
        }),
      },
    });

    await ingestMcpListCommand(input);

    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("🔌 ");
    expect(text).toContain("MCP Servers:");
    expect(text).toContain("✅ filesystem — connected");
    expect(text).toContain("❌ slack — disabled");
    expect(text).toContain("⚠️ browser — failed: connection timeout");
    expect(text).toContain("🔑 github — needs_auth");
    expect(text).toContain("🔑 jira — needs_client_registration");
    expect(text).not.toContain("`");
    expect(text).not.toContain("*");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bold" }),
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("includes session ID in reply as code entity", async () => {
    const input = makeInput({
      sessionId: "sess-xyz",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ fs: { status: "connected" } }),
      },
    });

    await ingestMcpListCommand(input);

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("sess-xyz");
    expect(text).not.toContain("`");
  });

  it("includes enable/disable command hints without session ID (swipe-reply)", async () => {
    const input = makeInput({
      sessionId: "sess-xyz",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ fs: { status: "connected" } }),
      },
    });

    await ingestMcpListCommand(input);

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("/mcp enable <server>");
    expect(text).toContain("/mcp disable <server>");
    // session ID removed from command hints (swipe-reply)
    expect(text).not.toMatch(/\/mcp enable <server> sess-xyz/);
    expect(text).not.toMatch(/\/mcp disable <server> sess-xyz/);
  });

  it("shows empty message when no servers configured", async () => {
    const input = makeInput({
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({}),
      },
    });

    await ingestMcpListCommand(input);

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("MCP Servers:");
    expect(text).toContain("No MCP servers configured");
  });

  it("sends error reply when mcpStatus throws", async () => {
    const input = makeInput({
      opencodeClient: {
        mcpStatus: vi.fn().mockRejectedValue(new Error("server unreachable")),
      },
    });

    await ingestMcpListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to list MCP servers: server unreachable"),
    );
  });

  it("passes directory to mcpStatus when provided", async () => {
    const mcpStatusMock = vi.fn().mockResolvedValue({ tec: { status: "connected" } });
    const input = makeInput({
      directory: "/home/dev/projects/eternal-machinery",
      opencodeClient: { mcpStatus: mcpStatusMock },
    });

    await ingestMcpListCommand(input);

    expect(mcpStatusMock).toHaveBeenCalledWith("/home/dev/projects/eternal-machinery");
  });
});

describe("ingestMcpEnableCommand", () => {
  function makeInput(overrides?: Partial<McpEnableCommandInput>): McpEnableCommandInput {
    return {
      commandId: "cmd-2",
      sessionId: "sess-abc",
      chatId: "12345",
      serverName: "filesystem",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({}),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("connects a disabled server and sends confirmation with entities", async () => {
    const input = makeInput({
      serverName: "slack",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ slack: { status: "disabled" } }),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("slack", undefined);
    expect(input.opencodeClient.mcpDisconnect).not.toHaveBeenCalled();
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("🔌 ");
    expect(text).toContain("slack");
    expect(text).toContain("connected ✅");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("connects a failed server and sends confirmation with entities", async () => {
    const input = makeInput({
      serverName: "browser",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ browser: { status: "failed", error: "timeout" } }),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("browser", undefined);
    expect(input.opencodeClient.mcpDisconnect).not.toHaveBeenCalled();
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("browser");
    expect(text).toContain("connected ✅");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("cycles (disconnect then connect) an already connected server", async () => {
    const connectMock = vi.fn().mockResolvedValue(true);
    const disconnectMock = vi.fn().mockResolvedValue(true);
    const input = makeInput({
      serverName: "filesystem",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ filesystem: { status: "connected" } }),
        mcpConnect: connectMock,
        mcpDisconnect: disconnectMock,
      },
    });

    await ingestMcpEnableCommand(input);

    expect(disconnectMock).toHaveBeenCalledWith("filesystem", undefined);
    expect(connectMock).toHaveBeenCalledWith("filesystem", undefined);
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("filesystem");
    expect(text).toContain("reconnected ✅");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends not found message when server name is not in status, with entities", async () => {
    const input = makeInput({
      serverName: "unknown-server",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({
          filesystem: { status: "connected" },
          slack: { status: "disabled" },
        }),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpConnect).not.toHaveBeenCalled();
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("MCP server ");
    expect(text).toContain("unknown-server");
    expect(text).toContain("not found");
    expect(text).toContain("filesystem");
    expect(text).toContain("slack");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends error reply when an exception is thrown, with entities", async () => {
    const input = makeInput({
      serverName: "filesystem",
      opencodeClient: {
        mcpStatus: vi.fn().mockRejectedValue(new Error("API error")),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("Failed to enable ");
    expect(text).toContain("filesystem");
    expect(text).toContain("API error");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("passes directory to mcpStatus, mcpConnect, and mcpDisconnect", async () => {
    const mcpStatusMock = vi.fn().mockResolvedValue({ tec: { status: "connected" } });
    const mcpConnectMock = vi.fn().mockResolvedValue(true);
    const mcpDisconnectMock = vi.fn().mockResolvedValue(true);
    const input = makeInput({
      serverName: "tec",
      directory: "/home/dev/projects/eternal-machinery",
      opencodeClient: {
        mcpStatus: mcpStatusMock,
        mcpConnect: mcpConnectMock,
        mcpDisconnect: mcpDisconnectMock,
      },
    });

    await ingestMcpEnableCommand(input);

    expect(mcpStatusMock).toHaveBeenCalledWith("/home/dev/projects/eternal-machinery");
    expect(mcpDisconnectMock).toHaveBeenCalledWith("tec", "/home/dev/projects/eternal-machinery");
    expect(mcpConnectMock).toHaveBeenCalledWith("tec", "/home/dev/projects/eternal-machinery");
  });
});

describe("ingestMcpDisableCommand", () => {
  function makeInput(overrides?: Partial<McpDisableCommandInput>): McpDisableCommandInput {
    return {
      commandId: "cmd-3",
      sessionId: "sess-abc",
      chatId: "12345",
      serverName: "filesystem",
      opencodeClient: {
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("disconnects server and sends confirmation with entities", async () => {
    const input = makeInput({ serverName: "slack" });

    await ingestMcpDisableCommand(input);

    expect(input.opencodeClient.mcpDisconnect).toHaveBeenCalledWith("slack", undefined);
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("🔌 ");
    expect(text).toContain("slack");
    expect(text).toContain("disconnected");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends error reply when mcpDisconnect throws, with entities", async () => {
    const input = makeInput({
      serverName: "filesystem",
      opencodeClient: {
        mcpDisconnect: vi.fn().mockRejectedValue(new Error("disconnect failed")),
      },
    });

    await ingestMcpDisableCommand(input);

    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("Failed to disable ");
    expect(text).toContain("filesystem");
    expect(text).toContain("disconnect failed");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("passes directory to mcpDisconnect when provided", async () => {
    const mcpDisconnectMock = vi.fn().mockResolvedValue(true);
    const input = makeInput({
      serverName: "tec",
      directory: "/home/dev/projects/eternal-machinery",
      opencodeClient: { mcpDisconnect: mcpDisconnectMock },
    });

    await ingestMcpDisableCommand(input);

    expect(mcpDisconnectMock).toHaveBeenCalledWith("tec", "/home/dev/projects/eternal-machinery");
  });
});

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

  it("lists MCP servers with correct status emojis", async () => {
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

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("🔌 *MCP Servers:*");
    expect(reply).toContain("✅ `filesystem` — connected");
    expect(reply).toContain("❌ `slack` — disabled");
    expect(reply).toContain("⚠️ `browser` — failed: connection timeout");
    expect(reply).toContain("🔑 `github` — needs_auth");
    expect(reply).toContain("🔑 `jira` — needs_client_registration");
  });

  it("includes session ID in reply", async () => {
    const input = makeInput({
      sessionId: "sess-xyz",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ fs: { status: "connected" } }),
      },
    });

    await ingestMcpListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("`sess-xyz`");
  });

  it("includes enable/disable command hints with session ID", async () => {
    const input = makeInput({
      sessionId: "sess-xyz",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ fs: { status: "connected" } }),
      },
    });

    await ingestMcpListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("/mcp enable <server> sess-xyz");
    expect(reply).toContain("/mcp disable <server> sess-xyz");
  });

  it("shows empty message when no servers configured", async () => {
    const input = makeInput({
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({}),
      },
    });

    await ingestMcpListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("🔌 *MCP Servers:*");
    expect(reply).toContain("No MCP servers configured");
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

  it("connects a disabled server and sends confirmation", async () => {
    const input = makeInput({
      serverName: "slack",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ slack: { status: "disabled" } }),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("slack");
    expect(input.opencodeClient.mcpDisconnect).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("🔌 `slack` connected ✅"),
    );
  });

  it("connects a failed server and sends confirmation", async () => {
    const input = makeInput({
      serverName: "browser",
      opencodeClient: {
        mcpStatus: vi.fn().mockResolvedValue({ browser: { status: "failed", error: "timeout" } }),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("browser");
    expect(input.opencodeClient.mcpDisconnect).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("🔌 `browser` connected ✅"),
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

    expect(disconnectMock).toHaveBeenCalledWith("filesystem");
    expect(connectMock).toHaveBeenCalledWith("filesystem");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("🔌 `filesystem` reconnected ✅"),
    );
  });

  it("sends not found message when server name is not in status", async () => {
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
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("MCP server `unknown-server` not found"),
    );
    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("filesystem");
    expect(reply).toContain("slack");
  });

  it("sends error reply when an exception is thrown", async () => {
    const input = makeInput({
      serverName: "filesystem",
      opencodeClient: {
        mcpStatus: vi.fn().mockRejectedValue(new Error("API error")),
        mcpConnect: vi.fn().mockResolvedValue(true),
        mcpDisconnect: vi.fn().mockResolvedValue(true),
      },
    });

    await ingestMcpEnableCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to enable `filesystem`: API error"),
    );
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

  it("disconnects server and sends confirmation", async () => {
    const input = makeInput({ serverName: "slack" });

    await ingestMcpDisableCommand(input);

    expect(input.opencodeClient.mcpDisconnect).toHaveBeenCalledWith("slack");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("🔌 `slack` disconnected"),
    );
  });

  it("sends error reply when mcpDisconnect throws", async () => {
    const input = makeInput({
      serverName: "filesystem",
      opencodeClient: {
        mcpDisconnect: vi.fn().mockRejectedValue(new Error("disconnect failed")),
      },
    });

    await ingestMcpDisableCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to disable `filesystem`: disconnect failed"),
    );
  });
});

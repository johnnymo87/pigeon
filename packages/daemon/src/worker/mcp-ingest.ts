import type { OpencodeClient } from "../opencode-client";

export interface McpListCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export interface McpEnableCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus" | "mcpConnect" | "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export interface McpDisableCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

const STATUS_EMOJI: Record<string, string> = {
  connected: "✅",
  disabled: "❌",
  failed: "⚠️",
  needs_auth: "🔑",
  needs_client_registration: "🔑",
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? "❓";
}

export async function ingestMcpListCommand(input: McpListCommandInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendTelegramReply } = input;

  try {
    const servers = await opencodeClient.mcpStatus();
    const entries = Object.entries(servers);

    let body = `🔌 *MCP Servers:*\n🆔 \`${sessionId}\`\n\n`;

    if (entries.length === 0) {
      body += "No MCP servers configured\n";
    } else {
      for (const [name, info] of entries) {
        const emoji = statusEmoji(info.status);
        if (info.status === "failed" && info.error) {
          body += `${emoji} \`${name}\` — ${info.status}: ${info.error}\n`;
        } else {
          body += `${emoji} \`${name}\` — ${info.status}\n`;
        }
      }
    }

    body += `\n\`/mcp enable <server> ${sessionId}\`\n\`/mcp disable <server> ${sessionId}\``;

    await sendTelegramReply(chatId, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to list MCP servers: ${message}`);
  }
}

export async function ingestMcpEnableCommand(input: McpEnableCommandInput): Promise<void> {
  const { sessionId, chatId, serverName, opencodeClient, sendTelegramReply } = input;

  try {
    const servers = await opencodeClient.mcpStatus();

    if (!(serverName in servers)) {
      const available = Object.keys(servers).join(", ");
      await sendTelegramReply(
        chatId,
        `MCP server \`${serverName}\` not found. Available: ${available}`,
      );
      return;
    }

    const serverInfo = servers[serverName];
    if (serverInfo && serverInfo.status === "connected") {
      await opencodeClient.mcpDisconnect(serverName);
      await opencodeClient.mcpConnect(serverName);
      await sendTelegramReply(chatId, `🔌 \`${serverName}\` reconnected ✅`);
    } else {
      await opencodeClient.mcpConnect(serverName);
      await sendTelegramReply(chatId, `🔌 \`${serverName}\` connected ✅`);
    }

    console.log(`[mcp-ingest] enable commandId=${input.commandId} server=${serverName} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to enable \`${serverName}\`: ${message}`);
  }
}

export async function ingestMcpDisableCommand(input: McpDisableCommandInput): Promise<void> {
  const { sessionId, chatId, serverName, opencodeClient, sendTelegramReply } = input;

  try {
    await opencodeClient.mcpDisconnect(serverName);
    await sendTelegramReply(chatId, `🔌 \`${serverName}\` disconnected`);
    console.log(`[mcp-ingest] disable commandId=${input.commandId} server=${serverName} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to disable \`${serverName}\`: ${message}`);
  }
}

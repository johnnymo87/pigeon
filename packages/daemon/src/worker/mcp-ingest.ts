import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";

export interface McpListCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  directory?: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus">;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export interface McpEnableCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  directory?: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus" | "mcpConnect" | "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export interface McpDisableCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  directory?: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
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
  const { sessionId, chatId, directory, opencodeClient, sendTelegramReply } = input;

  try {
    const servers = await opencodeClient.mcpStatus(directory);
    const entries = Object.entries(servers);

    const b = new TgMessageBuilder()
      .append("🔌 ")
      .appendBold("MCP Servers:")
      .append("\n🆔 ")
      .appendCode(sessionId)
      .newline(2);

    if (entries.length === 0) {
      b.append("No MCP servers configured\n");
    } else {
      for (const [name, info] of entries) {
        const emoji = statusEmoji(info.status);
        b.append(`${emoji} `).appendCode(name);
        if (info.status === "failed" && info.error) {
          b.append(` — ${info.status}: ${info.error}`);
        } else {
          b.append(` — ${info.status}`);
        }
        b.newline();
      }
    }

    b.newline();
    b.appendCode("/mcp enable <server>").newline();
    b.appendCode("/mcp disable <server>");

    const msg = b.build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to list MCP servers: ${message}`);
  }
}

export async function ingestMcpEnableCommand(input: McpEnableCommandInput): Promise<void> {
  const { sessionId, chatId, serverName, directory, opencodeClient, sendTelegramReply } = input;

  try {
    const servers = await opencodeClient.mcpStatus(directory);

    if (!(serverName in servers)) {
      const available = Object.keys(servers).join(", ");
      const notFound = new TgMessageBuilder()
        .append("MCP server ")
        .appendCode(serverName)
        .append(` not found. Available: ${available}`)
        .build();
      await sendTelegramReply(chatId, notFound.text, notFound.entities);
      return;
    }

    const serverInfo = servers[serverName];
    if (serverInfo && serverInfo.status === "connected") {
      await opencodeClient.mcpDisconnect(serverName, directory);
      await opencodeClient.mcpConnect(serverName, directory);
      const msg = new TgMessageBuilder()
        .append("🔌 ")
        .appendCode(serverName)
        .append(" reconnected ✅")
        .build();
      await sendTelegramReply(chatId, msg.text, msg.entities);
    } else {
      await opencodeClient.mcpConnect(serverName, directory);
      const msg = new TgMessageBuilder()
        .append("🔌 ")
        .appendCode(serverName)
        .append(" connected ✅")
        .build();
      await sendTelegramReply(chatId, msg.text, msg.entities);
    }

    console.log(`[mcp-ingest] enable commandId=${input.commandId} server=${serverName} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg = new TgMessageBuilder()
      .append("Failed to enable ")
      .appendCode(serverName)
      .append(`: ${message}`)
      .build();
    await sendTelegramReply(chatId, errMsg.text, errMsg.entities);
  }
}

export async function ingestMcpDisableCommand(input: McpDisableCommandInput): Promise<void> {
  const { sessionId, chatId, serverName, directory, opencodeClient, sendTelegramReply } = input;

  try {
    await opencodeClient.mcpDisconnect(serverName, directory);
    const msg = new TgMessageBuilder()
      .append("🔌 ")
      .appendCode(serverName)
      .append(" disconnected")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
    console.log(`[mcp-ingest] disable commandId=${input.commandId} server=${serverName} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg = new TgMessageBuilder()
      .append("Failed to disable ")
      .appendCode(serverName)
      .append(`: ${message}`)
      .build();
    await sendTelegramReply(chatId, errMsg.text, errMsg.entities);
  }
}

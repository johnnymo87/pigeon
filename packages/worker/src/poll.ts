import { verifyApiKey, unauthorized } from "./auth";
import { pollNextCommand, ackCommand, touchMachine } from "./d1-ops";

/**
 * GET /machines/:id/next
 *
 * Poll for next pending command for a machine.
 * Returns 204 if no commands available.
 * Returns JSON command payload if a command is available.
 * Updates machine last_poll_at for online detection.
 */
export async function handlePollNext(
  db: D1Database,
  env: Env,
  request: Request,
  machineId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  await touchMachine(db, machineId);
  const result = await pollNextCommand(db, machineId);

  if (!result) {
    return new Response(null, { status: 204 });
  }

  // Shape the response based on command type
  const body: Record<string, unknown> = {
    commandId: result.commandId,
    commandType: result.commandType,
    chatId: result.chatId,
  };

  if (result.commandType === "launch") {
    body.directory = result.directory;
    body.prompt = result.command;
  } else if (result.commandType === "kill") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "compact") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "mcp_list" || result.commandType === "model_list") {
    body.sessionId = result.sessionId;
  } else if (result.commandType === "mcp_enable" || result.commandType === "mcp_disable") {
    body.sessionId = result.sessionId;
    body.serverName = result.command; // server name stored in command column
  } else if (result.commandType === "model_set") {
    body.sessionId = result.sessionId;
    body.model = result.command; // model code stored in command column
  } else {
    // "execute" -- regular command
    body.sessionId = result.sessionId;
    body.command = result.command;
    if (result.mediaJson) {
      try {
        body.media = JSON.parse(result.mediaJson);
      } catch {
        // Ignore malformed media JSON
      }
    }
    if (result.metadataJson) {
      try {
        body.metadata = JSON.parse(result.metadataJson);
      } catch {
        // Ignore malformed metadata JSON
      }
    }
  }

  return Response.json(body);
}

/**
 * POST /commands/:id/ack
 *
 * Acknowledge a command (mark as done).
 * Returns 404 if command not found.
 */
export async function handleAckCommand(
  db: D1Database,
  env: Env,
  request: Request,
  commandId: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const found = await ackCommand(db, commandId);
  if (!found) {
    return Response.json({ error: "Command not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}

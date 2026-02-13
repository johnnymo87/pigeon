import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryResult } from "./types";
import {
  executeViaOpencodeDirectChannel,
  type OpencodeDirectAdapterDeps,
} from "../opencode-direct/adapter";
import {
  OpencodeDirectSource,
  type OpencodeDirectSource as OpencodeDirectSourceType,
} from "../opencode-direct/contracts";

export interface DirectChannelAdapterDeps extends OpencodeDirectAdapterDeps {}

function sourceForCommand(command: string): OpencodeDirectSourceType {
  const trimmed = command.trim();
  if (
    trimmed === "continue"
    || trimmed === "y"
    || trimmed === "n"
    || trimmed === "exit"
  ) {
    return OpencodeDirectSource.TelegramCallback;
  }
  return OpencodeDirectSource.TelegramReply;
}

export class DirectChannelAdapter implements CommandDeliveryAdapter {
  readonly name = "direct-channel";

  constructor(private readonly deps: DirectChannelAdapterDeps = {}) {}

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: { commandId: string; chatId?: string | number },
  ): Promise<CommandDeliveryResult> {
    const endpoint = session.backendEndpoint;
    const authToken = session.backendAuthToken;

    if (!endpoint || !authToken) {
      return {
        ok: false,
        error: "Session missing backendEndpoint or backendAuthToken",
      };
    }

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: context.commandId,
        commandId: context.commandId,
        sessionId: session.sessionId,
        command,
        endpoint,
        authToken,
        source: sourceForCommand(command),
        ...(context.chatId !== undefined
          ? { chatId: String(context.chatId) }
          : {}),
      },
      this.deps,
    );

    if (result.ok) {
      return {
        ok: true,
        meta: {
          attempts: result.attempts,
          status: result.status,
        },
      };
    }

    const error =
      result.result?.errorMessage
      || result.error
      || result.ack?.message
      || result.ack?.rejectReason
      || "OpenCode direct-channel execution failed";

    return {
      ok: false,
      error,
      meta: {
        attempts: result.attempts,
        status: result.status,
      },
    };
  }
}

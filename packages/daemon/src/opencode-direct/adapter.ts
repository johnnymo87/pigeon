import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  OpencodeDirectSource,
  isCommandAckEnvelope,
  isCommandResultEnvelope,
  type CommandAckEnvelope,
  type CommandResultEnvelope,
  type ExecuteCommandEnvelope,
  type OpencodeDirectSource as OpencodeDirectSourceType,
} from "./contracts";

export interface OpencodeDirectExecuteInput {
  requestId: string;
  commandId: string;
  sessionId: string;
  command: string;
  endpoint: string;
  authToken: string;
  source?: OpencodeDirectSourceType;
  chatId?: string;
  replyToMessageId?: string;
  replyToken?: string;
  deadlineMs?: number;
}

export interface OpencodeDirectExecuteResult {
  ok: boolean;
  status: number;
  ack?: CommandAckEnvelope;
  result?: CommandResultEnvelope;
  error?: string;
}

export interface OpencodeDirectAdapterDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: (message: string, fields?: Record<string, unknown>) => void;
}

function buildExecuteEnvelope(input: OpencodeDirectExecuteInput, now: () => number): ExecuteCommandEnvelope {
  return {
    type: OpencodeDirectMessageType.Execute,
    version: OPENCODE_DIRECT_PROTOCOL_VERSION,
    requestId: input.requestId,
    commandId: input.commandId,
    sessionId: input.sessionId,
    command: input.command,
    source: input.source ?? OpencodeDirectSource.TelegramReply,
    issuedAt: now(),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    metadata: {
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.replyToken ? { replyToken: input.replyToken } : {}),
    },
  };
}

export async function executeViaOpencodeDirectChannel(
  input: OpencodeDirectExecuteInput,
  deps: OpencodeDirectAdapterDeps = {},
): Promise<OpencodeDirectExecuteResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => undefined);

  const envelope = buildExecuteEnvelope(input, now);
  log("opencode-direct.execute.start", {
    endpoint: input.endpoint,
    sessionId: input.sessionId,
    commandId: input.commandId,
  });

  let response: Response;
  try {
    response = await fetchFn(input.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("opencode-direct.execute.network_error", { error: message, endpoint: input.endpoint });
    return {
      ok: false,
      status: 0,
      error: message,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    log("opencode-direct.execute.invalid_json", { status: response.status });
    return {
      ok: false,
      status: response.status,
      error: "Invalid JSON response from plugin backend",
    };
  }

  const record = (payload && typeof payload === "object")
    ? (payload as Record<string, unknown>)
    : null;

  const ack = record?.ack;
  const result = record?.result;

  if (!isCommandAckEnvelope(ack)) {
    log("opencode-direct.execute.invalid_ack", { status: response.status });
    return {
      ok: false,
      status: response.status,
      error: "Plugin backend returned invalid ack envelope",
    };
  }

  if (result !== undefined && !isCommandResultEnvelope(result)) {
    log("opencode-direct.execute.invalid_result", { status: response.status });
    return {
      ok: false,
      status: response.status,
      ack,
      error: "Plugin backend returned invalid result envelope",
    };
  }

  const ok = response.ok && ack.accepted && (!result || result.success);
  log("opencode-direct.execute.done", {
    status: response.status,
    accepted: ack.accepted,
    success: isCommandResultEnvelope(result) ? result.success : undefined,
  });

  return {
    ok,
    status: response.status,
    ack,
    ...(isCommandResultEnvelope(result) ? { result } : {}),
    ...(!ok ? { error: !ack.accepted ? ack.rejectReason || "Command rejected" : undefined } : {}),
  };
}

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
  timeoutMs?: number;
  maxRetries?: number;
}

export interface OpencodeDirectExecuteResult {
  ok: boolean;
  status: number;
  attempts: number;
  ack?: CommandAckEnvelope;
  result?: CommandResultEnvelope;
  error?: string;
}

export interface OpencodeDirectAdapterDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: (message: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;

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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const timeoutMs = input.timeoutMs ?? input.deadlineMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxAttempts = Math.max(1, maxRetries + 1);

  const envelope = buildExecuteEnvelope(input, now);
  log("opencode-direct.execute.start", {
    endpoint: input.endpoint,
    sessionId: input.sessionId,
    commandId: input.commandId,
    maxAttempts,
    timeoutMs,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      response = await fetchFn(input.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.authToken}`,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message.toLowerCase().includes("abort");
      log("opencode-direct.execute.network_error", {
        attempt,
        error: message,
        timedOut,
      });

      if (attempt < maxAttempts) {
        await sleep(100 * attempt);
        continue;
      }

      return {
        ok: false,
        status: 0,
        attempts: attempt,
        error: timedOut ? `Request timed out after ${timeoutMs}ms` : message,
      };
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      log("opencode-direct.execute.invalid_json", { attempt, status: response.status });
      if (attempt < maxAttempts && response.status >= 500) {
        await sleep(100 * attempt);
        continue;
      }
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        error: "Invalid JSON response from plugin backend",
      };
    }

    const record = (payload && typeof payload === "object")
      ? (payload as Record<string, unknown>)
      : null;

    const ack = record?.ack;
    const result = record?.result;

    if (!isCommandAckEnvelope(ack)) {
      log("opencode-direct.execute.invalid_ack", { attempt, status: response.status });
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        error: "Plugin backend returned invalid ack envelope",
      };
    }

    if (
      ack.accepted
      && (
        ack.requestId !== input.requestId
        || ack.commandId !== input.commandId
        || ack.sessionId !== input.sessionId
      )
    ) {
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        ack,
        error: "Ack envelope correlation mismatch",
      };
    }

    if (result !== undefined && !isCommandResultEnvelope(result)) {
      log("opencode-direct.execute.invalid_result", { attempt, status: response.status });
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        ack,
        error: "Plugin backend returned invalid result envelope",
      };
    }

    if (
      isCommandResultEnvelope(result)
      && (
        result.requestId !== input.requestId
        || result.commandId !== input.commandId
        || result.sessionId !== input.sessionId
      )
    ) {
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        ack,
        result,
        error: "Result envelope correlation mismatch",
      };
    }

    const ok = response.ok && ack.accepted && (!result || result.success);
    log("opencode-direct.execute.done", {
      attempt,
      status: response.status,
      accepted: ack.accepted,
      success: isCommandResultEnvelope(result) ? result.success : undefined,
    });

    if (!ok && attempt < maxAttempts && response.status >= 500) {
      await sleep(100 * attempt);
      continue;
    }

    return {
      ok,
      status: response.status,
      attempts: attempt,
      ack,
      ...(isCommandResultEnvelope(result) ? { result } : {}),
      ...(!ok ? { error: !ack.accepted ? ack.rejectReason || "Command rejected" : undefined } : {}),
    };
  }

  return {
    ok: false,
    status: 0,
    attempts: maxAttempts,
    error: "Unexpected adapter state",
  };
}

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import {
  AckRejectReason,
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  ResultErrorCode,
  isExecuteCommandEnvelope,
  type CommandAckEnvelope,
  type CommandResultEnvelope,
  type ExecuteCommandEnvelope,
} from "../../daemon/src/opencode-direct/contracts"

export interface ExecuteResult {
  success: boolean
  exitCode?: number
  output?: string
  errorCode?: (typeof ResultErrorCode)[keyof typeof ResultErrorCode]
  errorMessage?: string
}

export interface DirectChannelServer {
  endpoint: string
  authToken: string
  close: () => Promise<void>
}

export interface DirectChannelOptions {
  onExecute: (request: ExecuteCommandEnvelope) => Promise<ExecuteResult>
  host?: string
  port?: number
  authToken?: string
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(" ")
  if (scheme !== "Bearer" || !token) return null
  return token
}

function json(res: import("node:http").ServerResponse, statusCode: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader("content-type", "application/json")
  res.end(data)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks).toString("utf8")
  return body ? JSON.parse(body) : {}
}

function rejectAck(reason: (typeof AckRejectReason)[keyof typeof AckRejectReason], message: string): CommandAckEnvelope {
  return {
    type: OpencodeDirectMessageType.Ack,
    version: OPENCODE_DIRECT_PROTOCOL_VERSION,
    requestId: "unknown",
    commandId: "unknown",
    sessionId: "unknown",
    accepted: false,
    acceptedAt: Date.now(),
    rejectReason: reason,
    message,
  }
}

export async function startDirectChannelServer(options: DirectChannelOptions): Promise<DirectChannelServer> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const authToken = options.authToken ?? randomUUID()

  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/pigeon/direct/health") {
      json(res, 200, { ok: true, protocol: OPENCODE_DIRECT_PROTOCOL_VERSION })
      return
    }

    if (req.method !== "POST" || req.url !== "/pigeon/direct/execute") {
      json(res, 404, { error: "Not found" })
      return
    }

    const token = bearerToken(req)
    if (token !== authToken) {
      json(res, 401, { ack: rejectAck(AckRejectReason.Unauthorized, "Unauthorized") })
      return
    }

    let payload: unknown
    try {
      payload = await readJson(req)
    } catch {
      json(res, 400, { ack: rejectAck(AckRejectReason.InvalidPayload, "Invalid JSON") })
      return
    }

    if (!isExecuteCommandEnvelope(payload)) {
      json(res, 400, { ack: rejectAck(AckRejectReason.InvalidPayload, "Invalid execute envelope") })
      return
    }

    const ack: CommandAckEnvelope = {
      type: OpencodeDirectMessageType.Ack,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: payload.requestId,
      commandId: payload.commandId,
      sessionId: payload.sessionId,
      accepted: true,
      acceptedAt: Date.now(),
    }

    try {
      const execution = await options.onExecute(payload)
      const result: CommandResultEnvelope = {
        type: OpencodeDirectMessageType.Result,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: payload.requestId,
        commandId: payload.commandId,
        sessionId: payload.sessionId,
        success: execution.success,
        finishedAt: Date.now(),
        exitCode: execution.exitCode,
        output: execution.output,
        errorCode: execution.errorCode,
        errorMessage: execution.errorMessage,
      }
      json(res, 200, { ack, result })
    } catch (error) {
      const result: CommandResultEnvelope = {
        type: OpencodeDirectMessageType.Result,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: payload.requestId,
        commandId: payload.commandId,
        sessionId: payload.sessionId,
        success: false,
        finishedAt: Date.now(),
        errorCode: ResultErrorCode.Internal,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
      json(res, 500, { ack, result })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === "string") {
    server.close()
    throw new Error("Failed to bind direct channel server")
  }

  return {
    endpoint: `http://${host}:${addr.port}/pigeon/direct/execute`,
    authToken,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    }),
  }
}

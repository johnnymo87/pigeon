/**
 * HTTP client for the worker's remote launch relay routes (pigeon-k0qn.17).
 * Wire shapes match packages/worker/src/remote-launch.ts.
 *
 * Never throws. Every call is bounded with a 10s timeout.
 */

export const REMOTE_LAUNCH_REQUEST_TIMEOUT_MS = 10_000;

export const KNOWN_REFUSED_CODES = new Set([
  "invalid",
  "launch_id_conflict",
  "expired",
  "sender_not_yours",
  "same_machine",
  "receiver_not_retired",
  "not_accepted",
  "target_offline",
  "no_return_path",
  "queue_full",
  "rate_limited",
  "launch_unavailable",
  "machine_mismatch",
]);

export interface RemoteLaunchRequestBody {
  launch_id: string;
  from: string;
  machine: string;
  directory: string;
  prompt: string;
  tag: string | null;
  expires_at?: number;
}

export type RemoteLaunchAckItem =
  | {
      kind: "launch";
      from_machine: string;
      launch_id: string;
      outcome: "launched" | "refused" | "unconfirmed";
      session_id?: string;
      reason?: string;
    }
  | {
      kind: "result";
      from_machine: string;
      result_id: string;
      outcome: "delivered" | "refused";
      reason?: string;
    };

export type RemoteLaunchRequestAnswer =
  | { kind: "accepted"; toMachine: string | null; duplicate: boolean }
  | { kind: "refused"; code: string; detail: string; status: number }
  | { kind: "transient"; detail: string };

export interface RemoteLaunchClientConfig {
  workerUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface ParsedRemoteLaunchResponse {
  error?: unknown;
  detail?: unknown;
  duplicate?: unknown;
  to_machine?: unknown;
}

export class RemoteLaunchClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: RemoteLaunchClientConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? REMOTE_LAUNCH_REQUEST_TIMEOUT_MS;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.config.workerUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /launch/relay`. Never throws. */
  async request(body: RemoteLaunchRequestBody): Promise<RemoteLaunchRequestAnswer> {
    let response: Response;
    try {
      response = await this.post("/launch/relay", body);
    } catch (err) {
      return {
        kind: "transient",
        detail: `launch relay request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let parsed: ParsedRemoteLaunchResponse = {};
    try {
      parsed = (await response.json()) as ParsedRemoteLaunchResponse;
    } catch {
      // Body-less or non-JSON answer
    }

    if (response.status === 202 || (response.ok && response.status !== 204)) {
      return {
        kind: "accepted",
        toMachine: typeof parsed.to_machine === "string" ? parsed.to_machine : null,
        duplicate: parsed.duplicate === true,
      };
    }

    const code = typeof parsed.error === "string" ? parsed.error : "";
    const detail =
      typeof parsed.detail === "string"
        ? parsed.detail
        : code ||
          (response.status === 404
            ? "worker does not support remote launch routes"
            : `status ${response.status}`);

    if (KNOWN_REFUSED_CODES.has(code)) {
      return { kind: "refused", code, detail, status: response.status };
    }

    if (response.status === 401) {
      return {
        kind: "refused",
        code: "unauthorized",
        detail: detail || "unauthorized",
        status: 401,
      };
    }

    if (response.status === 404) {
      return {
        kind: "refused",
        code: "worker_too_old",
        detail: detail || "worker does not support remote launch routes",
        status: 404,
      };
    }

    return {
      kind: "transient",
      detail: `worker answered ${response.status}${code ? ` ${code}` : ""}: ${detail}`,
    };
  }

  /** `POST /launch/relay/ack`. True on 2xx with ok: true. Never throws. */
  async ack(items: RemoteLaunchAckItem[]): Promise<boolean> {
    if (items.length === 0) return true;
    try {
      const response = await this.post("/launch/relay/ack", { items });
      if (!response.ok) {
        console.warn(`[remote-launch] ack answered ${response.status}`);
        return false;
      }
      const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      return body?.ok === true;
    } catch (err) {
      console.warn(`[remote-launch] ack failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

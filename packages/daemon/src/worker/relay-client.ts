/**
 * HTTP client for the worker's cross-machine relay routes (pigeon-k0qn.6/.7). Wire shapes are
 * the worker's (`packages/worker/src/relay.ts`), which is the source of truth.
 *
 * Every call is bounded: the receive side runs inside the poller's serialised tick, so a hung
 * request would stop polling, and after 60s every sender would be told this machine is offline.
 */

/** The poll request header. Byte-exact with the worker's `SWARM_RELAY_HEADER`. */
export const SWARM_RELAY_HEADER = "X-Pigeon-Swarm-Relay";

export const RELAY_REQUEST_TIMEOUT_MS = 10_000;

/** The body of `POST /swarm/relay`. `deliver_at` and `ref` are required even when null. */
export interface RelayMessageBody {
  msg_id: string;
  from: string;
  to: string;
  kind: string;
  priority: string;
  reply_to: string | null;
  payload: string;
  deliver_at: number | null;
  expires_at: number | null;
  ref: string | null;
  from_label: string | null;
}

/** One entry of a poll response's `swarm` array. */
export type RelayHandOutItem =
  | ({ item: "message"; from_machine: string; relay_expires_at?: number } & RelayMessageBody)
  | {
      item: "failure";
      from_machine: string;
      msg_id: string;
      original_msg_id: string;
      from: string;
      to: string;
      reason: string;
      machine: string;
    };

export interface RelayAckItem {
  from_machine: string;
  msg_id: string;
  outcome: "delivered" | "refused";
  reason?: string;
}

/**
 * The sender's classification of a `/swarm/relay` answer (design §3.1 table).
 *  - `accepted`: stored for the owner (a `duplicate` is an earlier identical attempt).
 *  - `permanent`: will fail identically on retry; `code` is the worker's error code.
 *  - `transient`: retry under the arbiter's normal rules.
 */
export type RelaySendAnswer =
  | { kind: "accepted"; toMachine: string | null; duplicate: boolean }
  | { kind: "permanent"; code: string; detail: string; status: number }
  | { kind: "transient"; detail: string };

const PERMANENT_CODES = new Set([
  "unknown_session",
  "same_machine",
  "receiver_not_retired",
  "sender_not_yours",
  "expired",
  "not_accepted",
  "msg_id_conflict",
  "invalid",
]);

export interface RelayClientConfig {
  workerUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class RelayClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: RelayClientConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.fetchFn(`${this.config.workerUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** `POST /swarm/relay`. Never throws. */
  async relay(body: RelayMessageBody): Promise<RelaySendAnswer> {
    let response: Response;
    try {
      response = await this.post("/swarm/relay", body);
    } catch (err) {
      return { kind: "transient", detail: `relay request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    let parsed: { error?: unknown; detail?: unknown; duplicate?: unknown; to_machine?: unknown } = {};
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      // Body-less or non-JSON answer: classified on status alone below.
    }
    if (response.status === 202 || (response.ok && response.status !== 204)) {
      return {
        kind: "accepted",
        toMachine: typeof parsed.to_machine === "string" ? parsed.to_machine : null,
        duplicate: parsed.duplicate === true,
      };
    }
    const code = typeof parsed.error === "string" ? parsed.error : "";
    const detail = typeof parsed.detail === "string" ? parsed.detail : code || `status ${response.status}`;
    // By code, never by status alone: 403 and 409 each carry both kinds of answer, and an
    // unrecognised code from a newer worker is safer retried (bounded by the budget) than
    // turned into a permanent "do not resend".
    if (PERMANENT_CODES.has(code)) return { kind: "permanent", code, detail, status: response.status };
    return { kind: "transient", detail: `worker answered ${response.status}${code ? ` ${code}` : ""}: ${detail}` };
  }

  /** `POST /swarm/relay/ack`. True when the worker took it. Never throws. */
  async ack(items: RelayAckItem[]): Promise<boolean> {
    if (items.length === 0) return true;
    try {
      const response = await this.post("/swarm/relay/ack", { items });
      if (!response.ok) console.warn(`[relay] ack answered ${response.status}`);
      return response.ok;
    } catch (err) {
      console.warn(`[relay] ack failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * `POST /swarm/relay/fail`. `sent` when the worker took it (including its no-op for a row it no
   * longer has), `final` for an answer retrying cannot change, `retry` otherwise. Never throws.
   */
  async fail(input: { from_machine: string; msg_id: string; reason: string }): Promise<"sent" | "noop" | "final" | "retry"> {
    try {
      const response = await this.post("/swarm/relay/fail", input);
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { noop?: unknown };
        return body.noop === true ? "noop" : "sent";
      }
      if (response.status === 400 || response.status === 403) return "final";
      return "retry";
    } catch {
      return "retry";
    }
  }
}

/**
 * The poll header value, or null to send none. `failures=1` is sent whenever this daemon has a
 * machine identity, not only while sending is enabled: failure items live 24h at the worker, so
 * turning sending off must not strand the ones already owed to this machine. It is inert until
 * this machine has relayed something.
 */
export function relayPollHeader(acceptFrom: readonly string[], failures: boolean): string | null {
  if (acceptFrom.length === 0 && !failures) return null;
  return `accept=${acceptFrom.join(",")}${failures ? "; failures=1" : ""}`;
}

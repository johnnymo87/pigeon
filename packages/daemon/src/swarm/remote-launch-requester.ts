/**
 * Requesting side of remote launches (pigeon-k0qn.17).
 *
 * An agent on machine A asks machine B to start a fresh opencode session.
 * A's daemon handles `POST /swarm/launch`, relays the request to the worker,
 * retries transient failures in `tick()`, enforces deadlines, and processes
 * `launch_result` poll items into local `launch.result` swarm messages.
 */

import type { StorageDb } from "../storage/database";
import { REMOTE_LAUNCH_REQUEST_TTL_MS } from "../storage/remote-launch-repo";
import type {
  RemoteLaunchClient,
  RemoteLaunchRequestBody,
  RemoteLaunchRequestAnswer,
} from "../worker/remote-launch-client";
import { isValidTag } from "../worker/tag-ingest";
import { makeMsgId } from "../ids";
import { bankOrInsertSwarmMessage } from "./bank-or-insert";

export const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LAUNCH_ID_RE = /^[^:\s]{1,128}$/;
export const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{8,128}$/;
export const REASON_RE = /^[a-z0-9_]{1,64}$/;
export const LAUNCH_MAX_DIRECTORY = 512;
export const LAUNCH_MAX_PROMPT = 16_000;

export interface LaunchResultAck {
  kind: "result";
  from_machine: string;
  result_id: string;
  outcome: "delivered" | "refused";
  reason?: string;
}

export interface FormatLaunchResultInput {
  launchId: string;
  machine: string;
  directory: string;
  outcome: "launched" | "refused" | "unconfirmed";
  sessionId: string | null;
  reason: string | null;
}

export function formatLaunchResult(input: FormatLaunchResultInput): string {
  if (input.outcome === "launched") {
    return `REMOTE LAUNCH STARTED: launch ${input.launchId} started session ${input.sessionId} on ${input.machine} in ${input.directory}. Message it with swarm_send to ${input.sessionId}.`;
  }
  if (input.outcome === "refused") {
    if (input.reason === "never_collected") {
      return `REMOTE LAUNCH NOT STARTED: launch ${input.launchId} was never collected by ${input.machine} and did NOT start. Safe to retry.`;
    }
    return `REMOTE LAUNCH REFUSED: launch ${input.launchId} did NOT start on ${input.machine} (${input.reason ?? "unknown"}). Safe to retry.`;
  }
  // unconfirmed
  if (input.sessionId) {
    return `REMOTE LAUNCH UNCONFIRMED: launch ${input.launchId} created session ${input.sessionId} on ${input.machine}, but its prompt may not have arrived. swarm_send it the task if it does not report in. Do NOT launch again.`;
  }
  return `REMOTE LAUNCH UNCONFIRMED: launch ${input.launchId} may or may not have started on ${input.machine}. Check swarm_list remote: true before retrying.`;
}

export interface RemoteLaunchRequesterDeps {
  storage: StorageDb;
  client: Pick<RemoteLaunchClient, "request" | "ack">;
  sendEnabled: boolean;
  selfMachineId: string;
  resolveRequesterTag?: (sessionId: string) => Promise<string | null>;
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class RemoteLaunchRequester {
  private readonly storage: StorageDb;
  private readonly client: Pick<RemoteLaunchClient, "request" | "ack">;
  private readonly sendEnabled: boolean;
  private readonly selfMachineId: string;
  private readonly resolveRequesterTag?: (sessionId: string) => Promise<string | null>;
  private readonly nowFn: () => number;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  private ticking = false;

  constructor(deps: RemoteLaunchRequesterDeps) {
    this.storage = deps.storage;
    this.client = deps.client;
    this.sendEnabled = deps.sendEnabled;
    this.selfMachineId = deps.selfMachineId;
    this.resolveRequesterTag = deps.resolveRequesterTag;
    this.nowFn = deps.nowFn ?? Date.now;
    this.log = deps.log ?? ((msg, fields) => console.log(`[remote-launch] ${msg}`, fields ?? ""));
  }

  async handleRequest(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.sendEnabled) {
      return { status: 403, body: { error: "launch_send_disabled" } };
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: "invalid", detail: "request body must be an object" } };
    }

    const b = body as Record<string, unknown>;
    const { launch_id, from, machine, directory, prompt, tag: bodyTag } = b;

    if (typeof launch_id !== "string" || !LAUNCH_ID_RE.test(launch_id)) {
      return {
        status: 400,
        body: { error: "invalid", detail: "launch_id must be 1-128 characters with no ':' or whitespace" },
      };
    }

    if (typeof from !== "string" || !SESSION_ID_RE.test(from)) {
      return {
        status: 400,
        body: { error: "invalid", detail: "from must be a ses_ session id" },
      };
    }

    if (typeof machine !== "string" || !MACHINE_ID_RE.test(machine)) {
      return {
        status: 400,
        body: { error: "invalid", detail: "machine must be a valid machine id" },
      };
    }

    if (
      typeof directory !== "string" ||
      directory.length === 0 ||
      directory.length > LAUNCH_MAX_DIRECTORY ||
      /[\x00-\x1f\x7f]/.test(directory)
    ) {
      return {
        status: 400,
        body: { error: "invalid", detail: "directory must be 1-512 characters with no control characters" },
      };
    }

    if (
      typeof prompt !== "string" ||
      [...prompt].length === 0 ||
      [...prompt].length > LAUNCH_MAX_PROMPT
    ) {
      return {
        status: 400,
        body: { error: "invalid", detail: "prompt must be 1-16000 code points" },
      };
    }

    if (bodyTag !== undefined && bodyTag !== null && (typeof bodyTag !== "string" || !isValidTag(bodyTag))) {
      return {
        status: 400,
        body: { error: "invalid", detail: "tag must be null or a valid tag" },
      };
    }

    // Existing outbound row check
    const existing = this.storage.remoteLaunch.outbound.get(launch_id);
    if (existing) {
      if (existing.fromSession !== from || existing.toMachine !== machine) {
        return { status: 409, body: { error: "launch_id_conflict" } };
      }
      if (existing.state === "accepted" || existing.state === "resolved" || existing.state === "deadline") {
        return {
          status: 202,
          body: {
            launch_id: existing.launchId,
            status: "accepted",
            to_machine: existing.toMachine,
          },
        };
      }
      if (existing.state === "sending") {
        return {
          status: 202,
          body: {
            launch_id: existing.launchId,
            status: "pending",
          },
        };
      }
      if (existing.state === "refused") {
        return {
          status: existing.refusalStatus ?? 400,
          body: {
            error: existing.refusalCode ?? "refused",
            detail: existing.refusalDetail ?? "",
          },
        };
      }
    }

    // Tag resolution: explicit key present (even if null) overrides; undefined triggers inheritance
    let tag: string | null = null;
    if ("tag" in b && bodyTag !== undefined) {
      tag = bodyTag === null ? null : (bodyTag as string);
    } else {
      if (this.resolveRequesterTag) {
        try {
          const inherited = await this.resolveRequesterTag(from);
          tag = inherited && isValidTag(inherited) ? inherited : null;
        } catch {
          tag = null;
        }
      }
    }

    const now = this.nowFn();
    const expiresAt = now + REMOTE_LAUNCH_REQUEST_TTL_MS;
    const requestBody: RemoteLaunchRequestBody = {
      launch_id,
      from,
      machine,
      directory,
      prompt,
      tag,
      expires_at: expiresAt,
    };
    const requestJson = JSON.stringify(requestBody);

    const inserted = this.storage.remoteLaunch.outbound.insert({
      launchId: launch_id,
      fromSession: from,
      toMachine: machine,
      directory,
      requestJson,
      createdAt: now,
    });

    if (!inserted) {
      // Race: another call inserted the row
      const raced = this.storage.remoteLaunch.outbound.get(launch_id);
      if (raced) {
        if (raced.fromSession !== from || raced.toMachine !== machine) {
          return { status: 409, body: { error: "launch_id_conflict" } };
        }
        if (raced.state === "accepted" || raced.state === "resolved" || raced.state === "deadline") {
          return {
            status: 202,
            body: {
              launch_id: raced.launchId,
              status: "accepted",
              to_machine: raced.toMachine,
            },
          };
        }
        if (raced.state === "sending") {
          return {
            status: 202,
            body: {
              launch_id: raced.launchId,
              status: "pending",
            },
          };
        }
        if (raced.state === "refused") {
          return {
            status: raced.refusalStatus ?? 400,
            body: {
              error: raced.refusalCode ?? "refused",
              detail: raced.refusalDetail ?? "",
            },
          };
        }
      }
    }

    let res: RemoteLaunchRequestAnswer;
    try {
      res = await this.client.request(requestBody);
    } catch (err) {
      res = { kind: "transient", detail: `request threw: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (res.kind === "accepted") {
      this.storage.remoteLaunch.outbound.markAccepted(launch_id);
      return {
        status: 202,
        body: {
          launch_id,
          status: "accepted",
          to_machine: res.toMachine ?? machine,
        },
      };
    }

    if (res.kind === "refused") {
      this.storage.remoteLaunch.outbound.markRefused(launch_id, res.code, res.status, res.detail, now);
      return {
        status: res.status,
        body: {
          error: res.code,
          detail: res.detail,
        },
      };
    }

    // transient
    this.storage.remoteLaunch.outbound.markRetry(launch_id, now + 5000);
    return {
      status: 202,
      body: {
        launch_id,
        status: "pending",
      },
    };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.nowFn();

      // 1. Send retries
      const sendDue = this.storage.remoteLaunch.outbound.listSendDue(now);
      for (const row of sendDue) {
        if (now >= row.requestExpiresAt) continue;
        try {
          let requestBody: RemoteLaunchRequestBody;
          try {
            requestBody = JSON.parse(row.requestJson) as RemoteLaunchRequestBody;
          } catch {
            this.log("corrupt requestJson in outbound row", { launchId: row.launchId });
            continue;
          }

          let res: RemoteLaunchRequestAnswer;
          try {
            res = await this.client.request(requestBody);
          } catch (err) {
            res = { kind: "transient", detail: `request threw: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (res.kind === "accepted") {
            this.storage.remoteLaunch.outbound.markAccepted(row.launchId);
          } else if (res.kind === "refused") {
            const nowRefused = this.nowFn();
            this.storage.db.transaction(() => {
              const marked = this.storage.remoteLaunch.outbound.markRefused(
                row.launchId,
                res.code,
                res.status,
                res.detail,
                nowRefused,
              );
              if (marked) {
                const payload = formatLaunchResult({
                  launchId: row.launchId,
                  machine: row.toMachine,
                  directory: row.directory,
                  outcome: "refused",
                  sessionId: null,
                  reason: res.code,
                });
                bankOrInsertSwarmMessage(
                  this.storage,
                  {
                    msgId: makeMsgId(),
                    fromSession: "pigeon",
                    toSession: row.fromSession,
                    channel: null,
                    kind: "launch.result",
                    priority: "normal",
                    replyTo: null,
                    payload,
                  },
                  nowRefused,
                );
              }
            })();
          } else {
            // transient backoff (5s doubling, cap 60s)
            const backoff = Math.min(60_000, 5_000 * Math.pow(2, row.attempts));
            this.storage.remoteLaunch.outbound.markRetry(row.launchId, now + backoff);
          }
        } catch (err) {
          this.log("error processing send retry in tick", { launchId: row.launchId, error: String(err) });
        }
      }

      // 2. Deadlines
      const deadlinePassed = this.storage.remoteLaunch.outbound.listDeadlinePassed(now);
      for (const row of deadlinePassed) {
        try {
          const nowDeadline = this.nowFn();
          this.storage.db.transaction(() => {
            const marked = this.storage.remoteLaunch.outbound.markDeadline(row.launchId, nowDeadline);
            if (marked) {
              const payload = formatLaunchResult({
                launchId: row.launchId,
                machine: row.toMachine,
                directory: row.directory,
                outcome: "unconfirmed",
                sessionId: null,
                reason: null,
              });
              bankOrInsertSwarmMessage(
                this.storage,
                {
                  msgId: makeMsgId(),
                  fromSession: "pigeon",
                  toSession: row.fromSession,
                  channel: null,
                  kind: "launch.result",
                  priority: "normal",
                  replyTo: null,
                  payload,
                },
                nowDeadline,
              );
            }
          })();
        } catch (err) {
          this.log("error processing deadline in tick", { launchId: row.launchId, error: String(err) });
        }
      }
    } catch (err) {
      this.log("error in tick", { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  processResults(items: unknown[]): LaunchResultAck[] {
    const acks: LaunchResultAck[] = [];
    if (!Array.isArray(items)) return acks;

    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      if (item.item !== "launch_result") continue;

      const resultId = typeof item.result_id === "string" ? item.result_id : null;
      const fromMachine = typeof item.from_machine === "string" ? item.from_machine : null;

      if (!resultId || !fromMachine) {
        this.log("skipping launch_result with missing/invalid result_id or from_machine", { item });
        continue;
      }

      const launchId = typeof item.launch_id === "string" ? item.launch_id : "";
      const machine = typeof item.machine === "string" ? item.machine : "";
      const outbound = launchId ? this.storage.remoteLaunch.outbound.get(launchId) : null;

      if (fromMachine !== this.selfMachineId || !outbound || outbound.toMachine !== machine) {
        acks.push({
          kind: "result",
          from_machine: fromMachine,
          result_id: resultId,
          outcome: "refused",
          reason: "no_matching_launch",
        });
        continue;
      }

      const now = this.nowFn();
      const recorded = this.storage.remoteLaunch.resultsSeen.record(resultId, launchId, now);
      if (!recorded) {
        acks.push({
          kind: "result",
          from_machine: fromMachine,
          result_id: resultId,
          outcome: "delivered",
        });
        continue;
      }

      const outcome = item.outcome;
      if (outcome !== "launched" && outcome !== "refused" && outcome !== "unconfirmed") {
        this.log("launch_result has unknown outcome", { resultId, outcome });
        acks.push({
          kind: "result",
          from_machine: fromMachine,
          result_id: resultId,
          outcome: "refused",
          reason: "unrecognised",
        });
        continue;
      }

      let sessionId: string | null = null;
      if (typeof item.session_id === "string" && SESSION_ID_RE.test(item.session_id)) {
        sessionId = item.session_id;
      }

      let reason: string | null = null;
      if (typeof item.reason === "string") {
        reason = REASON_RE.test(item.reason) ? item.reason : "unrecognised";
      }

      this.storage.db.transaction(() => {
        const marked = this.storage.remoteLaunch.outbound.markResolved(launchId, outcome, now);
        if (marked) {
          const payload = formatLaunchResult({
            launchId,
            machine: outbound.toMachine,
            directory: outbound.directory,
            outcome,
            sessionId,
            reason,
          });
          bankOrInsertSwarmMessage(
            this.storage,
            {
              msgId: makeMsgId(),
              fromSession: "pigeon",
              toSession: outbound.fromSession,
              channel: null,
              kind: "launch.result",
              priority: "normal",
              replyTo: null,
              payload,
            },
            now,
          );
        }
      })();

      acks.push({
        kind: "result",
        from_machine: fromMachine,
        result_id: resultId,
        outcome: "delivered",
      });
    }

    return acks;
  }
}

/**
 * Receiving side of remote launches (pigeon-k0qn.17).
 *
 * An agent on machine A asks the worker to start a fresh opencode session on machine B.
 * B's daemon gets `launch` items in its poll response and runs them.
 *
 * Wire contract:
 * launch item: `{ item: "launch"; from_machine: string; launch_id: string; from: string; directory: string; prompt: string; tag: string | null; expires_at: number }`
 * Ack item: `{ kind: "launch"; from_machine: string; launch_id: string; outcome: "launched" | "refused" | "unconfirmed"; session_id?: string; reason?: string }`
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { StorageDb } from "../storage/database";
import type { OpencodeClient } from "../opencode-client";
import type { OcTagsRunner } from "../worker/oc-tags";
import {
  expandShorthand,
  resolveHome,
  startSession,
  autoAttach,
  applyTag,
} from "../worker/launch-ingest";
import { isValidTag, truncate } from "../worker/tag-ingest";

export const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LAUNCH_ID_RE = /^[^:\s]{1,128}$/;
export const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{8,128}$/;
export const REASON_RE = /^[a-z0-9_]{1,64}$/;

export interface LaunchAckItem {
  kind: "launch";
  from_machine: string;
  launch_id: string;
  outcome: "launched" | "refused" | "unconfirmed";
  session_id?: string;
  reason?: string;
}

export interface LaunchReceiverDeps {
  storage: StorageDb;
  selfMachineId: string;
  launchFrom: readonly string[];          // config.remoteLaunchFrom
  relaySendEnabled: boolean;              // config.swarmRelaySend (design §9.3)
  opencodeClient?: OpencodeClient;
  resolveOwnerClient?: (id: string) => OpencodeClient | undefined;
  ack: (items: LaunchAckItem[]) => Promise<boolean>;
  runOcTags?: () => OcTagsRunner | null;  // resolved per launch
  onTagged?: (sessionId: string) => void;
  spawn?: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: {
      stdio?: "ignore" | "inherit" | "pipe" | Array<"ignore" | "inherit" | "pipe" | number>;
      detached?: boolean;
    },
  ) => ChildProcess;                      // for autoAttach, test seam
  statDirectory?: (path: string) => boolean;  // test seam; default fs.statSync(...).isDirectory()
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

function defaultStatDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isValidLaunchAckItem(item: LaunchAckItem): boolean {
  if (item.kind !== "launch") return false;
  if (!MACHINE_ID_RE.test(item.from_machine)) return false;
  if (!LAUNCH_ID_RE.test(item.launch_id)) return false;
  if (item.outcome === "launched") {
    if (!item.session_id || !SESSION_ID_RE.test(item.session_id)) return false;
    if (item.reason !== undefined) return false;
    return true;
  }
  if (item.outcome === "refused") {
    if (!item.reason || !REASON_RE.test(item.reason)) return false;
    if (item.session_id !== undefined) return false;
    return true;
  }
  if (item.outcome === "unconfirmed") {
    if (item.session_id !== undefined && !SESSION_ID_RE.test(item.session_id)) return false;
    if (item.reason !== undefined) return false;
    return true;
  }
  return false;
}

async function sendAck(
  deps: LaunchReceiverDeps,
  item: LaunchAckItem,
  now: number,
): Promise<boolean> {
  const log = deps.log ?? ((msg, fields) => console.log(`[remote-launch] ${msg}`, fields ?? ""));
  if (!isValidLaunchAckItem(item)) {
    log("ack item failed wire validation, marking done", { item });
    deps.storage.remoteLaunch.inbound.markAckDone(item.from_machine, item.launch_id, now);
    return true;
  }

  let ok = false;
  try {
    ok = await deps.ack([item]);
  } catch (err) {
    log("ack call threw", { err: String(err) });
  }

  if (ok) {
    deps.storage.remoteLaunch.inbound.markAckDone(item.from_machine, item.launch_id, now);
    return true;
  } else {
    const row = deps.storage.remoteLaunch.inbound.get(item.from_machine, item.launch_id);
    const attempts = row?.ackAttempts ?? 0;
    const backoff = Math.min(300_000, 5_000 * Math.pow(2, attempts));
    deps.storage.remoteLaunch.inbound.markAckRetry(item.from_machine, item.launch_id, now + backoff, now);
    return false;
  }
}

async function recordRefusalAndAck(
  deps: LaunchReceiverDeps,
  fromMachine: string,
  launchId: string,
  fromSession: string,
  reason: string,
  now: number,
): Promise<void> {
  deps.storage.remoteLaunch.inbound.insertReceived({ fromMachine, launchId, fromSession }, now);
  deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "refused", null, reason, now);
  await sendAck(
    deps,
    {
      kind: "launch",
      from_machine: fromMachine,
      launch_id: launchId,
      outcome: "refused",
      reason,
    },
    now,
  );
}

function runStep10(
  deps: LaunchReceiverDeps,
  fromMachine: string,
  launchId: string,
  from: string,
  sid: string,
  dir: string,
  prompt: string,
  tag: string | null | undefined,
  unconfirmed: boolean,
): void {
  void (async () => {
    try {
      autoAttach(sid, deps.spawn);
    } catch (err) {
      deps.log?.("autoAttach threw in background", { err: String(err) });
    }

    try {
      const suffix = unconfirmed ? " (prompt may not have arrived)" : "";
      const text = `🚀 Remote launch from ${fromMachine} (${from}): session ${sid} in ${dir}${suffix}\n${truncate(prompt, 300)}`;
      deps.storage.alerts.enqueue({
        source: "remote-launch",
        refMsgId: `rl:${fromMachine}:${launchId}`,
        severity: "info",
        text,
        now: (deps.nowFn ?? Date.now)(),
      });
    } catch (err) {
      deps.log?.("alerts.enqueue threw in background", { err: String(err) });
    }

    if (tag) {
      try {
        const runner = deps.runOcTags ? deps.runOcTags() : null;
        await applyTag(tag, sid, runner, "", deps.onTagged);
      } catch (err) {
        deps.log?.("applyTag threw in background", { err: String(err) });
      }
    }
  })().catch((err) => {
    deps.log?.("background launch side effects failed", { err: String(err) });
  });
}

async function processOneLaunchItem(deps: LaunchReceiverDeps, raw: unknown): Promise<void> {
  const log = deps.log ?? ((msg, fields) => console.log(`[remote-launch] ${msg}`, fields ?? ""));
  if (typeof raw !== "object" || raw === null) return;
  const it = raw as Record<string, unknown>;
  if (it.item !== "launch") return;

  const now = (deps.nowFn ?? Date.now)();

  // 1. Missing/invalid from_machine or launch_id -> log and skip (nothing to ack by).
  if (
    typeof it.from_machine !== "string" ||
    !MACHINE_ID_RE.test(it.from_machine) ||
    typeof it.launch_id !== "string" ||
    !LAUNCH_ID_RE.test(it.launch_id)
  ) {
    log("missing or invalid from_machine or launch_id, skipping", {
      from_machine: it.from_machine,
      launch_id: it.launch_id,
    });
    return;
  }

  const fromMachine = it.from_machine;
  const launchId = it.launch_id;
  const fromSession = typeof it.from === "string" ? it.from : "";

  // 2. Shape invalid (from not ses_, directory/prompt not strings, tag invalid, expires_at not number) -> refused invalid.
  const isFromValid = typeof it.from === "string" && SESSION_ID_RE.test(it.from);
  const isDirValid = typeof it.directory === "string";
  const isPromptValid = typeof it.prompt === "string";
  const isTagValid =
    it.tag === undefined ||
    it.tag === null ||
    (typeof it.tag === "string" && isValidTag(it.tag));
  const isExpiresAtValid = typeof it.expires_at === "number" && Number.isFinite(it.expires_at);

  if (!isFromValid || !isDirValid || !isPromptValid || !isTagValid || !isExpiresAtValid) {
    log("launch item shape invalid", { fromMachine, launchId });
    await recordRefusalAndAck(deps, fromMachine, launchId, fromSession, "invalid", now);
    return;
  }

  // 3. Existing inbound row -> no launch; ack per state: settled -> its outcome/session/reason;
  //    created -> unconfirmed + session id; received -> unconfirmed, no id.
  const existing = deps.storage.remoteLaunch.inbound.get(fromMachine, launchId);
  if (existing) {
    log("existing inbound row found, re-acking per state", {
      fromMachine,
      launchId,
      state: existing.state,
    });
    let ackItem: LaunchAckItem;
    if (existing.state === "settled") {
      ackItem = {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: existing.outcome!,
        ...(existing.sessionId ? { session_id: existing.sessionId } : {}),
        ...(existing.reason ? { reason: existing.reason } : {}),
      };
    } else if (existing.state === "created") {
      deps.storage.remoteLaunch.inbound.settle(
        fromMachine,
        launchId,
        "unconfirmed",
        existing.sessionId,
        null,
        now,
      );
      ackItem = {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "unconfirmed",
        session_id: existing.sessionId!,
      };
    } else {
      // state === "received"
      deps.storage.remoteLaunch.inbound.settle(
        fromMachine,
        launchId,
        "unconfirmed",
        null,
        null,
        now,
      );
      ackItem = {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "unconfirmed",
      };
    }
    await sendAck(deps, ackItem, now);
    return;
  }

  // 4. from_machine not in launchFrom or = self -> refused not_accepted.
  if (!deps.launchFrom.includes(fromMachine) || fromMachine === deps.selfMachineId) {
    log("from_machine not accepted", { fromMachine, self: deps.selfMachineId });
    await recordRefusalAndAck(deps, fromMachine, launchId, fromSession, "not_accepted", now);
    return;
  }

  // 5. !relaySendEnabled -> refused no_return_path.
  if (!deps.relaySendEnabled) {
    log("relaySendEnabled is false, refusing no_return_path", { fromMachine, launchId });
    await recordRefusalAndAck(deps, fromMachine, launchId, fromSession, "no_return_path", now);
    return;
  }

  // 6. no opencodeClient -> refused serve_unavailable.
  if (!deps.opencodeClient) {
    log("opencodeClient not provided, refusing serve_unavailable", { fromMachine, launchId });
    await recordRefusalAndAck(deps, fromMachine, launchId, fromSession, "serve_unavailable", now);
    return;
  }

  // Order review fix: expires_at <= now checked AFTER step 6 so non-allowlisted machines get not_accepted
  if ((it.expires_at as number) <= now) {
    log("launch item already expired", { fromMachine, launchId, expires_at: it.expires_at, now });
    await recordRefusalAndAck(deps, fromMachine, launchId, fromSession, "expired", now);
    return;
  }

  // 7. insertReceived. Directory: resolveHome(expandShorthand(dir)); not absolute or not a directory ->
  //    settle refused no_such_directory; contains a character above U+00FF -> refused invalid_directory.
  deps.storage.remoteLaunch.inbound.insertReceived({ fromMachine, launchId, fromSession }, now);

  const rawDir = it.directory as string;
  const prompt = it.prompt as string;
  const from = it.from as string;
  const tag = (it.tag as string | null | undefined) ?? null;

  const resolvedDir = resolveHome(expandShorthand(rawDir));

  let hasHighChar = false;
  for (let i = 0; i < resolvedDir.length; i++) {
    if (resolvedDir.charCodeAt(i) > 0xff) {
      hasHighChar = true;
      break;
    }
  }
  if (hasHighChar) {
    log("resolved directory contains character above U+00FF", { resolvedDir });
    deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "refused", null, "invalid_directory", now);
    await sendAck(
      deps,
      {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "refused",
        reason: "invalid_directory",
      },
      now,
    );
    return;
  }

  const statFn = deps.statDirectory ?? defaultStatDirectory;
  if (!isAbsolute(resolvedDir) || !statFn(resolvedDir)) {
    log("directory is not absolute or not a directory", { resolvedDir });
    deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "refused", null, "no_such_directory", now);
    await sendAck(
      deps,
      {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "refused",
        reason: "no_such_directory",
      },
      now,
    );
    return;
  }

  // 8. startSession
  const framedPrompt = `[Remote launch requested by ${from} on ${fromMachine}; report back with swarm_send to ${from}.]\n\n${prompt}`;

  const outcome = await startSession({
    directory: resolvedDir,
    prompt: framedPrompt,
    opencodeClient: deps.opencodeClient,
    resolveOwnerClient: deps.resolveOwnerClient,
    budgets: { healthMs: 5000, createMs: 15000, promptMs: 20000 },
    onCreated: (sessionId: string) => {
      deps.storage.remoteLaunch.inbound.markCreated(fromMachine, launchId, sessionId, (deps.nowFn ?? Date.now)());
    },
  });

  // Re-sample clock after startSession returns (review fix 1)
  const postStartNow = (deps.nowFn ?? Date.now)();

  // 9. settle and ack
  if (outcome.outcome === "launched") {
    deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "launched", outcome.sessionId, null, postStartNow);
    await sendAck(
      deps,
      {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "launched",
        session_id: outcome.sessionId,
      },
      postStartNow,
    );
    runStep10(deps, fromMachine, launchId, from, outcome.sessionId, resolvedDir, prompt, tag, false);
  } else if (outcome.outcome === "refused") {
    deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "refused", null, outcome.reason, postStartNow);
    await sendAck(
      deps,
      {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "refused",
        reason: outcome.reason,
      },
      postStartNow,
    );
  } else {
    // outcome.outcome === "unconfirmed"
    deps.storage.remoteLaunch.inbound.settle(fromMachine, launchId, "unconfirmed", outcome.sessionId, null, postStartNow);
    await sendAck(
      deps,
      {
        kind: "launch",
        from_machine: fromMachine,
        launch_id: launchId,
        outcome: "unconfirmed",
        ...(outcome.sessionId ? { session_id: outcome.sessionId } : {}),
      },
      postStartNow,
    );
    if (outcome.sessionId) {
      runStep10(deps, fromMachine, launchId, from, outcome.sessionId, resolvedDir, prompt, tag, true);
    }
  }
}

export async function processLaunchItems(
  deps: LaunchReceiverDeps,
  items: unknown[],
): Promise<void> {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    try {
      await processOneLaunchItem(deps, raw);
    } catch (err) {
      deps.log?.("unexpected error processing launch item", { err: String(err) });
    }
  }
}

export async function retryLaunchAcks(deps: LaunchReceiverDeps): Promise<void> {
  try {
    const now = (deps.nowFn ?? Date.now)();
    const due = deps.storage.remoteLaunch.inbound.listAcksDue(now, 20);
    for (const row of due) {
      try {
        if (!row.outcome) {
          deps.storage.remoteLaunch.inbound.markAckDone(row.fromMachine, row.launchId, now);
          continue;
        }
        const ackItem: LaunchAckItem = {
          kind: "launch",
          from_machine: row.fromMachine,
          launch_id: row.launchId,
          outcome: row.outcome,
          ...(row.sessionId ? { session_id: row.sessionId } : {}),
          ...(row.reason ? { reason: row.reason } : {}),
        };
        const ok = await sendAck(deps, ackItem, now);
        if (!ok) {
          break;
        }
      } catch (err) {
        deps.log?.("retryLaunchAcks failed for row", { row, err: String(err) });
        break;
      }
    }
  } catch (err) {
    deps.log?.("retryLaunchAcks top-level error", { err: String(err) });
  }
}

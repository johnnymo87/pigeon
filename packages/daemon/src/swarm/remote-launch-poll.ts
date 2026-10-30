/**
 * Shared launch item handler for the poller's `onLaunchItems` callback.
 * Used by both `index.ts` and `swarm-launch-e2e.test.ts`.
 *
 * Dispatches:
 * 1. `launch_result` items -> `requester.processResults` -> ack one item per request
 * 2. `launch` items -> `processLaunchItems`
 * 3. pending acks retry -> `retryLaunchAcks`
 *
 * Each step is wrapped so a failure in one does not prevent the others.
 */

import type { RemoteLaunchRequester } from "./remote-launch-requester";
import type { RemoteLaunchClient } from "../worker/remote-launch-client";
import {
  processLaunchItems,
  retryLaunchAcks,
  type LaunchReceiverDeps,
} from "./remote-launch-receiver";

export interface LaunchWorkLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLaunchWorkLock(): LaunchWorkLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const prev = tail;
      let resolveTail: () => void;
      tail = new Promise<void>((r) => {
        resolveTail = r;
      });
      try {
        await prev;
      } catch {
        // Continue queue even if previous task rejected
      }
      try {
        return await fn();
      } finally {
        resolveTail!();
      }
    },
  };
}

const defaultLock = createLaunchWorkLock();

export interface HandleLaunchItemsDeps {
  requester?: RemoteLaunchRequester;
  client: Pick<RemoteLaunchClient, "ack">;
  receiverDeps: LaunchReceiverDeps;
  lock?: LaunchWorkLock;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface RunAckRetriesDeps {
  receiverDeps: LaunchReceiverDeps;
  lock?: LaunchWorkLock;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function runAckRetries(deps: RunAckRetriesDeps): Promise<void> {
  const log = deps.log ?? ((msg, fields) => console.log(`[remote-launch] ${msg}`, fields ?? ""));
  const lock = deps.lock ?? defaultLock;
  await lock.run(async () => {
    try {
      await retryLaunchAcks(deps.receiverDeps);
    } catch (err) {
      log("failed to retry launch acks", { err: String(err) });
    }
  });
}

export async function handleLaunchItems(
  deps: HandleLaunchItemsDeps,
  items: unknown[],
): Promise<void> {
  const log = deps.log ?? ((msg, fields) => console.log(`[remote-launch] ${msg}`, fields ?? ""));

  const launchItems: unknown[] = [];
  const resultItems: unknown[] = [];

  for (const item of items) {
    if (typeof item === "object" && item !== null) {
      const kind = (item as { item?: unknown }).item;
      if (kind === "launch_result") {
        resultItems.push(item);
      } else if (kind === "launch") {
        launchItems.push(item);
      }
    }
  }

  // 1. Process result items (requester side)
  if (deps.requester && resultItems.length > 0) {
    try {
      const acks = deps.requester.processResults(resultItems);
      // Ack one item per request: the worker 400s an entire batch if any single item is invalid.
      for (const ack of acks) {
        try {
          await deps.client.ack([ack]);
        } catch (err) {
          log("failed to ack launch_result item", { err: String(err), ack });
        }
      }
    } catch (err) {
      log("failed to process launch_result items", { err: String(err) });
    }
  }

  // 2. Process launch items (receiver side) & 3. Retry pending launch acks
  const lock = deps.lock ?? defaultLock;
  await lock.run(async () => {
    if (launchItems.length > 0) {
      try {
        await processLaunchItems(deps.receiverDeps, launchItems);
      } catch (err) {
        log("failed to process launch items", { err: String(err) });
      }
    }

    try {
      await retryLaunchAcks(deps.receiverDeps);
    } catch (err) {
      log("failed to retry launch acks", { err: String(err) });
    }
  });
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter } from "../src/swarm/arbiter";

describe("swarm routes e2e", () => {
  let storage: StorageDb | null = null;
  let arbiter: SwarmArbiter | null = null;

  afterEach(() => {
    arbiter?.stop();
    if (storage) {
      storage.db.close();
      storage = null;
    }
    arbiter = null;
  });

  it("serializes per-target deliveries even under concurrent ingest", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => Date.now() });

    const inflight: Array<{
      target: string;
      startedAt: number;
      finishedAt?: number;
    }> = [];

    const opencodeClient = {
      sendPrompt: vi.fn(
        async (target: string, _dir: string, _prompt: string) => {
          const rec: { target: string; startedAt: number; finishedAt?: number } = {
            target,
            startedAt: Date.now(),
          };
          inflight.push(rec);
          await new Promise((r) => setTimeout(r, 30));
          rec.finishedAt = Date.now();
        },
      ),
    };

    const registry = {
      resolve: vi.fn(async (sessionId: string) => `/dir/${sessionId}`),
    };

    arbiter = new SwarmArbiter({
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opencodeClient: opencodeClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      log: () => {},
    });

    // Fire 4 sends concurrently to the same target
    const sends = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        app(
          new Request("http://localhost/swarm/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `ses_caller_${i}`,
              to: "ses_target",
              kind: "chat",
              payload: `payload ${i}`,
            }),
          }),
        ),
      ),
    );
    for (const s of sends) expect(s.status).toBe(202);

    // Drive arbiter until all are handed_off (or timeout)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await arbiter.processOnce();
      const ready = storage.swarm.listTargetsWithReady(Date.now());
      if (ready.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(opencodeClient.sendPrompt).toHaveBeenCalledTimes(4);

    // Critical assertion: no two calls to the same target were in flight
    // simultaneously. Sort by startedAt and verify finishedAt[i] <= startedAt[i+1].
    const sorted = [...inflight]
      .filter((r) => r.target === "ses_target")
      .sort((a, b) => a.startedAt - b.startedAt);
    expect(sorted).toHaveLength(4);
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(sorted[i]!.finishedAt).toBeDefined();
      expect(sorted[i]!.finishedAt!).toBeLessThanOrEqual(
        sorted[i + 1]!.startedAt,
      );
    }
  });

  it("delivers in createdAt order regardless of concurrent ingest", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => Date.now() });

    const calls: string[] = [];
    const opencodeClient = {
      sendPrompt: vi.fn(
        async (_target: string, _dir: string, prompt: string) => {
          const m = prompt.match(/payload-(\d+)/);
          if (m) calls.push(m[1]!);
          await new Promise((r) => setTimeout(r, 5));
        },
      ),
    };
    const registry = {
      resolve: vi.fn(async (sessionId: string) => `/dir/${sessionId}`),
    };

    arbiter = new SwarmArbiter({
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opencodeClient: opencodeClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      log: () => {},
    });

    // Send sequentially so createdAt order is deterministic; but use caller msg_ids
    // so they're visible in ingest order.
    for (let i = 1; i <= 5; i++) {
      const res = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: `msg_${i}`,
            from: "ses_caller",
            to: "ses_target",
            kind: "chat",
            payload: `payload-${i}`,
          }),
        }),
      );
      expect(res.status).toBe(202);
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await arbiter.processOnce();
      if (storage.swarm.listTargetsWithReady(Date.now()).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(calls).toEqual(["1", "2", "3", "4", "5"]);
  });
});

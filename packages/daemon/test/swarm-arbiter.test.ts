import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter } from "../src/swarm/arbiter";

interface DeliveryCall {
  sessionId: string;
  directory: string;
  prompt: string;
  startedAt: number;
  finishedAt?: number;
}

function makeFixture() {
  const storage: StorageDb = openStorageDb(":memory:");
  const calls: DeliveryCall[] = [];
  let now = 1_000;
  let inFlightDelay = 0;
  let throwOnce: Error | null = null;

  const opencodeClient = {
    sendPrompt: vi.fn(
      async (sessionId: string, directory: string, prompt: string) => {
        const rec: DeliveryCall = {
          sessionId,
          directory,
          prompt,
          startedAt: Date.now(),
        };
        calls.push(rec);
        if (throwOnce) {
          const e = throwOnce;
          throwOnce = null;
          throw e;
        }
        if (inFlightDelay > 0) {
          await new Promise((r) => setTimeout(r, inFlightDelay));
        }
        rec.finishedAt = Date.now();
      },
    ),
  };

  const registry = {
    resolve: vi.fn(async (sessionId: string) => `/dir/${sessionId}`),
  };

  const arbiter = new SwarmArbiter({
    storage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opencodeClient: opencodeClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry: registry as any,
    nowFn: () => now,
    log: () => {},
  });

  return {
    storage,
    arbiter,
    opencodeClient,
    registry,
    calls,
    setNow(v: number) {
      now = v;
    },
    setInFlightDelay(v: number) {
      inFlightDelay = v;
    },
    setThrowOnce(e: Error) {
      throwOnce = e;
    },
  };
}

describe("SwarmArbiter", () => {
  let fixture: ReturnType<typeof makeFixture> | null = null;

  afterEach(() => {
    fixture?.arbiter.stop();
    fixture?.storage.db.close();
    fixture = null;
  });

  it("delivers a single queued message and marks it handed_off", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hi",
      },
      1_000,
    );

    await arbiter.processOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBe("ses_b");
    expect(calls[0]!.directory).toBe("/dir/ses_b");
    expect(calls[0]!.prompt).toContain("<swarm_message");
    expect(calls[0]!.prompt).toContain("hi");

    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
  });

  it("serializes deliveries per target — never two in flight at once", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    fixture.setInFlightDelay(20);
    for (let i = 1; i <= 4; i++) {
      storage.swarm.insert(
        {
          msgId: `m${i}`,
          fromSession: `ses_caller_${i}`,
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: `payload-${i}`,
        },
        1_000 + i,
      );
    }

    // Run processOnce concurrently 4x; the arbiter must internally serialize
    // per-target so we end up with 4 sequential calls (NOT 4 in flight).
    await Promise.all([
      arbiter.processOnce(),
      arbiter.processOnce(),
      arbiter.processOnce(),
      arbiter.processOnce(),
    ]);

    expect(calls).toHaveLength(4);
    // Verify createdAt order
    expect(calls.map((c) => c.prompt.match(/payload-\d+/)?.[0])).toEqual([
      "payload-1",
      "payload-2",
      "payload-3",
      "payload-4",
    ]);

    // Verify no two were in flight at the same time: for each consecutive pair,
    // the earlier one's finishedAt is <= the later one's startedAt.
    const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(sorted[i]!.finishedAt).toBeDefined();
      expect(sorted[i]!.finishedAt!).toBeLessThanOrEqual(
        sorted[i + 1]!.startedAt,
      );
    }
  });

  it("retries on opencode 5xx with backoff", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hi",
      },
      1_000,
    );

    fixture.setThrowOnce(new Error("sendPrompt failed: 500"));
    await arbiter.processOnce();

    const after = storage.swarm.getByMsgId("m1")!;
    expect(after.state).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.nextRetryAt).not.toBeNull();
  });
});

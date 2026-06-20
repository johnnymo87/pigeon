import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openStorageDb } from "../../src/storage/database.js";

interface OwnershipEvent {
  sessionId: string;
  instanceUuid: string;
  generation: number;
  epoch: number;
  acquiredAt: number;
  expiresAt: number;
  releasedAt?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Hardened Lease CAS Concurrency Proof", () => {
  it("never allows more than 1 live owner for the same (session, generation, epoch) under genuine concurrent contention", async () => {
    // 1. Setup temp dir + db file in WAL mode
    const tempDir = mkdtempSync(join(tmpdir(), "pigeon-concurrency-"));
    const dbPath = join(tempDir, "concurrency.db");

    const mainStorage = openStorageDb(dbPath);
    mainStorage.db.pragma("journal_mode = WAL");

    // Seed: keep routing_meta at epoch 0
    mainStorage.serves.upsert({
      serveId: "serve-A",
      instanceUuid: "instance-main",
      endpoint: "http://localhost:8000",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: Date.now(),
      draining: false,
    });

    // Create 12 sessions each with assignment to serve-A at ownerGeneration 1
    const S = 12;
    const sessionsList: string[] = [];
    for (let i = 1; i <= S; i++) {
      const sessionId = `session-${i}`;
      sessionsList.push(sessionId);
      mainStorage.assignments.upsert({
        sessionId,
        directoryKey: null,
        desiredServeId: "serve-A",
        ownerGeneration: 1,
        state: "assigned",
        lastActiveAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const duration = 2000; // 2 seconds run
    const deadline = Date.now() + duration;

    // 2. Spawn N=6 workers via child_process.fork
    const N = 6;
    const workerPath = join(__dirname, "lease-cas-concurrency.worker.ts");
    const workerPromises = Array.from({ length: N }).map((_, i) => {
      return new Promise<{ events: OwnershipEvent[]; counters: any }>((resolve, reject) => {
        const child = fork(workerPath, [], {
          execArgv: ["--import", "tsx", "--experimental-specifier-resolution=node"],
        });

        child.send({
          type: "setup",
          dbPath,
          instanceUuid: `worker-uuid-${i}`,
          sessions: sessionsList,
          deadline,
        });

        let result: any = null;

        child.on("message", (msg: any) => {
          if (msg.error) {
            reject(new Error(`Worker error: ${msg.error}`));
          } else {
            result = msg;
          }
        });

        child.on("error", reject);

        child.on("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`Worker stopped with exit code ${code}`));
          } else if (!result) {
            reject(new Error("Worker exited successfully but returned no results"));
          } else {
            resolve(result);
          }
        });
      });
    });

    // 3. Concurrently, main thread acts as "pigeon" churn
    let epochBumpCount = 0;
    let lastEpochBump = Date.now();

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 30) + 20)); // every 20-50ms
      if (Date.now() >= deadline) break;

      // Bump generation on a random session
      const randomSession = sessionsList[Math.floor(Math.random() * sessionsList.length)]!;
      try {
        mainStorage.assignments.bumpGeneration(randomSession, Date.now());
      } catch (err) {
        // Safe to ignore transient lock/busy errors since we loop
      }

      // Bump epoch a couple of times
      if (Date.now() - lastEpochBump > 600 && epochBumpCount < 3) {
        try {
          mainStorage.meta.bumpEpoch(Date.now());
          epochBumpCount++;
          lastEpochBump = Date.now();
        } catch (err) {
          // Safe to ignore transient lock/busy errors
        }
      }
    }

    // 4. Await workers to complete and retrieve results
    const results = await Promise.all(workerPromises);

    // Clean up
    try {
      mainStorage.db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    // 5. Aggregate results
    let totalAcquireSuccess = 0;
    let totalAcquireFail = 0;
    let totalRenewSuccess = 0;
    let totalRenewFail = 0;
    let totalReleaseSuccess = 0;
    let totalReleaseFail = 0;
    const allEvents: OwnershipEvent[] = [];
    const allActionLogs: any[] = [];

    for (const res of results) {
      const { events, actionLogs, counters } = res as any;
      totalAcquireSuccess += counters.acquireSuccess;
      totalAcquireFail += counters.acquireFail;
      totalRenewSuccess += counters.renewSuccess;
      totalRenewFail += counters.renewFail;
      totalReleaseSuccess += counters.releaseSuccess;
      totalReleaseFail += counters.releaseFail;
      allEvents.push(...events);
      if (actionLogs) {
        allActionLogs.push(...actionLogs);
      }
    }

    // Log the aggregates for visibility
    console.log("CONCURRENCY TEST COMPLETED AGGREGATED STATS:", {
      workersSpawned: results.length,
      totalAcquireSuccess,
      totalAcquireFail,
      totalRenewSuccess,
      totalRenewFail,
      totalReleaseSuccess,
      totalReleaseFail,
      epochBumpsRecorded: epochBumpCount,
    });

    // 6. Anti-vacuous guards
    expect(results).toHaveLength(N);
    expect(totalAcquireSuccess).toBeGreaterThan(100);
    expect(totalAcquireFail).toBeGreaterThan(0);

    // 7. Mutual exclusion assertion
    // Group all ownership events by (sessionId, generation, epoch)
    const groups = new Map<string, OwnershipEvent[]>();
    for (const event of allEvents) {
      const key = `${event.sessionId}:${event.generation}:${event.epoch}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(event);
    }

    for (const [key, group] of groups.entries()) {
      // Sort by acquiredAt ascending
      group.sort((a, b) => a.acquiredAt - b.acquiredAt);

      for (let i = 0; i < group.length; i++) {
        const a = group[i]!;
        const aEnd = a.releasedAt !== undefined && a.releasedAt < a.expiresAt ? a.releasedAt : a.expiresAt;

        for (let j = i + 1; j < group.length; j++) {
          const b = group[j]!;
          // Since the array is sorted by acquiredAt, b.acquiredAt >= a.acquiredAt.
          // Therefore, they overlap if and only if b.acquiredAt < aEnd.
          if (b.acquiredAt < aEnd) {
            // Overlap detected. Assert they are from the same instance_uuid (self-renew)
            if (a.instanceUuid !== b.instanceUuid) {
              const sessionLogs = allActionLogs
                .filter((log) => log.sessionId === a.sessionId)
                .sort((x, y) => x.now - y.now);
              console.log(`OVERLAP DETECTED BETWEEN DIFFERENT WORKERS:`, {
                session: a.sessionId,
                gen: a.generation,
                epoch: a.epoch,
                workerA: { uuid: a.instanceUuid, acquiredAt: a.acquiredAt, expiresAt: a.expiresAt, releasedAt: a.releasedAt, end: aEnd },
                workerB: { uuid: b.instanceUuid, acquiredAt: b.acquiredAt, expiresAt: b.expiresAt, releasedAt: b.releasedAt },
                overlapMs: aEnd - b.acquiredAt
              });
              console.log("CHRONOLOGICAL ACTIONS FOR SESSION " + a.sessionId + ":", JSON.stringify(sessionLogs, null, 2));
            }
            expect(a.instanceUuid).toBe(b.instanceUuid);
          }
        }
      }
    }
  }, 30_000);
});

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

interface ActionLog {
  action: "acquire" | "renew" | "release";
  sessionId: string;
  instanceUuid: string;
  gen: number;
  epoch: number;
  now: number;
  ttlMs?: number;
  success: boolean;
  resultExpiresAt?: number;
}

process.on("message", async (msg: any) => {
  if (!msg || msg.type !== "setup") return;

  const { dbPath, instanceUuid, sessions, deadline } = msg;

  const storage = openStorageDb(dbPath);
  storage.db.pragma("busy_timeout = 2000");

  const events: OwnershipEvent[] = [];
  const actionLogs: ActionLog[] = [];
  const counters = {
    acquireSuccess: 0,
    acquireFail: 0,
    renewSuccess: 0,
    renewFail: 0,
    releaseSuccess: 0,
    releaseFail: 0,
  };

  // Track the currently active lease event for each session in this worker
  const activeLeases = new Map<string, OwnershipEvent>();

  async function withRetry<T>(fn: () => T, retries = 10, delayMs = 10): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return fn();
      } catch (err: any) {
        const isBusy = err && (err.code === "SQLITE_BUSY" || String(err).includes("BUSY") || String(err).includes("locked"));
        if (isBusy && attempt < retries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  try {
    while (Date.now() < deadline) {
      const sessionId = sessions[Math.floor(Math.random() * sessions.length)]!;

      // Read current generation and epoch
      const res = await withRetry(() => {
        const assignment = storage.assignments.get(sessionId);
        const meta = storage.meta.get();
        return {
          gen: assignment ? assignment.ownerGeneration : null,
          epoch: meta ? meta.binaryEpoch : null,
        };
      });

      if (res.gen === null || res.epoch === null) {
        // Yield and retry
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        continue;
      }

      const { gen, epoch } = res;
      const ttlMs = 50;

      let acquiredAt = 0;
      const success = await withRetry(() => {
        const now = Date.now();
        const ok = storage.leases.acquireCAS(
          {
            sessionId,
            serveId: "serve-A",
            instanceUuid,
            ownerGeneration: gen,
            binaryEpoch: epoch,
          },
          now,
          ttlMs,
        );
        if (ok) {
          acquiredAt = now;
        }
        actionLogs.push({
          action: "acquire",
          sessionId,
          instanceUuid,
          gen,
          epoch,
          now,
          ttlMs,
          success: ok,
          resultExpiresAt: ok ? now + ttlMs : undefined,
        });
        return ok;
      });

      if (success) {
        counters.acquireSuccess++;

        // If this worker already had an active lease event for this session, close it!
        const prevEvent = activeLeases.get(sessionId);
        if (prevEvent) {
          prevEvent.releasedAt = acquiredAt;
        }

        const event: OwnershipEvent = {
          sessionId,
          instanceUuid,
          generation: gen,
          epoch,
          acquiredAt,
          expiresAt: acquiredAt + ttlMs,
        };

        activeLeases.set(sessionId, event);
        events.push(event);

        // Randomly do a renew or release or let it expire
        const rand = Math.random();
        if (rand < 0.3) {
          // Renew
          const renewDelay = Math.floor(Math.random() * 15) + 5; // 5-20ms
          await new Promise((resolve) => setTimeout(resolve, renewDelay));

          let renewAt = 0;
          const renewSuccess = await withRetry(() => {
            const now = Date.now();
            const ok = storage.leases.renewCAS(
              sessionId,
              "serve-A",
              instanceUuid,
              gen,
              epoch,
              now,
              ttlMs,
            );
            if (ok) {
              renewAt = now;
            }
            actionLogs.push({
              action: "renew",
              sessionId,
              instanceUuid,
              gen,
              epoch,
              now,
              ttlMs,
              success: ok,
              resultExpiresAt: ok ? now + ttlMs : undefined,
            });
            return ok;
          });

          if (renewSuccess) {
            counters.renewSuccess++;
            event.expiresAt = renewAt + ttlMs;
          } else {
            counters.renewFail++;
            // If renew failed, we lost the lease! Close the event at renewAt
            event.releasedAt = renewAt;
            activeLeases.delete(sessionId);
          }
        } else if (rand < 0.6) {
          // Release
          const releaseDelay = Math.floor(Math.random() * 10) + 5; // 5-15ms
          await new Promise((resolve) => setTimeout(resolve, releaseDelay));

          let releasedAt = 0;
          const released = await withRetry(() => {
            const now = Date.now();
            const ok = storage.leases.release(
              sessionId,
              "serve-A",
              instanceUuid,
              gen,
              epoch,
            );
            if (ok) {
              releasedAt = now;
            }
            actionLogs.push({
              action: "release",
              sessionId,
              instanceUuid,
              gen,
              epoch,
              now,
              success: ok,
            });
            return ok;
          });

          if (released) {
            counters.releaseSuccess++;
            event.releasedAt = releasedAt;
            activeLeases.delete(sessionId);
          } else {
            counters.releaseFail++;
          }
        }
      } else {
        counters.acquireFail++;
        // If acquire failed, it means we don't hold the lease anymore (or never did).
        // If we had an active lease in our local map, it means we lost it.
        const prevEvent = activeLeases.get(sessionId);
        if (prevEvent) {
          prevEvent.releasedAt = Date.now();
          activeLeases.delete(sessionId);
        }
      }

      // Small randomized delay to allow interleaving and yield execution
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    }
  } catch (err: any) {
    // If worker crashes, report error
    process.send!({ error: err.stack || err.message || String(err) });
    try {
      storage.db.close();
    } catch {}
    process.exit(1);
  }

  // Close connection
  try {
    storage.db.close();
  } catch {}

  // Post results back
  process.send!({ events, actionLogs, counters });
  process.exit(0);
});

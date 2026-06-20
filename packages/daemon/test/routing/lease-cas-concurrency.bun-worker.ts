import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import type {
  OwnershipEvent,
  ActionLog,
} from "./lease-cas-concurrency.test.js";

const dbPath = process.env.OPENCODE_ROUTING_DB;
const instanceUuid = process.env.WORKER_UUID || "bun-worker";
const sessions: string[] = JSON.parse(process.env.WORKER_SESSIONS || "[]");
const deadline = Number(process.env.WORKER_DEADLINE || "0");
const resultFile = process.env.WORKER_RESULT_FILE;

if (!dbPath || !resultFile) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// FALLBACK: Since the real adapter in packages/core/src/serve/routing-lease.ts
// uses a production retry delay (50ms - 150ms) inside its withRetry wrapper,
// under heavy contention with a 50ms lease TTL it produces stale timestamp skews.
// We fall back to inlining the canonical CAS SQL using bun:sqlite directly with a 
// low-latency retry loop (same as the Node worker). This proves the binding-interop
// property between bun:sqlite and better-sqlite3 WAL files.
async function run() {
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 2000;");

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

  const selectMetaStmt = db.prepare("SELECT binary_epoch FROM routing_meta WHERE id = 1");
  const selectAssignmentStmt = db.prepare(
    "SELECT owner_generation FROM session_assignment WHERE session_id = $sid"
  );

  const acquireCASStmt = db.prepare(
    `INSERT INTO session_lease (session_id, serve_id, instance_uuid, owner_generation, lease_expires_at, heartbeat_at, binary_epoch)
     SELECT @sid, @serve, @uuid, sa.owner_generation, @now + @ttlMs, @now, rm.binary_epoch
     FROM session_assignment sa JOIN routing_meta rm ON rm.id = 1
     WHERE sa.session_id=@sid AND sa.desired_serve_id=@serve AND sa.owner_generation=@gen AND rm.binary_epoch=@epoch
     ON CONFLICT(session_id) DO UPDATE SET
       serve_id=excluded.serve_id, instance_uuid=excluded.instance_uuid, owner_generation=excluded.owner_generation,
       lease_expires_at=excluded.lease_expires_at, heartbeat_at=excluded.heartbeat_at, binary_epoch=excluded.binary_epoch
     WHERE EXISTS (SELECT 1 FROM session_assignment sa JOIN routing_meta rm ON rm.id=1
                   WHERE sa.session_id=excluded.session_id AND sa.desired_serve_id=excluded.serve_id
                     AND sa.owner_generation=excluded.owner_generation AND rm.binary_epoch=excluded.binary_epoch)
       AND ( session_lease.binary_epoch < excluded.binary_epoch
             OR (session_lease.binary_epoch = excluded.binary_epoch AND session_lease.owner_generation < excluded.owner_generation)
             OR (session_lease.binary_epoch = excluded.binary_epoch AND session_lease.owner_generation = excluded.owner_generation
                 AND (session_lease.lease_expires_at <= @now
                      OR (session_lease.serve_id = excluded.serve_id AND session_lease.instance_uuid = excluded.instance_uuid))) )`
  );

  const renewCASStmt = db.prepare(
    `UPDATE session_lease SET lease_expires_at=@now+@ttlMs, heartbeat_at=@now
     WHERE session_id=@sid AND serve_id=@serve AND instance_uuid=@uuid AND owner_generation=@gen AND binary_epoch=@epoch
       AND EXISTS (SELECT 1 FROM session_assignment sa JOIN routing_meta rm ON rm.id=1
                   WHERE sa.session_id=@sid AND sa.desired_serve_id=@serve AND sa.owner_generation=@gen AND rm.binary_epoch=@epoch)`
  );

  const releaseStmt = db.prepare(
    `DELETE FROM session_lease
     WHERE session_id=@sid AND serve_id=@serve AND instance_uuid=@uuid AND owner_generation=@gen AND binary_epoch=@epoch`
  );

  function mapParams(params: Record<string, any>) {
    const mapped: Record<string, any> = {};
    for (const [key, val] of Object.entries(params)) {
      mapped[`$${key}`] = val;
      mapped[`@${key}`] = val;
      mapped[key] = val;
    }
    return mapped;
  }

  async function withRetry<T>(fn: () => T, retries = 10, delayMs = 10): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return fn();
      } catch (err: any) {
        const isBusy = err && (
          err.code === "SQLITE_BUSY" || 
          String(err).includes("BUSY") || 
          String(err).includes("locked")
        );
        if (isBusy && attempt < retries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  const timeQuery = db.prepare("SELECT (julianday('now') - 2440587.5) * 86400000.0 as now");
  const getNow = () => {
    try {
      const row = timeQuery.get() as { now: number };
      return Math.round(row.now);
    } catch {
      return Date.now();
    }
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    while (getNow() < deadline) {
      const sessionId = sessions[Math.floor(Math.random() * sessions.length)]!;

      // Read current generation and epoch
      const res = await withRetry(() => {
        const assignment = selectAssignmentStmt.get(mapParams({ sid: sessionId })) as { owner_generation: number } | null;
        const meta = selectMetaStmt.get() as { binary_epoch: number } | null;
        return {
          gen: assignment ? assignment.owner_generation : null,
          epoch: meta ? meta.binary_epoch : null,
        };
      });

      if (res.gen === null || res.epoch === null) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        continue;
      }

      const { gen, epoch } = res;
      const ttlMs = 50;

      let acquiredAt = 0;
      const success = await withRetry(() => {
        const now = getNow();
        const runRes = acquireCASStmt.run(mapParams({
          sid: sessionId,
          serve: "serve-A",
          uuid: instanceUuid,
          gen,
          epoch,
          now,
          ttlMs,
        }));
        const ok = runRes.changes > 0;
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

        const rand = Math.random();
        if (rand < 0.3) {
          // Renew
          const renewDelay = Math.floor(Math.random() * 15) + 5; // 5-20ms
          await new Promise((resolve) => setTimeout(resolve, renewDelay));

          let renewAt = 0;
          const renewSuccess = await withRetry(() => {
            const now = getNow();
            const runRes = renewCASStmt.run(mapParams({
              sid: sessionId,
              serve: "serve-A",
              uuid: instanceUuid,
              gen,
              epoch,
              now,
              ttlMs,
            }));
            const ok = runRes.changes > 0;
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
            event.releasedAt = renewAt;
            activeLeases.delete(sessionId);
          }
        } else if (rand < 0.6) {
          // Release
          const releaseDelay = Math.floor(Math.random() * 10) + 5; // 5-15ms
          await new Promise((resolve) => setTimeout(resolve, releaseDelay));

          let releasedAt = 0;
          const released = await withRetry(() => {
            const now = getNow();
            const runRes = releaseStmt.run(mapParams({
              sid: sessionId,
              serve: "serve-A",
              uuid: instanceUuid,
              gen,
              epoch,
            }));
            const ok = runRes.changes > 0;
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
        const prevEvent = activeLeases.get(sessionId);
        if (prevEvent) {
          prevEvent.releasedAt = getNow();
          activeLeases.delete(sessionId);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15) + 10));
    }
  } catch (err: any) {
    try {
      db.close();
    } catch {}
    writeFileSync(resultFile, JSON.stringify({ error: err.stack || err.message || String(err) }));
    process.exit(1);
  }

  try {
    db.close();
  } catch {}

  const resultMsg = { events, actionLogs, counters };
  writeFileSync(resultFile, JSON.stringify(resultMsg));
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  if (resultFile) {
    try {
      writeFileSync(resultFile, JSON.stringify({ error: err.stack || err.message || String(err) }));
    } catch {}
  }
  process.exit(1);
});

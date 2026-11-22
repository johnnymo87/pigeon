/**
 * Machine liveness: how often a daemon's poll is recorded, and how old a recorded poll may be
 * before the machine counts as offline (pigeon-wl7a).
 *
 * Every daemon polls every 5s. Recording each poll cost about 52k D1 rows written a day for
 * three machines, more than half the free tier's 100k daily cap. `touchMachine` therefore
 * writes `machines.last_poll_at` only when the stored value is at least
 * HEARTBEAT_WRITE_INTERVAL_MS old, so a live machine's recorded poll can lag its real one by
 * up to that interval plus one poll interval.
 *
 * Rule: MACHINE_ONLINE_MS >= HEARTBEAT_WRITE_INTERVAL_MS + daemon poll interval (5s) + the
 * longest time one daemon tick can hold off its next poll. The tick is serial
 * (`poller.ts` `tick()`), and the longest known stall is receiving a remote launch: health 5s +
 * create 20s + prompt 20s = 45s (`remote-launch-receiver.ts`). The worker cannot check the
 * daemon's side of this at runtime; `worker.test.ts` asserts it over these constants.
 */

/** Minimum age of the stored `last_poll_at` before a poll rewrites it. */
export const HEARTBEAT_WRITE_INTERVAL_MS = 30_000;

/** A machine whose recorded poll is older than this is offline. */
export const MACHINE_ONLINE_MS = 90_000;

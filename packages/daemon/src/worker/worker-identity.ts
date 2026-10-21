/**
 * How this daemon reports its worker credential (pigeon-k0qn.8). Runbook:
 * docs/runbooks/per-machine-credentials.md.
 *
 * At startup the daemon asks `GET /whoami` and logs one `[worker-identity]` line. That
 * line is the runbook's check that "the worker sees this daemon as machine X" after a key
 * is rotated. A mismatch or a rejection only warns here: the poller's refused-poll alarm
 * (`onPollAuthRejected`) is the one alert, so a bad key produces one Telegram message, not
 * two.
 */
import type { WorkerIdentity } from "./poller";

export function describeWorkerIdentity(
  identity: WorkerIdentity,
  machineId: string,
): { level: "log" | "warn"; text: string } {
  switch (identity.kind) {
    case "machine":
      return identity.machineId === machineId
        ? { level: "log", text: `[worker-identity] credential=machine machine=${identity.machineId}` }
        : {
            level: "warn",
            text:
              `[worker-identity] MISMATCH: CCR_MACHINE_ID=${machineId} but the worker registers ` +
              `this credential to ${identity.machineId}; polls will be refused (403)`,
          };
    case "shared":
      return {
        level: "log",
        text: `[worker-identity] credential=shared machine=${machineId} (no per-machine key yet)`,
      };
    case "rejected":
      return {
        level: "warn",
        text:
          `[worker-identity] REJECTED: the worker refuses this credential (${identity.status}); ` +
          "polls will fail. Check CCR_API_KEY, that the key is registered with --remote and not " +
          "revoked, and SHARED_KEY_REFUSED_MACHINES",
      };
    case "unsupported":
      return { level: "log", text: "[worker-identity] worker predates /whoami" };
    case "unknown":
      return { level: "warn", text: `[worker-identity] could not ask the worker: ${identity.error}` };
  }
}

/** Telegram text for the poller's refused-poll alarm. */
export function formatPollAuthAlert(machineId: string, status: number, consecutive: number): string {
  return (
    `pigeon daemon on ${machineId}: the worker has refused its last ${consecutive} polls ` +
    `(HTTP ${status}). Telegram commands for this machine are not being delivered. ` +
    (status === 403
      ? "The credential is registered to a different machine than CCR_MACHINE_ID. "
      : "The credential is unknown or revoked, the shared key has been retired for this machine, " +
        "or the worker was rolled back to a version without per-machine keys. ") +
    "See docs/runbooks/per-machine-credentials.md (rollback), and check the daemon's " +
    "[worker-identity] log line."
  );
}

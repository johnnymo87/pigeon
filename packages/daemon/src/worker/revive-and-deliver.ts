import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { openSync } from "fs";
import type { StorageDb } from "../storage/database";
import type { OpencodeClient } from "../opencode-client";

const AUTO_ATTACH_LOG_PATH = "/tmp/oc-auto-attach.log";

/**
 * Result of a fallback delivery attempt.
 *
 * Reasons:
 *   sessionMissing    — local daemon row doesn't exist (caller skipped the
 *                       initial lookup or it was deleted out from under us).
 *   sessionGone       — opencode-serve returned 404; session truly deleted.
 *                       Caller should delete the local row and notify the user.
 *   serveUnreachable  — getSession threw (network error, 5xx). Caller should
 *                       leave the session row alone and notify the user.
 *   deliveryFailed    — sendPrompt threw. Caller should leave row alone and
 *                       notify the user with the error message.
 */
export type ReviveResult =
  | { ok: true }
  | { ok: false; reason: "sessionMissing" }
  | { ok: false; reason: "sessionGone" }
  | { ok: false; reason: "serveUnreachable"; error: string }
  | { ok: false; reason: "deliveryFailed"; error: string };

export interface ReviveAndDeliverDeps {
  /** Subset of OpencodeClient we actually need. Narrow type for easy mocking. */
  opencodeClient: Pick<OpencodeClient, "getSession" | "sendPrompt">;
  /** Injected for tests; defaults to node child_process.spawn. */
  spawn?: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: { stdio?: "ignore" | "inherit" | "pipe" | Array<"ignore" | "inherit" | "pipe" | number>; detached?: boolean },
  ) => ChildProcess;
}

/**
 * Deliver a prompt to opencode-serve, bypassing the (dead) plugin endpoint.
 *
 * The first reply after a serve restart loses model overrides, media, and
 * question-button capability for that one prompt — see the design doc
 * "Degraded mode on the first revival reply" section. Subsequent replies
 * heal automatically via the plugin's lateDiscoverSession path.
 *
 * On success: clears the dead backendEndpoint/backendAuthToken on the
 * session row (so the next reply doesn't re-try the dead port until the
 * plugin re-registers) and fires `oc-auto-attach <sid>` best-effort to open
 * the session in the user's tmux+nvim.
 *
 * On any failure: leaves the session row alone for the caller to handle.
 */
export async function reviveAndDeliver(
  storage: StorageDb,
  sessionId: string,
  prompt: string,
  deps: ReviveAndDeliverDeps,
): Promise<ReviveResult> {
  const local = storage.sessions.get(sessionId);
  if (!local) {
    return { ok: false, reason: "sessionMissing" };
  }

  let serveSession: { id: string; directory: string } | null;
  try {
    serveSession = await deps.opencodeClient.getSession(sessionId);
  } catch (err) {
    return {
      ok: false,
      reason: "serveUnreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!serveSession) {
    return { ok: false, reason: "sessionGone" };
  }

  try {
    // TOCTOU: opencode-serve could delete the session between getSession and
    // sendPrompt; that race surfaces as `deliveryFailed`, which the caller
    // handles. Don't try to "fix" it — the window is microseconds.
    await deps.opencodeClient.sendPrompt(serveSession.id, serveSession.directory, prompt);
  } catch (err) {
    return {
      ok: false,
      reason: "deliveryFailed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  storage.sessions.clearBackendEndpoint(sessionId);

  spawnAutoAttach(sessionId, deps.spawn);

  return { ok: true };
}

/**
 * Fire-and-forget oc-auto-attach. Mirrors launch-ingest.ts:59-77 — must
 * tolerate ENOENT (cloudbox without the script) and async error events.
 *
 * OC_AUTO_ATTACH_BIN is honored for systemd-managed deployments where the
 * daemon's PATH is locked down (see launch-ingest.ts comment at lines 54-58).
 */
function spawnAutoAttach(
  sessionId: string,
  spawnFn: ReviveAndDeliverDeps["spawn"],
): void {
  try {
    const fn = spawnFn ?? nodeSpawn;
    const bin = process.env.OC_AUTO_ATTACH_BIN ?? "oc-auto-attach";
    
    let logFd: number | "ignore" = "ignore";
    try {
      logFd = openSync(AUTO_ATTACH_LOG_PATH, "a");
    } catch (logErr: unknown) {
      console.warn(`[revive-and-deliver] could not open ${AUTO_ATTACH_LOG_PATH}:`, logErr);
    }

    const child = fn(bin, [sessionId], { stdio: ["ignore", logFd, logFd], detached: true });
    child.on?.("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        console.warn(`[revive-and-deliver] auto-attach spawn failed (async):`, err);
      }
    });
    child.unref?.();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[revive-and-deliver] auto-attach spawn failed (sync):`, err);
    }
  }
}
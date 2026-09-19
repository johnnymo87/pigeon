/**
 * What this daemon can actually launch, advertised to the worker on every poll.
 *
 * WHY A CAPABILITY HEADER EXISTS AT ALL. `LaunchMessage` crosses the worker
 * boundary as a hand-built JSON body with no shared schema and no validation:
 * the worker composes it in `packages/worker/src/poll.ts` and the poller casts
 * the response with `as WorkerMessage`. A wrangler deploy is global and
 * instant; daemons are per-machine, updated by a manual `git pull` plus a
 * restart, and have been measured five days behind. So "new worker, old
 * daemon" is the LIKELY skew, and a `backend` field alone would be IGNORED by
 * an old daemon, which would then launch an opencode session while Telegram
 * said the goose one had started. The header lets the worker refuse instead,
 * without knowing anything about which daemons exist.
 *
 * THE SENTINEL. A daemon configured with neither backend advertises nothing,
 * and "I can serve nothing" must not be confused with "I am too old to have an
 * opinion" — the latter is read as opencode-only. Distinguishing them by an
 * EMPTY header value would make the contract depend on every intermediary
 * preserving an empty field-value, which RFC 9110 permits but which I could not
 * verify for the Cloudflare edge and would have to re-verify forever. So the
 * value is never empty: `none` is sent instead.
 *
 * `none` is deliberately NOT special-cased on the worker side. It is simply a
 * token that matches no backend name, so the worker's ordinary "is the required
 * backend in the advertised set?" test refuses everything without any code
 * there knowing the word exists.
 */

/**
 * Sent on every poll. Pinned byte-exact by tests on BOTH sides of the wire
 * (`packages/daemon/test/backends.test.ts` and the worker's seam test) so that
 * renaming it here fails the worker suite rather than silently disabling the
 * gate — a disabled gate looks exactly like a gate that never matched.
 */
export const BACKENDS_HEADER = "X-Pigeon-Backends";

/** Non-empty stand-in for the empty list. See the file header. */
export const NO_BACKENDS_SENTINEL = "none";

/**
 * What this daemon can LAUNCH -- not what it can drive.
 *
 * The distinction is load-bearing and easy to get wrong. A `GooseRunnerRegistry`
 * means an EXISTING goose session can be driven; it says nothing about whether
 * this daemon can create one. Until the goose launch path exists, the wiring
 * passes `goose: false` even on a machine where `PIGEON_GOOSE_ACP_URL` is set,
 * and that is correct rather than an oversight.
 */
export interface BackendCapabilities {
  /** An `opencodeClient` exists, so an opencode session can be created. */
  opencode: boolean;
  /** The goose launch path exists AND is configured. */
  goose: boolean;
}

/**
 * Renders the header value.
 *
 * THIS MUST REFLECT CONFIGURATION, NEVER HEALTH. It is tempting to probe goose
 * for reachability first and advertise accordingly, and that would be actively
 * harmful: a refusal ACKS the command, so a goose that is merely restarting
 * would turn a launch that was going to succeed ten seconds later into a
 * permanent refusal. Reachability stays the daemon's problem, reported after
 * the command is accepted, where a human can read it and retry.
 *
 * Kept a pure function of an explicit capability record because the wiring that
 * computes it (`index.ts`) carries no tests, so this is the only place the rule
 * can be pinned.
 */
export function advertisedBackends(caps: BackendCapabilities): string {
  const list: string[] = [];
  if (caps.opencode) list.push("opencode");
  if (caps.goose) list.push("goose");
  return list.length > 0 ? list.join(",") : NO_BACKENDS_SENTINEL;
}

/** What a launch means when the worker names no backend. */
export const DEFAULT_BACKEND = "opencode";

/**
 * Whether this daemon can actually serve a launch, and what to tell the human
 * if not.
 *
 * DELIBERATELY REDUNDANT with the worker's gate. The worker refuses these
 * before they are ever handed over, so in a correctly-deployed pair this never
 * fires. It exists because the gate sits on the far side of a boundary with no
 * shared schema and is itself subject to version skew -- an OLD worker has no
 * gate at all -- and because the failure it prevents is silent: launching the
 * wrong backend, or nothing, while Telegram reports success.
 *
 * It lives beside `advertisedBackends` and over the SAME capability type on
 * purpose. Advertising and enforcing are the two halves of one claim, and
 * splitting them across modules is how they drift into disagreeing.
 */
export function checkLaunchServable(
  requested: string | undefined,
  caps: BackendCapabilities,
): { ok: true; backend: string } | { ok: false; message: string } {
  // Undefined is "the ordinary launch", never something invalid: an old worker
  // cannot send this field at all.
  const backend = requested ?? DEFAULT_BACKEND;

  if (backend === DEFAULT_BACKEND) {
    return caps.opencode
      ? { ok: true, backend }
      : { ok: false, message: "This daemon has no opencode configured, so it cannot launch a session." };
  }
  if (backend === "goose") {
    // Deliberately says "cannot launch" rather than "is not configured": on a
    // machine where goose IS configured but the launch path has not shipped,
    // naming configuration would send the human to fix something that is
    // already correct.
    return caps.goose
      ? { ok: true, backend }
      : { ok: false, message: "This daemon cannot launch goose sessions." };
  }
  return { ok: false, message: `This daemon does not know how to launch a ${backend} session.` };
}

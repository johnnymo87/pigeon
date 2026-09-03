/**
 * How a handed-off swarm message gets its delivery CONFIRMED.
 *
 * This is a property of the DELIVERY EVENT — which channel wrote the payload —
 * and deliberately NOT a property of the target session. An earlier design
 * routed on `sessions.backend_kind` via a join, and that was unsound in a way
 * worth recording so it is not reintroduced:
 *
 *  - the session row is DELETED on expiry (`storage/repos.ts` `cleanupExpired`),
 *  - `backend_kind` is MUTABLE on re-registration (`app.ts`),
 *  - but an unverified `handed_off` message is effectively IMMORTAL, because
 *    `cleanupOlderThan` only reaps handed-off rows that are verified.
 *
 * So the message outlives the row it would be joined to. The join would start
 * returning NULL, NULL means `transcript`, and a receipt-family row would walk
 * into the opencode transcript/404 machinery this gate exists to keep it out
 * of — ending at `notifySenderOfFailure(..., "absent")`, which tells the sender
 * "safe to resend". That is a duplicate prompt to an agent holding merge
 * authority. Stamping the family on the row at handoff makes the key stable for
 * the row's whole life, which is the only property that actually matters here.
 *
 * `transcript` — confirmation is archaeology: fetch the target's transcript from
 *   an opencode serve and look for our envelope. Every remedy behind it (anchor
 *   grep, nudge, 404 second opinion) is opencode-specific.
 * `receipt` — the backend reports turn end itself. There is no transcript to
 *   fetch and no 404 to interpret, so reaching the transcript path is always a
 *   bug rather than a slow path.
 *
 * NULL in the database means `transcript`. The direction of that default is
 * decided by failure asymmetry, not convenience: a transcript-family row misread
 * as a receipt row loses the recovery net entirely (silent loss — the founding
 * bug this subsystem exists for), whereas a receipt row misread as transcript is
 * a NOISY false failure. Default toward the noise.
 *
 * ROLLBACK HAZARD, and the reason this comment is not a copy of the APPEND-ONLY
 * warning on `ORIGIN_SOURCES`: that warning is about rank derived from array
 * index, which this registry has no notion of. The hazard here is the opposite
 * direction in time — a daemon OLDER than this gate has no partition at all and
 * will send a receipt-family row straight into the transcript machinery. So the
 * deploy ordering is load-bearing: this gate must be everywhere before anything
 * writes a non-null family.
 */
export const VERIFY_FAMILIES = ["transcript", "receipt"] as const;

export type VerifyFamily = (typeof VERIFY_FAMILIES)[number];

/** The family used when a row carries no stamp. See the NULL rule above. */
export const DEFAULT_VERIFY_FAMILY: VerifyFamily = "transcript";

export function isVerifyFamily(value: unknown): value is VerifyFamily {
  return typeof value === "string" && (VERIFY_FAMILIES as readonly string[]).includes(value);
}

/**
 * The backends we know how to confirm, each mapped to the family that confirms
 * it.
 *
 * This is a `Record<BackendKind, VerifyFamily>` rather than a lookup with a
 * fallback ON PURPOSE: adding a backend without deciding how its delivery is
 * confirmed becomes a COMPILE error instead of a silent default into whichever
 * branch happens to be first. The whole class of bug this gate addresses is a
 * new backend inheriting opencode's remedies by accident.
 */
export const BACKEND_KINDS = ["opencode-plugin-direct", "goose-acp"] as const;

export type BackendKind = (typeof BACKEND_KINDS)[number];

export const VERIFY_FAMILY_BY_BACKEND: Record<BackendKind, VerifyFamily> = {
  "opencode-plugin-direct": "transcript",
  "goose-acp": "receipt",
};

export function isBackendKind(value: unknown): value is BackendKind {
  return typeof value === "string" && (BACKEND_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve a stored `verify_family` value to the family that should handle it.
 *
 * Returns `null` for a value that is neither NULL nor a known family. The caller
 * MUST treat that as refuse-loudly rather than picking a branch. That is honest
 * here only because this column is written exclusively by pigeon's own delivery
 * code — unlike `sessions.backend_kind`, which `app.ts` accepts unvalidated from
 * any registration body. An unrecognised value therefore means a pigeon bug or a
 * rollback, never user input.
 */
export function resolveVerifyFamily(stored: string | null): VerifyFamily | null {
  if (stored === null) return DEFAULT_VERIFY_FAMILY;
  return isVerifyFamily(stored) ? stored : null;
}

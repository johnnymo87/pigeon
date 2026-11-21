/**
 * Transport-neutral readings of a failed `ChatResult`: the `details` body a 502 carries to the
 * daemon, and whether a failed topic send is permanent. Slack's errors are mapped onto the result
 * union by `../slack.ts`.
 */
import type { ChatResult } from "./transport";

/**
 * Extract or synthesize the `details` field for a 502 response from a failed ChatResult.
 * If raw response body is present on the result, returns it directly; otherwise synthesizes an
 * object. The `error_code` field is part of the daemon contract.
 */
export function failureDetails(result: ChatResult<unknown>): unknown {
  if (result.ok) return undefined;
  // `no_transport` is internal and never serialized as a refusal: no `error_code`, so it cannot be
  // read as a 4xx from the provider (callers map it before it reaches a body; this is the backstop).
  if (result.kind === "no_transport") return { ok: false, description: "no_transport" };
  return (
    result.response ?? {
      ok: false,
      description: result.kind === "error" ? result.description : result.kind,
      error_code:
        result.kind === "rate_limited"
          ? 429
          : result.kind === "error"
            ? result.errorCode
            : 400,
    }
  );
}

/**
 * Is a failed topic send PERMANENT — i.e. is the topic itself unusable, such that retrying into
 * it can only fail again?
 *
 * Only a permanent failure justifies relocating a notification to General. A transient one
 * (5xx, or an outcome we cannot classify) must surface as a 502 so the daemon's outbox retries
 * into the RIGHT topic. Relocating on a transient error is how a user's answer ended up in
 * General and was never seen (pigeon-bit4).
 *
 * `errorCode === undefined` means a 200 whose body did not parse, which most likely means the
 * provider PROCESSED the send. Treating it as
 * transient risks a duplicate in the correct topic; treating it as permanent guarantees a
 * misfiled copy. The duplicate is the better-placed risk.
 */
export function isPermanentTopicFailure(result: ChatResult<unknown>): boolean {
  if (result.ok) return false;
  switch (result.kind) {
    case "no_transport":
      // No provider can ever take this address: retrying cannot help.
      return true;
    case "rate_limited":
      // Never reached (callers exclude it first), but 429 is explicitly transient.
      return false;
    case "error":
      return (
        typeof result.errorCode === "number" &&
        result.errorCode >= 400 &&
        result.errorCode < 500
      );
    default:
      // thread_not_found reaching the fallback means the recreate-and-retry above already
      // failed; topic_not_modified cannot come from sendMessage. Both are 4xx-class.
      return true;
  }
}

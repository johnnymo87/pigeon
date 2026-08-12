import { effectiveNotifyPolicy } from "./notify-policy";
import type { StorageDb } from "./storage/database";

/**
 * "Ancillary" Telegram posts are everything that is NOT a Stop/Error/Retry
 * notification: the TUI-prompt mirror (`kind='mirror'`) and the swarm feed
 * (`kind='swarm'`). They exist to make a topic two-sided and to show that a
 * cross-session message was dispatched.
 *
 * WHY THEY NEED THE SAME GATE AS /stop:
 * A session with a quiet `session_origin` row (lgtm's automated reviews) had its
 * Stop suppressed but still emitted mirrors and swarm notices, which defeated the
 * suppression entirely -- and, because a Telegram topic is CREATED by a session's
 * first notification, each leak also created a topic. The visible symptom was a new
 * forum topic per automated PR review even though every Stop was correctly silenced.
 *
 * WHY THE MIRROR LEAK WAS NOT OBVIOUS (do not re-derive this the hard way):
 * `/mirror` does not detect "a human typed into a TUI". It mirrors any user-role
 * message that is not found in `injected_prompts`. lgtm starts sessions with the
 * `opencode-launch` CLI rather than through the daemon's injection path, so lgtm's
 * own launch prompt ("Read the file .lgtm-review-prompt.md ...") is a user message
 * the daemon never recorded and therefore never suppressed. Headlessness is
 * irrelevant; the provenance of the PROMPT is what matters. Any automation that
 * starts sessions outside the daemon leaks identically, so this is not lgtm-specific.
 */

/**
 * Pure predicate: may an ancillary post be emitted under this effective policy?
 *
 * `errors-only` and `none` both suppress. There is no ancillary analogue of an
 * "error" -- the errors-only carve-out exists so a FAILING automated session can
 * still shout, and a mirrored prompt or a swarm dispatch notice is never that.
 */
export function shouldEmitAncillary(policy: string | null): boolean {
  return !(policy === "none" || policy === "errors-only");
}

/**
 * Resolves the gate for a session, applying the same TTL expiry as POST /stop so a
 * long-lived adopted session becomes audible on ONE clock rather than two.
 *
 * FAILS OPEN, deliberately and in every direction: an unknown session, a missing
 * row, a throwing read, or a throwing TTL computation all return true (emit). The
 * house rule is that ambiguity resolves toward delivering -- a spurious post is
 * noise, a silently withheld one is invisible. This function must never be the
 * reason a human's message vanished.
 */
export function shouldEmitAncillaryFor(
  storage: Pick<StorageDb, "sessionOrigins">,
  sessionId: string,
  now: number,
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    const row = storage.sessionOrigins.get(sessionId);
    if (!row) return true;

    const effective = effectiveNotifyPolicy(
      {
        policy: row.notifyPolicy,
        source: row.source,
        declaredAt: row.declaredAt ?? row.createdAt,
        now,
      },
      env,
    );

    return shouldEmitAncillary(effective.policy);
  } catch (err) {
    console.error(
      `[ancillary-gate] policy read failed sessionId=${sessionId}, emitting:`,
      err,
    );
    return true;
  }
}

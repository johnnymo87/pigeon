/**
 * Titles of automation sessions whose routine Stop notifications are suppressed.
 *
 * Tuned against production, NOT guessed. Measured over 181 distinct live session
 * titles (59 mentioning lgtm) plus real-work-on-lgtm probes:
 *
 *   \.lgtm-                              74.6% caught, 0 false positives  (first attempt)
 *   lgtm-(review|gather)-prompt          81.4% caught, 0 false positives
 *   this pattern                         96.6% caught, 0 false positives
 *   bare "lgtm"                         100.0% caught, 4 false positives
 *
 * The leading-dot form was too strict: the model-generated title often drops the
 * dot ("Review PR with lgtm-review-prompt"), and prose variants ("PR review with
 * LGTM prompt") name the tool without the filename at all. Requiring a hyphen or
 * space before "prompt" is what keeps real work ON lgtm deliverable -- "Fix lgtm
 * dispatcher timeout" and "Fix lgtm-run timer flake" both correctly miss.
 *
 * Deliberately still missed: "LGTM for PR #3944" and "LGTM auto-reviews on
 * reviewer add". Both are ambiguous, and the second is probably genuine work on
 * the lgtm tool -- which must be delivered. A false positive silently hides real
 * work, so ambiguity resolves toward delivering.
 */
const DEFAULT_QUIET_TITLE_PATTERN = "lgtm-(review|gather)-prompt|lgtm[ -]prompt";

export function isQuietTitle(
  title: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!title) return false;

  const rawPattern = env.PIGEON_QUIET_TITLE_PATTERN?.trim();
  let regex: RegExp;

  if (rawPattern) {
    try {
      regex = new RegExp(rawPattern, "i");
    } catch (err) {
      console.error(
        `[stop] invalid PIGEON_QUIET_TITLE_PATTERN regex "${rawPattern}", falling back to default automation-title pattern:`,
        err,
      );
      regex = new RegExp(DEFAULT_QUIET_TITLE_PATTERN, "i");
    }
  } else {
    regex = new RegExp(DEFAULT_QUIET_TITLE_PATTERN, "i");
  }

  return regex.test(title);
}

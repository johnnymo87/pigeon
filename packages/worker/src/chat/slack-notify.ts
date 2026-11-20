/**
 * When a Slack post mentions the workspace owner (spec D7, revised: pushes are OFF by default).
 *
 * Pure, so the whole decision table is testable without a transport. The worker var
 * `SLACK_NOTIFY_OWNER` is a comma list of categories; the owner `<@user>` mention is applied only
 * for a post whose category is listed. Unset, empty or all-unknown means no mention at all, and
 * pigeon never emits a broadcast mention (`@channel`, `@here`, `<!channel>` …; see slack-render).
 *
 * Categories of a post:
 *  - `questions`: the daemon flagged the send (`notifyOwner`) and its notification id is `q:…`.
 *  - `errors`: any other explicit `notifyOwner` (error-severity alerts and whatever else the
 *    daemon flags).
 *  - `alerts`: a post into the `_alerts` channel.
 *  - `named`: a post into any other named channel.
 *  - A session channel with no flag has no category: it never mentions.
 */

export const NOTIFY_CATEGORIES = ["questions", "errors", "named", "alerts"] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

/** The categories a caller may assert explicitly (the other two come from the conversation). */
export type ExplicitNotifyCategory = "questions" | "errors";

/** Where a post lands. */
export type ConversationKind = "session" | "named" | "alerts";

/** `SLACK_NOTIFY_OWNER` → the enabled categories. Case-insensitive, trimmed; unknown entries are ignored. */
export function parseNotifyCategories(raw: string | undefined | null): Set<NotifyCategory> {
  const out = new Set<NotifyCategory>();
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if ((NOTIFY_CATEGORIES as readonly string[]).includes(name)) out.add(name as NotifyCategory);
  }
  return out;
}

/** `questions` for a `q:` notification id, else `errors`. */
export function explicitCategory(notificationId: string | undefined | null): ExplicitNotifyCategory {
  return typeof notificationId === "string" && notificationId.startsWith("q:") ? "questions" : "errors";
}

export interface ShouldMentionInput {
  categories: ReadonlySet<NotifyCategory>;
  /** The legacy boolean: true maps to `errors`, or `questions` when the id is a `q:` one. */
  notifyOwner?: boolean | undefined;
  /** An explicit category; wins over the boolean's mapping. */
  notifyCategory?: ExplicitNotifyCategory | undefined;
  notificationId?: string | undefined;
  conversationKind: ConversationKind;
}

/** Mention iff any category that applies to this post is enabled. */
export function shouldMention(input: ShouldMentionInput): boolean {
  const { categories } = input;
  if (categories.size === 0) return false;
  if (input.conversationKind === "alerts" && categories.has("alerts")) return true;
  if (input.conversationKind === "named" && categories.has("named")) return true;
  const explicit = input.notifyCategory ?? (input.notifyOwner === true ? explicitCategory(input.notificationId) : undefined);
  return explicit !== undefined && categories.has(explicit);
}

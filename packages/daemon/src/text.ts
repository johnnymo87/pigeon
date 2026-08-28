/**
 * Text helpers that are safe against UTF-16 surrogate pairs.
 *
 * Why this exists: an unpaired surrogate survives `JSON.stringify` — which escapes it as a
 * well-formed `\udXXX` — so it reaches Telegram intact, but it cannot be encoded as UTF-8.
 * Telegram then either rejects the request (HTTP 400, which the outbox retries 10× and then
 * drops) or mojibakes it to U+FFFD. `splitTelegramMessage` already shipped this exact bug
 * once; see the guard in `split-message.ts` (`sliceBodyMessage`), which this mirrors.
 *
 * Sibling copies exist in `@pigeon/opencode-plugin` (`session-state.ts`) and, from Phase 2,
 * `@pigeon/worker` (`topics.ts`). The three packages share no library, so the logic is
 * duplicated deliberately rather than via a new shared workspace package. Keep them in sync.
 */

/**
 * Clamp `s` to at most `max` UTF-16 code units without splitting a surrogate pair.
 *
 * When the cut would land between a high and a low surrogate, the whole astral character is
 * dropped, yielding `max - 1` units. A pair that ends exactly on the boundary is preserved.
 */
export function clampPreservingSurrogates(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  // Trailing high surrogate means its low half was cut off — drop it too.
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Maximum stored length of a notification excerpt (phase 1b of unread navigation).
 *
 * The excerpt exists so the drill-down can show something readable instead of a
 * bare timestamp. It is captured PRE-FORMAT: by the time a payload reaches
 * commitDelivery it is HTML with entities, escapes, a session prefix and chunk
 * headers, so its first 150 characters are markup rather than content.
 */
export const EXCERPT_MAX_CHARS = 150;

/**
 * Plain-text excerpt of a notification, safe to store and re-render.
 *
 * Returns null for empty/whitespace input so "nothing worth showing" is a single
 * representation (NULL) rather than two ("" and NULL) that every consumer would
 * have to handle.
 */
export function excerptOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return clampPreservingSurrogates(trimmed, EXCERPT_MAX_CHARS);
}

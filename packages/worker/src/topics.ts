/**
 * Returns true if TELEGRAM_TOPICS_ENABLED is set to "true" (exact match).
 * Returns false if "false", absent/undefined, or any other value (fail-safe).
 */
export function topicsEnabled(env: { TELEGRAM_TOPICS_ENABLED?: string }): boolean {
  return env.TELEGRAM_TOPICS_ENABLED === "true";
}

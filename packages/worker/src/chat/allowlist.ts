/**
 * The Telegram chat allowlist. A leaf module (no imports from the rest of the worker) so that
 * `chat/address.ts` can use it without a cycle through `notifications.ts`, which re-exports it.
 */
export function isAllowedChatId(chatId: string | number, env: Env): boolean {
  const raw = env.ALLOWED_CHAT_IDS;
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(String(chatId));
}

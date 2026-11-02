// Env is declared globally for Cloudflare Workers
// See: https://developers.cloudflare.com/workers/configuration/typescript/

declare global {
  interface Env {
    DB: D1Database;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    CCR_API_KEY: string;
    /** Retire the shared key: CSV of machine ids it may no longer act as, or `*` (pigeon-k0qn.8). */
    SHARED_KEY_REFUSED_MACHINES?: string;
    ALLOWED_CHAT_IDS: string;
    ALLOWED_USER_IDS?: string;
    TELEGRAM_TOPICS_ENABLED?: string;
    TELEGRAM_BOT_USERNAME?: string;
    /** "off" disables Telegram rich messages worker-wide; anything else leaves them on (pigeon-p909). */
    TELEGRAM_RICH_MESSAGES?: string;
    MEDIA: R2Bucket;
  }
}
export {};

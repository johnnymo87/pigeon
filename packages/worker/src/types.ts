// Env is declared globally for Cloudflare Workers
// See: https://developers.cloudflare.com/workers/configuration/typescript/

declare global {
  interface Env {
    DB: D1Database;
    ROUTER: DurableObjectNamespace;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    CCR_API_KEY: string;
    ALLOWED_CHAT_IDS: string;
    ALLOWED_USER_IDS?: string;
    MEDIA: R2Bucket;
  }
}

export {};

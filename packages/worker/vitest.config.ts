import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            CCR_API_KEY: "test-api-key",
            TELEGRAM_BOT_TOKEN: "test-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            ALLOWED_CHAT_IDS: "8248645256",
          },
        },
      },
    },
  },
});

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
            // Production retires the shared key for the real machine ids, which the suite also
            // uses with the shared test key. Tests that cover retirement set it per request.
            SHARED_KEY_REFUSED_MACHINES: "",
          },
        },
      },
    },
  },
});

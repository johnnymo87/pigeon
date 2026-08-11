import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Pinned explicitly, not left to the default: test/setup.ts's afterEach
    // token-pin repair depends on running AFTER each test file's own afterEach
    // hooks, which is what "stack" (reverse registration order) guarantees.
    sequence: { hooks: "stack" },
    // Capped below nproc for the same reason as packages/daemon/vitest.config.ts
    // (pigeon-8bif) -- see that file for the measurements. Kept in sync here
    // because `npm run test` runs the workspaces serially, so an uncapped
    // package would reintroduce the peak on its own.
    poolOptions: { forks: { maxForks: 8 } },
  },
});

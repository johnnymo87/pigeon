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
  },
});

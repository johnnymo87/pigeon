import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/daemon",
  "packages/opencode-plugin",
  "packages/worker",
]);

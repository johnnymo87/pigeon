import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Capped below nproc (pigeon-8bif). Vitest's forks pool defaults maxForks to
    // the CPU count (16 on cloudbox), and an agent's bash command whose text
    // contains a bare `git` token runs UNSCOPED inside its opencode serve's
    // cgroup -- which is MemoryMax=14G, OOMPolicy=stop and shared with the serve
    // and every peer session on that port. An OOM anywhere in it kills the serve
    // and silently stops that session's Telegram notifications, so the suite's
    // footprint is not purely its own business.
    //
    // 8 is free rather than a tradeoff. Measured on the daemon suite, cloudbox,
    // 16 cores, in a systemd scope reading cgroup memory.peak:
    //   maxForks=16  3893ms  1063 MiB
    //   maxForks=8   3840ms   837 MiB   <- same wall clock, 21% less memory
    //   maxForks=4   5967ms   668 MiB   <- now paying in wall clock
    poolOptions: { forks: { maxForks: 8 } },
  },
});

import { describe, expect, it } from "vitest";
import { NvimInjector } from "../src/injectors/nvim-injector";
import { TmuxInjector } from "../src/injectors/tmux-injector";
import { createInjectorForSession, injectWithFallback } from "../src/injectors/injector-factory";
import type { CommandRunner } from "../src/injectors/types";
import type { SessionRecord } from "../src/storage/types";

function baseSession(): SessionRecord {
  return {
    sessionId: "s1",
    ppid: null,
    pid: null,
    startTime: null,
    cwd: null,
    label: "demo",
    notify: true,
    state: "running",
    transportKind: "unknown",
    nvimSocket: null,
    instanceName: null,
    tmuxPaneId: null,
    tmuxSession: null,
    paneId: null,
    sessionName: null,
    ptyPath: null,
    createdAt: 1,
    updatedAt: 1,
    lastSeen: 1,
    expiresAt: 2,
  };
}

describe("injectors", () => {
  it("selects nvim injector when nvim transport fields exist", () => {
    const session = {
      ...baseSession(),
      transportKind: "nvim",
      nvimSocket: "/tmp/nvim.sock",
      instanceName: "pts/9",
    };
    const injector = createInjectorForSession(session);
    expect(injector).toBeInstanceOf(NvimInjector);
  });

  it("selects tmux injector when tmux fields exist", () => {
    const session = {
      ...baseSession(),
      transportKind: "tmux",
      tmuxPaneId: "%3",
      tmuxSession: "dev",
    };
    const injector = createInjectorForSession(session);
    expect(injector).toBeInstanceOf(TmuxInjector);
  });

  it("falls back from nvim to tmux when nvim fails", async () => {
    const session = {
      ...baseSession(),
      transportKind: "nvim",
      nvimSocket: "/tmp/nvim.sock",
      instanceName: "pts/9",
      tmuxPaneId: "%3",
      tmuxSession: "dev",
    };

    const failingNvimRunner: CommandRunner = {
      async run() {
        return { code: 1, stdout: "", stderr: "nvim failed" };
      },
    };

    const okTmuxRunner: CommandRunner = {
      async run() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const result = await injectWithFallback(session, "echo test", {
      nvimRunner: failingNvimRunner,
      tmuxRunner: okTmuxRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("tmux");
  });
});

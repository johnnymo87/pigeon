import { describe, expect, it, vi } from "vitest";
import { ingestCurrentStateCommand, type CurrentStateIngestInput } from "../src/worker/current-state-ingest";
import type { AllowlistDeps } from "../src/main-session-allowlist";

describe("current-state-ingest TDD tests", () => {
  it("1. Happy path / ordering / no cap", async () => {
    const callOrder: string[] = [];
    const registerSession = vi.fn().mockImplementation(async (sid, label) => {
      callOrder.push(`register:${sid}`);
    });
    const sendCard = vi.fn().mockImplementation(async (sid, text, entities) => {
      callOrder.push(`card:${sid}`);
    });
    const sendPlainText = vi.fn().mockImplementation(async (text, entities) => {
      callOrder.push(`plain`);
    });

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
        }
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 2000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return [{ info: { role: "user", time: { completed: 1000 } } }];
        }
        if (sid === "ses_B") {
          return [{ info: { role: "user", time: { completed: 2000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    // ONE sendPlainText (the index) called before any sendCard
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe("plain");

    // registerSession called for both
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(registerSession).toHaveBeenCalledWith("ses_A", "Session A");
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");

    // sendCard called once per sid
    expect(sendCard).toHaveBeenCalledTimes(2);

    // Cards ordered by last-activity desc (most-recent first: B is 2000, A is 1000)
    // So ses_B actions should happen before ses_A actions
    const bRegisterIdx = callOrder.indexOf("register:ses_B");
    const bCardIdx = callOrder.indexOf("card:ses_B");
    const aRegisterIdx = callOrder.indexOf("register:ses_A");
    const aCardIdx = callOrder.indexOf("card:ses_A");

    expect(bRegisterIdx).toBeGreaterThan(0);
    expect(bCardIdx).toBeGreaterThan(bRegisterIdx);
    expect(aRegisterIdx).toBeGreaterThan(bCardIdx);
    expect(aCardIdx).toBeGreaterThan(aRegisterIdx);
  });

  it("2. Unreadable (404)", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") return null; // 404
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 2000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_B") {
          return [{ info: { role: "user", time: { completed: 2000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith("ses_B", expect.any(String), expect.any(Array));

    // The index text reflects the unreadable count (contains "1 unreadable")
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("1 unreadable");
  });

  it("3. Zero sids", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("not called")),
      getSessionMessages: vi.fn().mockRejectedValue(new Error("not called")),
    };

    const enumerate = vi.fn().mockResolvedValue([]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
    };

    await ingestCurrentStateCommand(input);

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(sendPlainText).toHaveBeenCalledWith("No main-session TUIs found on devbox.");
    expect(registerSession).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("4. Serve unhealthy", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("not called")),
      getSessionMessages: vi.fn().mockRejectedValue(new Error("not called")),
    };

    const enumerate = vi.fn().mockRejectedValue(new Error("not called"));
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
    };

    await ingestCurrentStateCommand(input);

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(sendPlainText).toHaveBeenCalledWith("opencode serve is not running on devbox.");
    expect(enumerate).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("5. Card failure is best-effort", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    // make first sendCard reject
    const sendCard = vi.fn()
      .mockRejectedValueOnce(new Error("Network fail"))
      .mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
        }
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 2000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return [{ info: { role: "user", time: { completed: 1000 } } }];
        }
        if (sid === "ses_B") {
          return [{ info: { role: "user", time: { completed: 2000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(sendCard).toHaveBeenCalledTimes(2);
  });

  it("6. All unreadable", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
      getSessionMessages: vi.fn().mockResolvedValue([]),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("2 unreadable");
  });

  it("7. getSessionMessages throws -> unreadable + continue", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
        }
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 2000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          throw new Error("Read error");
        }
        if (sid === "ses_B") {
          return [{ info: { role: "user", time: { completed: 2000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    // ses_A gets skipped for card because it failed getSessionMessages, counted as unreadable
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith("ses_B", expect.any(String), expect.any(Array));

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("1 unreadable");
  });

  it("8. registerSession failure isolation", async () => {
    // first registerSession call rejects, second succeeds
    const registerSession = vi.fn()
      .mockRejectedValueOnce(new Error("Register database fail"))
      .mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
        }
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 2000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return [{ info: { role: "user", time: { completed: 1000 } } }];
        }
        if (sid === "ses_B") {
          return [{ info: { role: "user", time: { completed: 2000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    // registerSession is called for both (since first registers B, then B throws, then registers A)
    // Therefore, ses_B does NOT call sendCard.
    // Then ses_A is registered successfully and gets its card.
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith("ses_A", expect.any(String), expect.any(Array));
  });

  it("9. sort stability", async () => {
    const registerSession = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 1000, updated: 1000 } };
        }
        if (sid === "ses_B") {
          return { id: "ses_B", title: "Session B", directory: "/home/dev/b", time: { created: 1000, updated: 1000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockResolvedValue([]), // both have null lastActivityFromMessages, info.time.updated is identical
    };

    const enumerate = vi.fn().mockResolvedValue(["ses_A", "ses_B"]);
    const allowlistDeps = {} as AllowlistDeps;

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      allowlistDeps,
      registerSession,
      sendCard,
      sendPlainText,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(sendCard).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ingestCurrentStateCommand, type CurrentStateIngestInput } from "../src/worker/current-state-ingest";

describe("current-state-ingest TDD tests", () => {
  it("1. Happy path / ordering / no cap", async () => {
    const callOrder: string[] = [];
    const registerSession = vi.fn().mockImplementation(async (sid, label) => {
      callOrder.push(`register:${sid}`);
      return { ok: true, kind: "success", status: 200, body: { ok: true } };
    });
    const enqueueCard = vi.fn().mockImplementation((opts) => {
      callOrder.push(`card:${opts.sid}`);
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    // ONE sendPlainText (the index) called before any enqueueCard
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe("plain");

    // registerSession called for both
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(registerSession).toHaveBeenCalledWith("ses_A", "Session A");
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");

    // enqueueCard called once per sid with deterministic notificationId
    expect(enqueueCard).toHaveBeenCalledTimes(2);
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_B",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_B",
    });
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_A",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_A",
    });

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
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");
    expect(enqueueCard).toHaveBeenCalledTimes(1);
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_B",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_B",
    });

    // The index text reflects the unreadable count (contains "1 unreadable")
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("1 unreadable");
  });

  it("3. Zero sids", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("not called")),
      getSessionMessages: vi.fn().mockRejectedValue(new Error("not called")),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: [], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
    };

    await ingestCurrentStateCommand(input);

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(sendPlainText).toHaveBeenCalledWith("No main-session TUIs found on devbox.");
    expect(registerSession).not.toHaveBeenCalled();
    expect(enqueueCard).not.toHaveBeenCalled();
  });

  it("4. Serve unhealthy", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("not called")),
      getSessionMessages: vi.fn().mockRejectedValue(new Error("not called")),
    };

    const enumerate = vi.fn().mockRejectedValue(new Error("not called"));

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
    };

    await ingestCurrentStateCommand(input);

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    expect(sendPlainText).toHaveBeenCalledWith("opencode serve is not running on devbox.");
    expect(enumerate).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
    expect(enqueueCard).not.toHaveBeenCalled();
  });

  it("5. Card failure is best-effort", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    // make first enqueueCard throw
    const enqueueCard = vi.fn()
      .mockImplementationOnce(() => { throw new Error("Enqueue fail"); })
      .mockImplementation(() => {});
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(enqueueCard).toHaveBeenCalledTimes(2);
  });

  it("6. All unreadable", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
      getSessionMessages: vi.fn().mockResolvedValue([]),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).not.toHaveBeenCalled();
    expect(enqueueCard).not.toHaveBeenCalled();
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("2 unreadable");
  });

  it("7. getSessionMessages throws -> unreadable + continue", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    // ses_A gets skipped for card because it failed getSessionMessages, counted as unreadable
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("ses_B", "Session B");
    expect(enqueueCard).toHaveBeenCalledTimes(1);
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_B",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_B",
    });

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("1 unreadable");
  });

  it("8. registerSession failure isolation", async () => {
    // first registerSession call returns ok=false (or throws), second succeeds
    const registerSession = vi.fn()
      .mockResolvedValueOnce({ ok: false, kind: "http_error", status: 500 })
      .mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    // registerSession is called for both (since first registers B, then B fails, then registers A)
    // Therefore, ses_B does NOT call enqueueCard.
    // Then ses_A is registered successfully and gets its card enqueued.
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(enqueueCard).toHaveBeenCalledTimes(1);
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_A",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_A",
    });
  });

  it("9. sort stability", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
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

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(enqueueCard).toHaveBeenCalledTimes(2);
  });

  it("10. homeScreenCount threads into index", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return { id: "ses_A", title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
        }
        return null;
      }),
      getSessionMessages: vi.fn().mockImplementation(async (sid: string) => {
        if (sid === "ses_A") {
          return [{ info: { role: "user", time: { completed: 1000 } } }];
        }
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A"], homeScreenCount: 2 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).toContain("2 on home screen");
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(enqueueCard).toHaveBeenCalledTimes(1);
  });

  it("11. only home-screen TUIs (no sessions)", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("not called")),
      getSessionMessages: vi.fn().mockRejectedValue(new Error("not called")),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: [], homeScreenCount: 3 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet: vi.fn().mockReturnValue(null),
    };

    await ingestCurrentStateCommand(input);

    // It should NOT send "No main-session TUIs found"
    expect(sendPlainText).toHaveBeenCalledTimes(1);
    const indexText = (sendPlainText.mock.calls[0]?.[0] as string) ?? "";
    expect(indexText).not.toContain("No main-session TUIs found");
    expect(indexText).toContain("0 main session(s)");
    expect(indexText).toContain("3 on home screen");

    expect(registerSession).not.toHaveBeenCalled();
    expect(enqueueCard).not.toHaveBeenCalled();
  });

  it("12. describeQuiet is called per session with sid and title, and quiet reaches card", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const describeQuiet = vi.fn().mockImplementation((sid: string, title: string) => {
      if (sid === "ses_A") {
        return { reason: "origin", origin: "lgtm", policy: "errors-only" };
      }
      return null;
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
        if (sid === "ses_A") return [{ info: { role: "user", time: { completed: 1000 } } }];
        if (sid === "ses_B") return [{ info: { role: "user", time: { completed: 2000 } } }];
        return [];
      }),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A", "ses_B"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet,
      now: 2500,
    };

    await ingestCurrentStateCommand(input);

    expect(describeQuiet).toHaveBeenCalledTimes(2);
    expect(describeQuiet).toHaveBeenCalledWith("ses_B", "Session B");
    expect(describeQuiet).toHaveBeenCalledWith("ses_A", "Session A");

    expect(enqueueCard).toHaveBeenCalledTimes(2);
    const sesACardCall = enqueueCard.mock.calls.find((c) => c[0].sid === "ses_A");
    expect(sesACardCall[0].text).toContain("🔇 Muted by lgtm · errors still notify");

    const sesBCardCall = enqueueCard.mock.calls.find((c) => c[0].sid === "ses_B");
    expect(sesBCardCall[0].text).not.toContain("🔇");
  });

  it("13. describeQuiet throwing does not break card enqueueing", async () => {
    const registerSession = vi.fn().mockResolvedValue({ ok: true, kind: "success", status: 200, body: { ok: true } });
    const enqueueCard = vi.fn();
    const sendPlainText = vi.fn().mockResolvedValue(undefined);

    const describeQuiet = vi.fn().mockImplementation(() => {
      throw new Error("DB error in describeQuiet");
    });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const opencodeClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockImplementation(async (sid: string) => {
        return { id: sid, title: "Session A", directory: "/home/dev/a", time: { created: 500, updated: 1000 } };
      }),
      getSessionMessages: vi.fn().mockResolvedValue([{ info: { role: "user", time: { completed: 1000 } } }]),
    };

    const enumerate = vi.fn().mockResolvedValue({ sids: ["ses_A"], homeScreenCount: 0 });

    const input: CurrentStateIngestInput = {
      commandId: "cmd-123",
      chatId: "chat-456",
      machineId: "devbox",
      opencodeClient,
      enumerate,
      registerSession,
      enqueueCard,
      sendPlainText,
      describeQuiet,
      now: 2500,
    };

    await expect(ingestCurrentStateCommand(input)).resolves.not.toThrow();

    expect(enqueueCard).toHaveBeenCalledTimes(1);
    expect(enqueueCard).toHaveBeenCalledWith({
      sid: "ses_A",
      text: expect.any(String),
      entities: expect.any(Array),
      notificationId: "cs:cmd-123:ses_A",
    });
    const cardCall = enqueueCard.mock.calls[0];
    expect(cardCall[0].text).not.toContain("🔇");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[current-state-ingest] describeQuiet failed for ses_A:"),
      expect.any(Error),
    );

    consoleWarnSpy.mockRestore();
  });

});

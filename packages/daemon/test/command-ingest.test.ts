import { describe, expect, it } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import { ResultErrorCode } from "../src/opencode-direct/contracts";

describe("ingestWorkerCommand", () => {
  it("acks and marks command done on successful injection", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      transportKind: "tmux",
      tmuxPaneId: "%3",
      tmuxSession: "dev",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-1",
        sessionId: "sess-1",
        command: "ls",
        chatId: "1",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async injectCommand() {
          return { ok: true, transport: "tmux" };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-1" },
      { type: "commandResult", commandId: "cmd-1", success: true, error: null, chatId: "1" },
    ]);

    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(0);
    storage.db.close();
  });

  it("returns commandResult failure when session missing", async () => {
    const storage = openStorageDb(":memory:");
    const sent: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-2",
        sessionId: "nope",
        command: "ls",
        chatId: "2",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-2" },
      {
        type: "commandResult",
        commandId: "cmd-2",
        success: false,
        error: "Session not found. Wait for a new notification.",
        chatId: "2",
      },
    ]);

    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(1);
    storage.db.close();
  });

  it("routes opencode-plugin-direct sessions through direct adapter", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-direct",
      notify: true,
      transportKind: "unknown",
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-direct-1",
        sessionId: "sess-direct",
        command: "echo hi",
        chatId: "3",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async executeDirect() {
          return {
            ok: true,
            status: 200,
            attempts: 1,
            ack: {
              type: "pigeon.command.ack",
              version: 1,
              requestId: "cmd-direct-1",
              commandId: "cmd-direct-1",
              sessionId: "sess-direct",
              accepted: true,
              acceptedAt: Date.now(),
            },
            result: {
              type: "pigeon.command.result",
              version: 1,
              requestId: "cmd-direct-1",
              commandId: "cmd-direct-1",
              sessionId: "sess-direct",
              success: true,
              finishedAt: Date.now(),
              output: "queued",
            },
          };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-direct-1" },
      { type: "commandResult", commandId: "cmd-direct-1", success: true, error: null, chatId: "3" },
    ]);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns direct adapter error as commandResult failure", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-direct-fail",
      notify: true,
      transportKind: "unknown",
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-direct-2",
        sessionId: "sess-direct-fail",
        command: "echo hi",
        chatId: "4",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async executeDirect() {
          return {
            ok: false,
            status: 200,
            attempts: 1,
            ack: {
              type: "pigeon.command.ack",
              version: 1,
              requestId: "cmd-direct-2",
              commandId: "cmd-direct-2",
              sessionId: "sess-direct-fail",
              accepted: true,
              acceptedAt: Date.now(),
            },
            result: {
              type: "pigeon.command.result",
              version: 1,
              requestId: "cmd-direct-2",
              commandId: "cmd-direct-2",
              sessionId: "sess-direct-fail",
              success: false,
              finishedAt: Date.now(),
              errorCode: ResultErrorCode.ExecutionError,
              errorMessage: "plugin failed",
            },
            error: "plugin failed",
          };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-direct-2" },
      {
        type: "commandResult",
        commandId: "cmd-direct-2",
        success: false,
        error: "plugin failed",
        chatId: "4",
      },
    ]);
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });
});

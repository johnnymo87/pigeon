import { describe, expect, it } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";

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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { startDirectChannelServer } from "../../opencode-plugin/src/direct-channel";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";

describe("opencode direct-channel routing integration", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it("routes command through plugin direct endpoint and returns success", async () => {
    const onExecute = vi.fn(async () => ({ success: true, output: "queued" }));
    const server = await startDirectChannelServer({ onExecute });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: server.authToken,
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-1",
        sessionId: "sess-int-1",
        command: "echo DIRECT_OK",
        chatId: "42",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-int-1" },
      {
        type: "commandResult",
        commandId: "cmd-int-1",
        success: true,
        error: null,
        chatId: "42",
      },
    ]);

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns failure when plugin direct auth token is wrong", async () => {
    const server = await startDirectChannelServer({
      onExecute: async () => ({ success: true }),
    });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-2",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: "wrong-token",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-2",
        sessionId: "sess-int-2",
        command: "echo fail",
        chatId: "99",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-2" });
    expect(sent[1]).toEqual({
      type: "commandResult",
      commandId: "cmd-int-2",
      success: false,
      error: "UNAUTHORIZED",
      chatId: "99",
    });

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("propagates execution failure from plugin handler", async () => {
    const onExecute = vi.fn(async () => ({
      success: false,
      exitCode: 1,
      output: "command failed",
      errorCode: "EXECUTION_ERROR" as const,
      errorMessage: "Non-zero exit code",
    }));
    const server = await startDirectChannelServer({ onExecute });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-3",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: server.authToken,
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-3",
        sessionId: "sess-int-3",
        command: "exit 1",
        chatId: "50",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-3" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-3",
      success: false,
      chatId: "50",
    });
    expect((sent[1] as Record<string, unknown>).error).toBeTruthy();

    // Inbox should NOT be marked done on failure
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("handles plugin handler throwing an exception (500 / INTERNAL)", async () => {
    const onExecute = vi.fn(async () => {
      throw new Error("Unexpected plugin crash");
    });
    const server = await startDirectChannelServer({ onExecute });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-4",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: server.authToken,
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-4",
        sessionId: "sess-int-4",
        command: "echo crash",
        chatId: "51",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    // Adapter retries on 500, so onExecute is called twice (1 + 1 retry)
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-4" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-4",
      success: false,
      chatId: "51",
    });
    expect((sent[1] as Record<string, unknown>).error).toBeTruthy();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns failure for unreachable plugin endpoint (network error)", async () => {
    const storage = openStorageDb(":memory:");
    // Use a port that nothing listens on
    storage.sessions.upsert({
      sessionId: "sess-int-5",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:1/pigeon/direct/execute",
      backendAuthToken: "token-doesnt-matter",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-5",
        sessionId: "sess-int-5",
        command: "echo unreachable",
        chatId: "52",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-5" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-5",
      success: false,
      chatId: "52",
    });
    expect((sent[1] as Record<string, unknown>).error).toBeTruthy();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("deduplicates commands with the same commandId", async () => {
    const onExecute = vi.fn(async () => ({ success: true, output: "ok" }));
    const server = await startDirectChannelServer({ onExecute });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-6",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: server.authToken,
    }, 1_000);

    const sent: unknown[] = [];
    const callbacks = { send(payload: unknown) { sent.push(payload); } };
    const msg = {
      type: "command" as const,
      commandId: "cmd-int-6-dup",
      sessionId: "sess-int-6",
      command: "echo dedup",
      chatId: "53",
    };

    // First call goes through
    await ingestWorkerCommand(storage, msg, callbacks);
    // Second call with same commandId is deduplicated
    await ingestWorkerCommand(storage, msg, callbacks);

    // First call: ack + result. Second call: ack only (dedup).
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-6-dup" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-6-dup",
      success: true,
    });
    // The dedup ack
    expect(sent[2]).toEqual({ type: "ack", commandId: "cmd-int-6-dup" });

    storage.db.close();
  });

  it("maps callback-style commands to telegram-callback source", async () => {
    let capturedCommand: unknown = null;
    const onExecute = vi.fn(async (req: unknown) => {
      capturedCommand = req;
      return { success: true, output: "continued" };
    });
    const server = await startDirectChannelServer({ onExecute });
    closers.push(server.close);

    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-int-7",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: server.endpoint,
      backendAuthToken: server.authToken,
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-7",
        sessionId: "sess-int-7",
        command: "continue",
        chatId: "54",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(capturedCommand).toMatchObject({
      source: "telegram-callback",
      command: "continue",
    });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      success: true,
    });

    storage.db.close();
  });

  it("returns session-not-found when no session exists in storage", async () => {
    const storage = openStorageDb(":memory:");
    // No session upserted

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-8",
        sessionId: "sess-nonexistent",
        command: "echo ghost",
        chatId: "55",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-8" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-8",
      success: false,
    });
    expect((sent[1] as Record<string, unknown>).error).toMatch(/[Ss]ession/);

    storage.db.close();
  });

  it("rejects opencode-plugin-direct session with incomplete backend registration", async () => {
    const storage = openStorageDb(":memory:");
    // Session has backendKind but NO endpoint/token — incomplete registration
    storage.sessions.upsert({
      sessionId: "sess-int-10",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      // Missing backendEndpoint and backendAuthToken
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-int-10",
        sessionId: "sess-int-10",
        command: "echo should-not-deliver",
        chatId: "99",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-int-10" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-int-10",
      success: false,
    });
    expect((sent[1] as Record<string, unknown>).error).toMatch(/not configured for command delivery/i);

    storage.db.close();
  });
});

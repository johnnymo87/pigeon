import { afterEach, describe, expect, it, vi } from "vitest";
import { startDirectChannelServer } from "../../opencode-plugin/src/direct-channel";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import type { ExecuteMessage } from "../src/worker/poller";

function makeMsg(overrides: Partial<ExecuteMessage> = {}): ExecuteMessage {
  return {
    commandId: "cmd-int-default",
    commandType: "execute",
    sessionId: "sess-int-default",
    command: "echo test",
    chatId: "42",
    ...overrides,
  };
}

describe("opencode direct-channel routing integration", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it("routes command through plugin direct endpoint and marks inbox done on success", async () => {
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

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-int-1", sessionId: "sess-int-1", command: "echo DIRECT_OK", chatId: "42" }),
    );

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns normally (Poller acks) when plugin direct auth token is wrong", async () => {
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

    // Should not throw — permanent failure, Poller acks
    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-2", sessionId: "sess-int-2", command: "echo fail", chatId: "99" }),
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns normally (Poller acks) when plugin handler returns execution failure", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-3", sessionId: "sess-int-3", command: "exit 1", chatId: "50" }),
      ),
    ).resolves.toBeUndefined();

    expect(onExecute).toHaveBeenCalledTimes(1);
    // Inbox NOT marked done on failure
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns normally (Poller acks) when plugin handler throws exception (500 / INTERNAL)", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-4", sessionId: "sess-int-4", command: "echo crash", chatId: "51" }),
      ),
    ).resolves.toBeUndefined();

    // Adapter retries on 500, so onExecute is called twice (1 + 1 retry)
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("removes dead session and returns normally when plugin endpoint is unreachable", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-5", sessionId: "sess-int-5", command: "echo unreachable", chatId: "52" }),
      ),
    ).resolves.toBeUndefined();

    // Session should be cleaned up (connection error = dead session)
    expect(storage.sessions.get("sess-int-5")).toBeNull();
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

    const msg = makeMsg({
      commandId: "cmd-int-6-dup",
      sessionId: "sess-int-6",
      command: "echo dedup",
      chatId: "53",
    });

    // First call goes through
    await ingestWorkerCommand(storage, msg);
    // Second call with same commandId is deduplicated
    await ingestWorkerCommand(storage, msg);

    // Adapter called only once (second call was deduped)
    expect(onExecute).toHaveBeenCalledTimes(1);
    storage.db.close();
  });

  it("sends all text commands with telegram-reply source", async () => {
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

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-int-7", sessionId: "sess-int-7", command: "continue", chatId: "54" }),
    );

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(capturedCommand).toMatchObject({
      source: "telegram-reply",
      command: "continue",
    });
    storage.db.close();
  });

  it("returns normally (Poller acks) when no session exists in storage", async () => {
    const storage = openStorageDb(":memory:");
    // No session upserted

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-8", sessionId: "sess-nonexistent", command: "echo ghost", chatId: "55" }),
      ),
    ).resolves.toBeUndefined();

    // Command persisted in inbox but not marked done
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns normally (Poller acks) when session has incomplete backend registration", async () => {
    const storage = openStorageDb(":memory:");
    // Session has backendKind but NO endpoint/token — incomplete registration
    storage.sessions.upsert({
      sessionId: "sess-int-10",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      // Missing backendEndpoint and backendAuthToken
    }, 1_000);

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-int-10", sessionId: "sess-int-10", command: "echo should-not-deliver", chatId: "99" }),
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });
});

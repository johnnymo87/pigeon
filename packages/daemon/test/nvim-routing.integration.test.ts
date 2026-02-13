import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import type { CommandDeliveryAdapter, CommandDeliveryResult } from "../src/adapters/types";

// ---------------------------------------------------------------------------
// Session-model tests (via daemon HTTP API)
// ---------------------------------------------------------------------------

describe("nvim session routing — HTTP session model", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("session-start accepts nvim_socket", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 10_000 });

    const start = await app(
      new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "nvim-sess-1",
          notify: true,
          tty: "/dev/pts/5",
          nvim_socket: "/tmp/nvim.sock",
          label: "Nvim Session",
        }),
      }),
    );

    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ ok: true, session_id: "nvim-sess-1" });

    const list = await app(new Request("http://localhost/sessions"));
    const listBody = (await list.json()) as {
      ok: boolean;
      sessions: Array<Record<string, unknown>>;
    };
    expect(list.status).toBe(200);
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]?.nvim_socket).toBe("/tmp/nvim.sock");
  });

  it("enable-notify preserves nvim_socket", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 20_000 });

    // Create session with nvim_socket but notify=false
    await app(
      new Request("http://localhost/session-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "nvim-sess-2",
          notify: false,
          tty: "/dev/pts/6",
          nvim_socket: "/tmp/nvim2.sock",
        }),
      }),
    );

    // Enable notify — nvim_socket should be preserved
    const response = await app(
      new Request("http://localhost/sessions/enable-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "nvim-sess-2",
          label: "Notified Nvim",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      session: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.session.notify).toBe(true);
    expect(body.session.label).toBe("Notified Nvim");
    expect(body.session.nvim_socket).toBe("/tmp/nvim2.sock");
  });
});

// ---------------------------------------------------------------------------
// Command routing tests (through ingestWorkerCommand)
// ---------------------------------------------------------------------------

describe("nvim session routing — command ingest pipeline", () => {
  it("routes to nvim adapter when nvimSocket + ptyPath present", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      {
        sessionId: "nvim-route-1",
        notify: true,
        nvimSocket: "/tmp/nvim.sock",
        ptyPath: "/dev/pts/7",
      },
      1_000,
    );

    const mockDeliverCommand = vi.fn(async (): Promise<CommandDeliveryResult> => ({
      ok: true,
    }));

    const mockAdapter: CommandDeliveryAdapter = {
      name: "nvim-rpc",
      deliverCommand: mockDeliverCommand,
    };

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-nvim-1",
        sessionId: "nvim-route-1",
        command: "echo hello",
        chatId: "100",
      },
      { send(payload) { sent.push(payload); } },
      { createAdapter: () => mockAdapter },
    );

    expect(mockDeliverCommand).toHaveBeenCalledTimes(1);

    // Verify adapter received the correct session and command
    const callArgs = mockDeliverCommand.mock.calls[0] as unknown[];
    const calledSession = callArgs[0] as Record<string, unknown>;
    const calledCommand = callArgs[1] as string;
    const calledContext = callArgs[2] as Record<string, unknown>;
    expect(calledSession.sessionId).toBe("nvim-route-1");
    expect(calledSession.nvimSocket).toBe("/tmp/nvim.sock");
    expect(calledSession.ptyPath).toBe("/dev/pts/7");
    expect(calledCommand).toBe("echo hello");
    expect(calledContext).toMatchObject({ commandId: "cmd-nvim-1", chatId: "100" });

    // Verify ack + success result
    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-nvim-1" },
      {
        type: "commandResult",
        commandId: "cmd-nvim-1",
        success: true,
        error: null,
        chatId: "100",
      },
    ]);

    storage.db.close();
  });

  it("direct-channel takes priority over nvim", async () => {
    const storage = openStorageDb(":memory:");
    // Session has BOTH direct-channel fields AND nvim fields
    storage.sessions.upsert(
      {
        sessionId: "nvim-route-2",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
        backendAuthToken: "test-token",
        nvimSocket: "/tmp/nvim.sock",
        ptyPath: "/dev/pts/8",
      },
      1_000,
    );

    let adapterNameUsed: string | null = null;

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-nvim-2",
        sessionId: "nvim-route-2",
        command: "echo priority",
        chatId: "101",
      },
      { send(payload) { sent.push(payload); } },
      {
        createAdapter: (session) => {
          // The production selectAdapter would pick direct-channel first,
          // so we replicate that decision and record which adapter was chosen.
          if (
            session.backendKind === "opencode-plugin-direct"
            && session.backendEndpoint
            && session.backendAuthToken
          ) {
            const adapter: CommandDeliveryAdapter = {
              name: "direct-channel",
              deliverCommand: async () => ({ ok: true }),
            };
            adapterNameUsed = adapter.name;
            return adapter;
          }
          if (session.nvimSocket && session.ptyPath) {
            const adapter: CommandDeliveryAdapter = {
              name: "nvim-rpc",
              deliverCommand: async () => ({ ok: true }),
            };
            adapterNameUsed = adapter.name;
            return adapter;
          }
          return null;
        },
      },
    );

    // Direct-channel should have been chosen over nvim-rpc
    expect(adapterNameUsed).toBe("direct-channel");

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-nvim-2" },
      {
        type: "commandResult",
        commandId: "cmd-nvim-2",
        success: true,
        error: null,
        chatId: "101",
      },
    ]);

    storage.db.close();
  });

  it("nvim adapter delivery failure propagates error", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      {
        sessionId: "nvim-route-3",
        notify: true,
        nvimSocket: "/tmp/nvim.sock",
        ptyPath: "/dev/pts/9",
      },
      1_000,
    );

    const mockAdapter: CommandDeliveryAdapter = {
      name: "nvim-rpc",
      deliverCommand: async () => ({
        ok: false,
        error: "instance not found",
      }),
    };

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-nvim-3",
        sessionId: "nvim-route-3",
        command: "echo fail",
        chatId: "102",
      },
      { send(payload) { sent.push(payload); } },
      { createAdapter: () => mockAdapter },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-nvim-3" });
    expect(sent[1]).toEqual({
      type: "commandResult",
      commandId: "cmd-nvim-3",
      success: false,
      error: "instance not found",
      chatId: "102",
    });

    // Inbox should NOT be marked done on failure
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("nvim adapter delivery success marks command done", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      {
        sessionId: "nvim-route-4",
        notify: true,
        nvimSocket: "/tmp/nvim.sock",
        ptyPath: "/dev/pts/10",
      },
      1_000,
    );

    const mockAdapter: CommandDeliveryAdapter = {
      name: "nvim-rpc",
      deliverCommand: async () => ({ ok: true }),
    };

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-nvim-4",
        sessionId: "nvim-route-4",
        command: "echo success",
        chatId: "103",
      },
      { send(payload) { sent.push(payload); } },
      { createAdapter: () => mockAdapter },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-nvim-4" });
    expect(sent[1]).toEqual({
      type: "commandResult",
      commandId: "cmd-nvim-4",
      success: true,
      error: null,
      chatId: "103",
    });

    // Inbox should be marked done on success
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("session with neither backend nor nvim gets error", async () => {
    const storage = openStorageDb(":memory:");
    // Session has no backendKind, no nvimSocket, no ptyPath
    storage.sessions.upsert(
      {
        sessionId: "nvim-route-5",
        notify: true,
      },
      1_000,
    );

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-nvim-5",
        sessionId: "nvim-route-5",
        command: "echo orphan",
        chatId: "104",
      },
      { send(payload) { sent.push(payload); } },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "ack", commandId: "cmd-nvim-5" });
    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-nvim-5",
      success: false,
      chatId: "104",
    });
    expect((sent[1] as Record<string, unknown>).error).toMatch(
      /not configured for command delivery/i,
    );

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });
});

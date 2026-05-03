import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { reviveAndDeliver, type ReviveAndDeliverDeps } from "../src/worker/revive-and-deliver";

function makeDeps(overrides: Partial<ReviveAndDeliverDeps> = {}): ReviveAndDeliverDeps {
  return {
    opencodeClient: {
      async getSession() { return { id: "sess-1", directory: "/tmp/proj" }; },
      async sendPrompt() { /* ok */ },
    },
    spawn: vi.fn(() => ({
      on: vi.fn(),
      unref: vi.fn(),
    })) as unknown as ReviveAndDeliverDeps["spawn"],
    ...overrides,
  };
}

describe("reviveAndDeliver", () => {
  it("delivers via opencode-serve, clears backendEndpoint, and spawns oc-auto-attach on success", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) as unknown as ReviveAndDeliverDeps["spawn"];

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "fix the bug",
      makeDeps({
        opencodeClient: {
          async getSession() { return { id: "sess-1", directory: "/tmp/proj" }; },
          async sendPrompt(sid: string, dir: string, prompt: string) { sendPromptCalls.push({ sid, dir, prompt }); },
        },
        spawn,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(sendPromptCalls).toEqual([{ sid: "sess-1", dir: "/tmp/proj", prompt: "fix the bug" }]);

    const row = storage.sessions.get("sess-1");
    expect(row?.backendEndpoint).toBeNull();
    expect(row?.backendAuthToken).toBeNull();
    // Session row itself NOT deleted
    expect(row).not.toBeNull();

    expect(spawn).toHaveBeenCalledWith("oc-auto-attach", ["sess-1"], expect.any(Object));

    storage.db.close();
  });

  it("returns sessionGone when opencode-serve says 404 and does NOT clear endpoint", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-gone",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-gone",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { return null; },
          async sendPrompt() { throw new Error("should not be called"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "sessionGone" });
    // Endpoint NOT cleared (caller will delete the whole row)
    const row = storage.sessions.get("sess-gone");
    expect(row?.backendEndpoint).toBe("http://127.0.0.1:7777/dead");

    storage.db.close();
  });

  it("returns deliveryFailed with the error message when sendPrompt throws", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { return { id: "sess-1", directory: "/tmp" }; },
          async sendPrompt() { throw new Error("opencode-serve borked"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "deliveryFailed", error: "opencode-serve borked" });
    // Endpoint NOT cleared on failure (we want to preserve state for diagnosis)
    expect(storage.sessions.get("sess-1")?.backendEndpoint).toBe("http://127.0.0.1:7777/dead");
  });

  it("returns serveUnreachable when getSession throws (not a 404)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({
        opencodeClient: {
          async getSession() { throw new Error("ECONNREFUSED"); },
          async sendPrompt() { throw new Error("should not be called"); },
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "serveUnreachable", error: "ECONNREFUSED" });
  });

  it("swallows oc-auto-attach ENOENT (host without the script installed)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      backendKind: "opencode-plugin-direct",
      backendEndpoint: "http://127.0.0.1:7777/dead",
      backendAuthToken: "tok",
      notify: true,
    }, 1_000);

    const spawn = vi.fn(() => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as unknown as ReviveAndDeliverDeps["spawn"];

    // Should still return ok despite the spawn failure
    const result = await reviveAndDeliver(
      storage,
      "sess-1",
      "hello",
      makeDeps({ spawn }),
    );

    expect(result).toEqual({ ok: true });
  });

  it("returns sessionMissing if local session row doesn't exist (defensive)", async () => {
    const storage = openStorageDb(":memory:");

    const result = await reviveAndDeliver(
      storage,
      "sess-nope",
      "hello",
      makeDeps(),
    );

    expect(result).toEqual({ ok: false, reason: "sessionMissing" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { SessionGone, type SessionGoneRow } from "../src/session-gone";

function setup(rows: Record<string, SessionGoneRow>) {
  const live = new Map(Object.entries(rows));
  const tornDown: string[] = [];
  const teardown = vi.fn(async (id: string) => {
    live.delete(id);
    tornDown.push(id);
  });
  const gone = new SessionGone({
    getSession: (id) => live.get(id) ?? null,
    teardown,
    log: () => {},
  });
  return { gone, live, tornDown, teardown };
}

const OPENCODE: SessionGoneRow = { backendKind: "opencode-plugin-direct", boundTopicKey: null };

describe("SessionGone.backendDeleted (pigeon-4ogz.21)", () => {
  it("tears down an opencode session the TUI deleted", async () => {
    const { gone, tornDown } = setup({ ses_a: OPENCODE });

    await expect(gone.backendDeleted("ses_a")).resolves.toBe("torn_down");
    expect(tornDown).toEqual(["ses_a"]);
  });

  it("treats a legacy row with no backend kind as opencode", async () => {
    const { gone, tornDown } = setup({ ses_a: { backendKind: null, boundTopicKey: null } });

    await expect(gone.backendDeleted("ses_a")).resolves.toBe("torn_down");
    expect(tornDown).toEqual(["ses_a"]);
  });

  it("does nothing for a session it has no row for (a subagent, or a /kill that already tore it down)", async () => {
    const { gone, teardown } = setup({});

    await expect(gone.backendDeleted("ses_missing")).resolves.toBe("absent");
    expect(teardown).not.toHaveBeenCalled();
  });

  it("refuses to tear down a goose row: the plugin only speaks for opencode sessions", async () => {
    const { gone, teardown } = setup({
      gse_x: { backendKind: "goose-acp", boundTopicKey: null },
      ses_p: { backendKind: "goose-pull", boundTopicKey: null },
    });

    await expect(gone.backendDeleted("gse_x")).resolves.toBe("refused");
    await expect(gone.backendDeleted("ses_p")).resolves.toBe("refused");
    expect(teardown).not.toHaveBeenCalled();
  });

  it("refuses to tear down a row pinned to a named topic", async () => {
    const { gone, teardown } = setup({ ses_b: { backendKind: "opencode-plugin-direct", boundTopicKey: "k" } });

    await expect(gone.backendDeleted("ses_b")).resolves.toBe("refused");
    expect(teardown).not.toHaveBeenCalled();
  });

  it("defers to an in-flight /kill, so the kill's reply lands before the channel is archived", async () => {
    const { gone, tornDown, live } = setup({ ses_k: OPENCODE });
    let releaseKill!: () => void;
    const killBody = new Promise<void>((resolve) => { releaseKill = resolve; });

    const kill = gone.runKill("ses_k", async () => {
      await killBody;
      // The kill's own teardown, after its reply.
      live.delete("ses_k");
      tornDown.push("kill:ses_k");
    });

    await expect(gone.backendDeleted("ses_k")).resolves.toBe("deferred");
    expect(tornDown).toEqual([]);

    releaseKill();
    await kill;
    expect(tornDown).toEqual(["kill:ses_k"]);
  });

  it("tears down after a kill that did not, when the TUI-side delete was deferred to it", async () => {
    // The kill's delete call failed (a timeout, say) though opencode did delete the session, so
    // the kill answered "Failed to kill" and left the row. The deferred event must not be lost.
    const { gone, tornDown } = setup({ ses_k: OPENCODE });
    let releaseKill!: () => void;
    const killBody = new Promise<void>((resolve) => { releaseKill = resolve; });

    const kill = gone.runKill("ses_k", () => killBody);
    await expect(gone.backendDeleted("ses_k")).resolves.toBe("deferred");

    releaseKill();
    await kill;
    expect(tornDown).toEqual(["ses_k"]);
  });

  it("does not tear down after a kill when no delete event was deferred", async () => {
    const { gone, teardown } = setup({ ses_k: OPENCODE });

    await gone.runKill("ses_k", async () => {});
    expect(teardown).not.toHaveBeenCalled();
  });

  it("still releases the kill guard and runs a deferred teardown when the kill throws", async () => {
    const { gone, tornDown } = setup({ ses_k: OPENCODE });
    let failKill!: (e: Error) => void;
    const killBody = new Promise<void>((_r, reject) => { failKill = reject; });

    const kill = gone.runKill("ses_k", () => killBody);
    await gone.backendDeleted("ses_k");
    failKill(new Error("boom"));

    await expect(kill).rejects.toThrow("boom");
    expect(tornDown).toEqual(["ses_k"]);
    await expect(gone.backendDeleted("ses_k")).resolves.toBe("absent");
  });

  it("keeps the guard until the last of two overlapping kills for one session finishes", async () => {
    const { gone } = setup({ ses_k: OPENCODE });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = gone.runKill("ses_k", () => new Promise<void>((r) => { releaseFirst = r; }));
    const second = gone.runKill("ses_k", () => new Promise<void>((r) => { releaseSecond = r; }));

    releaseFirst();
    await first;
    await expect(gone.backendDeleted("ses_k")).resolves.toBe("deferred");

    releaseSecond();
    await second;
  });

  it("a teardown failure is logged and reported, never thrown", async () => {
    const live = new Map<string, SessionGoneRow>([["ses_a", OPENCODE]]);
    const gone = new SessionGone({
      getSession: (id) => live.get(id) ?? null,
      teardown: async () => { throw new Error("worker down"); },
      log: () => {},
    });

    await expect(gone.backendDeleted("ses_a")).resolves.toBe("teardown_failed");
  });
});

import { describe, it, expect, vi } from "vitest";
import { executeGooseKill, pickKillReply, type GooseKillDeps } from "../src/goose/kill-control.js";
import type { SessionRecord } from "../src/storage/types.js";

describe("pickKillReply", () => {
  it("honk + sent: says asked honkd to cancel, not cancelled", () => {
    const text = pickKillReply("sent", true, true);
    expect(text).toContain("Asked honkd to cancel");
    expect(text).not.toContain("which cancels");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });

  it("honk + failed: keeps honest may still be running in honkd text and mentions cancel could not be sent", () => {
    const text = pickKillReply("failed", true, true);
    expect(text).toContain("Could not send cancel to honkd");
    expect(text).toContain("may still be running in honkd");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });

  it("bare + sent: cancel sent and connection dropped, cancels running turn", () => {
    const text = pickKillReply("sent", false, true);
    expect(text).toContain("That dropped pigeon's connection to goose, which cancels any turn that was running");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });

  it("bare + no-connection: connection dropped, cancels running turn", () => {
    const text = pickKillReply("no-connection", false, true);
    expect(text).toContain("That dropped pigeon's connection to goose, which cancels any turn that was running");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });

  it("bare + failed: keeps today's bare wording", () => {
    const text = pickKillReply("failed", false, true);
    expect(text).toContain("That dropped pigeon's connection to goose, which cancels any turn that was running");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });

  it("isHonk unknown when connect failed: uses cautious wording that turn may still be running", () => {
    const text = pickKillReply("failed", false, false);
    expect(text).toContain("Could not send cancel; the turn may still be running;");
    expect(text).toContain("pigeon has stopped tracking the session.");
  });
});

describe("executeGooseKill", () => {
  function makeDeps(overrides?: Partial<GooseKillDeps>) {
    const events: string[] = [];
    const sessionRecord = {
      sessionId: "gse_123",
      backendKind: "goose",
      backendSessionId: "20261012_1",
      createdAt: 1000,
      updatedAt: 1000,
      lastSeen: 1000,
    } as SessionRecord;

    let cancelOutcome: "sent" | "no-connection" | "failed" = "sent";
    let isHonk = false;
    let isHonkKnown = true;

    const fakeRunner = {
      get isHonk() { return isHonk; },
      get isHonkKnown() { return isHonkKnown; },
      cancel: vi.fn(async () => {
        events.push("cancel");
        return cancelOutcome;
      }),
    };

    const deps: GooseKillDeps = {
      storage: {
        sessions: {
          get: vi.fn((id: string) => {
            events.push(`sessions.get:${id}`);
            return id === "gse_123" ? sessionRecord : undefined;
          }),
          delete: vi.fn((id: string) => {
            events.push(`sessions.delete:${id}`);
          }),
        },
        assignments: {
          delete: vi.fn((id: string) => {
            events.push(`assignments.delete:${id}`);
          }),
        },
      },
      gooseRunners: {
        get: vi.fn((_sess: SessionRecord) => {
          events.push("gooseRunners.get");
          return fakeRunner as any;
        }),
        drop: vi.fn((id: string) => {
          events.push(`gooseRunners.drop:${id}`);
        }),
      } as any,
      poller: {
        unregisterSession: vi.fn(async (id: string) => {
          events.push(`poller.unregisterSession:${id}`);
        }),
      },
      reply: vi.fn(async (text: string) => {
        events.push(`reply:${text}`);
      }),
      ...overrides,
    };

    return {
      deps,
      events,
      fakeRunner,
      setCancelOutcome: (o: "sent" | "no-connection" | "failed") => { cancelOutcome = o; },
      setIsHonk: (h: boolean, known = true) => { isHonk = h; isHonkKnown = known; },
    };
  }

  it("sends cancel before dropping runner and deleting session records (ordering)", async () => {
    const { deps, events } = makeDeps();

    await executeGooseKill("gse_123", deps);

    expect(events).toEqual([
      "sessions.get:gse_123",
      "gooseRunners.get",
      "cancel",
      "gooseRunners.drop:gse_123",
      "sessions.delete:gse_123",
      "assignments.delete:gse_123",
      "poller.unregisterSession:gse_123",
      expect.stringMatching(/^reply:/),
    ]);
  });

  it("reads the session record BEFORE the delete", async () => {
    const { deps, events } = makeDeps();

    await executeGooseKill("gse_123", deps);

    const getIdx = events.indexOf("sessions.get:gse_123");
    const delIdx = events.indexOf("sessions.delete:gse_123");
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(getIdx);
  });

  it("calls gooseRunners.get so a runner exists even after pigeon restart", async () => {
    const { deps } = makeDeps();

    await executeGooseKill("gse_123", deps);

    expect(deps.gooseRunners?.get).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "gse_123" }));
  });

  it("delivers the honk+sent reply when honkd cancel was sent", async () => {
    const { deps, setCancelOutcome, setIsHonk } = makeDeps();
    setIsHonk(true);
    setCancelOutcome("sent");

    await executeGooseKill("gse_123", deps);

    expect(deps.reply).toHaveBeenCalledWith(
      "Session closed. Asked honkd to cancel any running turn; pigeon has stopped tracking the session.",
    );
  });

  it("delivers the honk+failed reply when honkd cancel failed", async () => {
    const { deps, setCancelOutcome, setIsHonk } = makeDeps();
    setIsHonk(true);
    setCancelOutcome("failed");

    await executeGooseKill("gse_123", deps);

    expect(deps.reply).toHaveBeenCalledWith(
      "Session closed. Could not send cancel to honkd; the turn may still be running in honkd; pigeon has stopped tracking the session.",
    );
  });

  it("delivers the bare+sent reply when bare cancel was sent", async () => {
    const { deps, setCancelOutcome, setIsHonk } = makeDeps();
    setIsHonk(false, true);
    setCancelOutcome("sent");

    await executeGooseKill("gse_123", deps);

    expect(deps.reply).toHaveBeenCalledWith(
      "Session closed. That dropped pigeon's connection to goose, which cancels any turn that was running; pigeon has stopped tracking the session.",
    );
  });

  it("delivers the cautious reply when isHonk is unknown and connect failed", async () => {
    const { deps, setCancelOutcome, setIsHonk } = makeDeps();
    setIsHonk(false, false);
    setCancelOutcome("failed");

    await executeGooseKill("gse_123", deps);

    expect(deps.reply).toHaveBeenCalledWith(
      "Session closed. Could not send cancel; the turn may still be running; pigeon has stopped tracking the session.",
    );
  });
});

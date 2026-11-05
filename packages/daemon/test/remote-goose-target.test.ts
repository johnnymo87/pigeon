import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { shouldAllowRemoteGooseTarget } from "../src/swarm/remote-goose-target";

describe("shouldAllowRemoteGooseTarget", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newStorage(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  it("returns false and does not call lookup when swarmRelaySend is false or omitted", async () => {
    const s = newStorage();
    const lookup = vi.fn();

    const res1 = await shouldAllowRemoteGooseTarget(s, "gse_remote", null, {
      swarmRelaySend: false,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res1).toBe(false);
    expect(lookup).not.toHaveBeenCalled();

    const res2 = await shouldAllowRemoteGooseTarget(s, "gse_remote", null, {
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res2).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns false and does not call lookup when target is not a gse_ id", async () => {
    const s = newStorage();
    const lookup = vi.fn();

    const res = await shouldAllowRemoteGooseTarget(s, "ses_remote", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns false and does not call lookup when channel is present", async () => {
    const s = newStorage();
    const lookup = vi.fn();

    const res = await shouldAllowRemoteGooseTarget(s, "gse_remote", "my_channel", {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns false and does not call lookup when target has a local row", async () => {
    const s = newStorage();
    s.sessions.upsert({ sessionId: "gse_local", notify: true });
    const lookup = vi.fn();

    const res = await shouldAllowRemoteGooseTarget(s, "gse_local", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails open (returns true) when lookupSessionOwner is not wired", async () => {
    const s = newStorage();

    const res = await shouldAllowRemoteGooseTarget(s, "gse_remote", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: undefined,
    });
    expect(res).toBe(true);
  });

  it("returns false when owner is null (worker 404)", async () => {
    const s = newStorage();
    const lookup = vi.fn().mockResolvedValue(null);

    const res = await shouldAllowRemoteGooseTarget(s, "gse_unknown", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(false);
    expect(lookup).toHaveBeenCalledWith("gse_unknown", expect.any(AbortSignal));
  });

  it("returns false when owner is registered to this machine (stale/reaped local row)", async () => {
    const s = newStorage();
    const lookup = vi.fn().mockResolvedValue({ machineId: "devbox" });

    const res = await shouldAllowRemoteGooseTarget(s, "gse_stale_local", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(false);
  });

  it("returns true when owner is registered to another machine", async () => {
    const s = newStorage();
    const lookup = vi.fn().mockResolvedValue({ machineId: "cloudbox" });

    const res = await shouldAllowRemoteGooseTarget(s, "gse_on_cloudbox", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(true);
  });

  it("fails open (returns true) when lookup throws an error", async () => {
    const s = newStorage();
    const lookup = vi.fn().mockRejectedValue(new Error("network error"));

    const res = await shouldAllowRemoteGooseTarget(s, "gse_remote", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
    });
    expect(res).toBe(true);
  });

  it("fails open (returns true) when lookup times out", async () => {
    const s = newStorage();
    let signalReceived: AbortSignal | undefined;
    const lookup = vi.fn().mockImplementation((_id: string, signal: AbortSignal) => {
      signalReceived = signal;
      return new Promise(() => {}); // never resolves
    });

    const res = await shouldAllowRemoteGooseTarget(s, "gse_remote", null, {
      swarmRelaySend: true,
      machineId: "devbox",
      lookupSessionOwner: lookup,
      lookupTimeoutMs: 50, // short test timeout
    });
    expect(res).toBe(true);
    expect(signalReceived?.aborted).toBe(true);
  });
});

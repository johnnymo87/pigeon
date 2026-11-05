import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { createMarkGooseRemoteReachable } from "../src/goose/remote-reachable";

describe("createMarkGooseRemoteReachable", () => {
  let storage: StorageDb | null = null;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("grant: false registers with worker only without writing pull_sources", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_register_only",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const setSpy = vi.spyOn(s.sessions, "setPullSources");
    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const res = await mark("gse_test_register_only", { grant: false });
    expect(res).toEqual({ marked: false, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();

    const afterRow = s.sessions.get("gse_test_register_only");
    expect(afterRow!.pullSources).toEqual(["telegram-reply"]);
  });

  it("grant: false followed by grant: true does not re-register, only writes pull_sources", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_reg_then_grant",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const res1 = await mark("gse_test_reg_then_grant", { grant: false });
    expect(res1).toEqual({ marked: false, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(1);

    const res2 = await mark("gse_test_reg_then_grant", { grant: true });
    expect(res2).toEqual({ marked: true, registered: "cached" });
    expect(registerMock).toHaveBeenCalledTimes(1);

    const afterRow = s.sessions.get("gse_test_reg_then_grant");
    expect(afterRow!.pullSources).toEqual(["telegram-reply", "swarm", "swarm-remote"]);
  });

  it("grant: false registration failure is retried when grant: true is called", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_reg_retry",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const registerMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "busy" })
      .mockResolvedValueOnce({ ok: true });

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const res1 = await mark("gse_test_reg_retry", { grant: false });
    expect(res1).toEqual({ marked: false, registered: false });
    expect(registerMock).toHaveBeenCalledTimes(1);

    const res2 = await mark("gse_test_reg_retry", { grant: true });
    expect(res2).toEqual({ marked: true, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(2);

    const afterRow = s.sessions.get("gse_test_reg_retry");
    expect(afterRow!.pullSources).toEqual(["telegram-reply", "swarm", "swarm-remote"]);
  });

  it("additive write from NULL pull_sources with grant: true", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_1",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    // Directly in sqlite, pull_sources is NULL after upsert
    const beforeRow = s.sessions.get("gse_test_1");
    expect(beforeRow).not.toBeNull();
    // Storage parses NULL as the default ["telegram-reply"]
    expect(beforeRow!.pullSources).toEqual(["telegram-reply"]);

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
    });

    const res = await mark("gse_test_1", { grant: true });
    expect(res).toEqual({ marked: true, registered: "skipped" });

    const afterRow = s.sessions.get("gse_test_1");
    expect(afterRow!.pullSources).toEqual(["telegram-reply", "swarm", "swarm-remote"]);
  });

  it("additive write from ['telegram-reply', 'swarm']", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_2",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });
    s.sessions.setPullSources("gse_test_2", ["telegram-reply", "swarm"]);

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
    });

    const res = await mark("gse_test_2", { grant: true });
    expect(res).toEqual({ marked: true, registered: "skipped" });

    const afterRow = s.sessions.get("gse_test_2");
    expect(afterRow!.pullSources).toEqual(["telegram-reply", "swarm", "swarm-remote"]);
  });

  it("already-complete list does not call setPullSources", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_3",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });
    s.sessions.setPullSources("gse_test_3", ["telegram-reply", "swarm", "swarm-remote"]);

    const setSpy = vi.spyOn(s.sessions, "setPullSources");

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
    });

    const res = await mark("gse_test_3", { grant: true });
    expect(res).toEqual({ marked: true, registered: "skipped" });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("idempotent second call: register called once, then returns 'cached'", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_4",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const res1 = await mark("gse_test_4", { grant: true });
    expect(res1).toEqual({ marked: true, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(1);

    const res2 = await mark("gse_test_4", { grant: true });
    expect(res2).toEqual({ marked: true, registered: "cached" });
    expect(registerMock).toHaveBeenCalledTimes(1);
  });

  it("skips opencode ses_ id and unknown gse_ id", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "ses_opencode_1",
      backendKind: null,
      backendEndpoint: null,
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const setSpy = vi.spyOn(s.sessions, "setPullSources");

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    // ses_ id
    const resSes = await mark("ses_opencode_1", { grant: true });
    expect(resSes).toEqual({ marked: false, registered: "skipped" });
    expect(registerMock).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();

    // unknown gse_ id
    const resUnknown = await mark("gse_does_not_exist", { grant: true });
    expect(resUnknown).toEqual({ marked: false, registered: "skipped" });
    expect(registerMock).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("skips non-goose row with gse_ id", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_not_goose",
      backendKind: "other-backend",
      backendEndpoint: null,
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const setSpy = vi.spyOn(s.sessions, "setPullSources");

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const res = await mark("gse_not_goose", { grant: true });
    expect(res).toEqual({ marked: false, registered: "skipped" });
    expect(registerMock).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("register returning {ok: false} -> registered: false, not cached, retried next call", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_fail",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const registerMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "registration refused" })
      .mockResolvedValueOnce({ ok: true });

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
      log: (msg, fields) => logs.push({ msg, fields }),
    });

    const res1 = await mark("gse_test_fail", { grant: true });
    expect(res1).toEqual({ marked: true, registered: false });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      {
        msg: "remote-reachable: registration failed",
        fields: { sessionId: "gse_test_fail", reason: "registration refused" },
      },
    ]);

    // Retried next call
    const res2 = await mark("gse_test_fail", { grant: true });
    expect(res2).toEqual({ marked: true, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(2);

    // Third call is cached
    const res3 = await mark("gse_test_fail", { grant: true });
    expect(res3).toEqual({ marked: true, registered: "cached" });
    expect(registerMock).toHaveBeenCalledTimes(2);
  });

  it("register throwing -> registered: false, not cached, retried next call", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_throw",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const registerMock = vi.fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({ ok: true });

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
      log: (msg, fields) => logs.push({ msg, fields }),
    });

    const res1 = await mark("gse_test_throw", { grant: true });
    expect(res1).toEqual({ marked: true, registered: false });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      {
        msg: "remote-reachable: registration failed",
        fields: { sessionId: "gse_test_throw", reason: "network failure" },
      },
    ]);

    const res2 = await mark("gse_test_throw", { grant: true });
    expect(res2).toEqual({ marked: true, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(2);
  });

  it("register that never resolves -> returns within timeout with registered: false", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_timeout",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    let signalSawAbort = false;
    const registerMock = vi.fn((_id: string, _label: string | null, signal: AbortSignal) => {
      signalSawAbort = true;
      signal.addEventListener("abort", () => {
        signalSawAbort = true;
      });
      return new Promise<never>(() => {}); // Never resolves
    });

    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
      timeoutMs: 25,
      log: (msg, fields) => logs.push({ msg, fields }),
    });

    const start = Date.now();
    const res = await mark("gse_test_timeout", { grant: true });
    const elapsed = Date.now() - start;

    expect(res).toEqual({ marked: true, registered: false });
    expect(signalSawAbort).toBe(true);
    expect(elapsed).toBeLessThan(1000); // Definitely completed around 25ms, not hanging
    expect(logs).toEqual([
      {
        msg: "remote-reachable: registration failed",
        fields: { sessionId: "gse_test_timeout", reason: "timeout" },
      },
    ]);
  });

  it("label passed through to register", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_labeled",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      label: "my-coordinator-label",
      notify: true,
    });

    s.sessions.upsert({
      sessionId: "gse_unlabeled",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      label: null,
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    await mark("gse_labeled", { grant: true });
    expect(registerMock).toHaveBeenLastCalledWith(
      "gse_labeled",
      "my-coordinator-label",
      expect.any(AbortSignal),
    );

    await mark("gse_unlabeled", { grant: true });
    expect(registerMock).toHaveBeenLastCalledWith(
      "gse_unlabeled",
      null,
      expect.any(AbortSignal),
    );
  });

  it("never throws if sessions.get throws", async () => {
    const throwingSessions = {
      get: () => {
        throw new Error("sqlite disk I/O error");
      },
      setPullSources: () => true,
    };

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const mark = createMarkGooseRemoteReachable({
      sessions: throwingSessions,
      log: (msg, fields) => logs.push({ msg, fields }),
    });

    const res = await mark("gse_disk_fail", { grant: true });
    expect(res).toEqual({ marked: false, registered: "skipped" });
    expect(logs[0]?.msg).toBe("session lookup failed");
  });

  it("uses default console.warn log when no log dep provided", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_test_log",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registerMock = vi.fn().mockResolvedValue({ ok: false, error: "fail" });
      const mark = createMarkGooseRemoteReachable({
        sessions: s.sessions,
        register: registerMock,
      });

      await mark("gse_test_log", { grant: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[remote-reachable] remote-reachable: registration failed",
        { sessionId: "gse_test_log", reason: "fail" },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("mark.register and mark.grant helper methods behave identically to { grant: false } and { grant: true }", async () => {
    const s = storage!;
    s.sessions.upsert({
      sessionId: "gse_helper_methods",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://localhost:1/acp",
      notify: true,
    });

    const registerMock = vi.fn().mockResolvedValue({ ok: true });
    const mark = createMarkGooseRemoteReachable({
      sessions: s.sessions,
      register: registerMock,
    });

    const resReg = await mark.register("gse_helper_methods");
    expect(resReg).toEqual({ marked: false, registered: true });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(s.sessions.get("gse_helper_methods")!.pullSources).toEqual(["telegram-reply"]);

    const resGrant = await mark.grant("gse_helper_methods");
    expect(resGrant).toEqual({ marked: true, registered: "cached" });
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(s.sessions.get("gse_helper_methods")!.pullSources).toEqual(["telegram-reply", "swarm", "swarm-remote"]);
  });
});

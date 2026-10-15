import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { GooseInflightRecord } from "../src/storage/goose-inflight-repo";

describe("GooseInflightRepository", () => {
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

  function createSession(s: StorageDb, sessionId = "ses_test_1"): void {
    s.sessions.upsert({
      sessionId,
      cwd: "/tmp",
      backendKind: GOOSE_BACKEND_KIND,
    });
  }

  it("persists row with all fields and reads it back", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    const row = {
      commandId: "cmd_100",
      sessionId: "ses_test_1",
      backendSessionId: "20261012_1",
      isHonk: true,
      promptText: "hello goose",
      recoveryAttempts: 2,
      createdAt: 1000,
      updatedAt: 1050,
      lastAliveAt: 1050,
      cleanSuspend: true,
    };

    repo.insert(row);

    const retrieved = repo.get("cmd_100");
    expect(retrieved).toEqual<GooseInflightRecord>({
      commandId: "cmd_100",
      sessionId: "ses_test_1",
      backendSessionId: "20261012_1",
      isHonk: true,
      promptText: "hello goose",
      recoveryAttempts: 2,
      createdAt: 1000,
      updatedAt: 1050,
      lastAliveAt: 1050,
      cleanSuspend: true,
    });
  });

  it("uses defaults for optional fields during insert", () => {
    const s = newStorage();
    createSession(s, "ses_test_2");
    const repo = s.gooseInflight;
    const now = 2000;

    repo.insert(
      {
        commandId: "cmd_200",
        sessionId: "ses_test_2",
        backendSessionId: "20261012_2",
        isHonk: false,
        promptText: "run something",
      },
      now,
    );

    const retrieved = repo.get("cmd_200");
    expect(retrieved).toEqual<GooseInflightRecord>({
      commandId: "cmd_200",
      sessionId: "ses_test_2",
      backendSessionId: "20261012_2",
      isHonk: false,
      promptText: "run something",
      recoveryAttempts: 0,
      createdAt: now,
      updatedAt: now,
      lastAliveAt: now,
      cleanSuspend: false,
    });
  });

  it("deletes a row by commandId", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_300",
      sessionId: "ses_test_1",
      backendSessionId: "20261012_1",
      isHonk: true,
      promptText: "prompt to delete",
    });

    expect(repo.get("cmd_300")).toBeDefined();
    expect(repo.delete("cmd_300")).toBe(true);
    expect(repo.get("cmd_300")).toBeUndefined();
    expect(repo.delete("cmd_300")).toBe(false);
  });

  it("lists all rows oldest first", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    createSession(s, "ses_test_2");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_c",
      sessionId: "ses_test_1",
      backendSessionId: "b3",
      isHonk: true,
      promptText: "third",
      createdAt: 300,
    });
    repo.insert({
      commandId: "cmd_a",
      sessionId: "ses_test_1",
      backendSessionId: "b1",
      isHonk: true,
      promptText: "first",
      createdAt: 100,
    });
    repo.insert({
      commandId: "cmd_b",
      sessionId: "ses_test_2",
      backendSessionId: "b2",
      isHonk: false,
      promptText: "second",
      createdAt: 200,
    });

    const list = repo.listAll();
    expect(list.map((r) => r.commandId)).toEqual(["cmd_a", "cmd_b", "cmd_c"]);
    expect(list[0]!.createdAt).toBe(100);
    expect(list[1]!.createdAt).toBe(200);
    expect(list[2]!.createdAt).toBe(300);
  });

  it("touchAlive updates last_alive_at and updated_at", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_touch",
      sessionId: "ses_test_1",
      backendSessionId: "b1",
      isHonk: true,
      promptText: "touch me",
      createdAt: 1000,
      updatedAt: 1000,
      lastAliveAt: 1000,
    });

    repo.touchAlive("cmd_touch", 1060);

    const updated = repo.get("cmd_touch")!;
    expect(updated.lastAliveAt).toBe(1060);
    expect(updated.updatedAt).toBe(1060);
    expect(updated.createdAt).toBe(1000);
  });

  it("markSuspended sets clean_suspend=1, last_alive_at=now, updated_at=now, and resets recovery_attempts=0", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_susp",
      sessionId: "ses_test_1",
      backendSessionId: "b1",
      isHonk: true,
      promptText: "suspend me",
      recoveryAttempts: 3,
      createdAt: 1000,
      updatedAt: 1000,
      lastAliveAt: 1000,
      cleanSuspend: false,
    });

    repo.markSuspended("cmd_susp", 1200);

    const suspended = repo.get("cmd_susp")!;
    expect(suspended.cleanSuspend).toBe(true);
    expect(suspended.lastAliveAt).toBe(1200);
    expect(suspended.updatedAt).toBe(1200);
    expect(suspended.recoveryAttempts).toBe(0);
    expect(suspended.createdAt).toBe(1000);
  });

  it("markResumed sets clean_suspend=0, last_alive_at=now, updated_at=now", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_resume",
      sessionId: "ses_test_1",
      backendSessionId: "b1",
      isHonk: true,
      promptText: "resume me",
      createdAt: 1000,
      updatedAt: 1000,
      lastAliveAt: 1000,
      cleanSuspend: true,
    });

    repo.markResumed("cmd_resume", 1500);

    const resumed = repo.get("cmd_resume")!;
    expect(resumed.cleanSuspend).toBe(false);
    expect(resumed.lastAliveAt).toBe(1500);
    expect(resumed.updatedAt).toBe(1500);
    expect(resumed.createdAt).toBe(1000);
  });

  it("bumpAttempts increments recovery_attempts and updates updated_at", () => {
    const s = newStorage();
    createSession(s, "ses_test_1");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_bump",
      sessionId: "ses_test_1",
      backendSessionId: "b1",
      isHonk: true,
      promptText: "bump me",
      recoveryAttempts: 0,
      createdAt: 1000,
      updatedAt: 1000,
      lastAliveAt: 1000,
    });

    const attempts1 = repo.bumpAttempts("cmd_bump", 1100);
    expect(attempts1).toBe(1);

    const row1 = repo.get("cmd_bump")!;
    expect(row1.recoveryAttempts).toBe(1);
    expect(row1.updatedAt).toBe(1100);

    const attempts2 = repo.bumpAttempts("cmd_bump", 1200);
    expect(attempts2).toBe(2);

    const row2 = repo.get("cmd_bump")!;
    expect(row2.recoveryAttempts).toBe(2);
    expect(row2.updatedAt).toBe(1200);
  });

  it("cascades deletion when session is deleted", () => {
    const s = newStorage();
    createSession(s, "ses_cascade");
    const repo = s.gooseInflight;

    repo.insert({
      commandId: "cmd_cascade",
      sessionId: "ses_cascade",
      backendSessionId: "b_casc",
      isHonk: true,
      promptText: "cascade test",
    });

    expect(repo.get("cmd_cascade")).toBeDefined();

    // Delete session from sessions table
    s.sessions.delete("ses_cascade");

    expect(repo.get("cmd_cascade")).toBeUndefined();
  });
});

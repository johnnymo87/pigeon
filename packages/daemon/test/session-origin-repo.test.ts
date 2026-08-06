import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("SessionOriginRepository", () => {
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

  it("returns null for an unknown session", () => {
    const s = newStorage();
    expect(s.sessionOrigins.get("ses_nope")).toBeNull();
  });

  it("records a declared origin", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    expect(s.sessionOrigins.get("ses_a")).toEqual({
      sessionId: "ses_a",
      origin: "lgtm",
      notifyPolicy: "errors-only",
      source: "declared",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("is idempotent: re-recording the same declared row does not change createdAt", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      2_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.updatedAt).toBe(2_000);
  });

  it("a declared row is never downgraded by an inferred write", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "guess", notifyPolicy: "none", source: "inferred" },
      2_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.origin).toBe("lgtm");
    expect(row?.notifyPolicy).toBe("errors-only");
    expect(row?.source).toBe("declared");
  });

  it("a declared write DOES overwrite an inferred row", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "guess", notifyPolicy: "none", source: "inferred" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      2_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.source).toBe("declared");
    expect(row?.notifyPolicy).toBe("errors-only");
  });

  it("clear() removes the row", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    expect(s.sessionOrigins.clear("ses_a")).toBe(true);
    expect(s.sessionOrigins.get("ses_a")).toBeNull();
    expect(s.sessionOrigins.clear("ses_a")).toBe(false);
  });

  it("survives deletion of the sessions row (no FK cascade)", () => {
    const s = newStorage();
    s.sessions.upsert({ sessionId: "ses_a", notify: true }, 1_000);
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );

    s.sessions.delete("ses_a");

    // LOAD-BEARING: the session reaper (session-reaper.ts:31-35) and dead-session
    // cleanup (worker/command-ingest.ts:1085,1150) both delete the sessions row.
    // lgtm re-awakens the SAME session id afterwards via /swarm/send, and it must
    // still be quiet. A future "hygiene" FK cascade here silently reintroduces the
    // notification noise this whole epic exists to remove.
    expect(s.sessionOrigins.get("ses_a")?.notifyPolicy).toBe("errors-only");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { isOriginSource } from "../src/storage/session-origin-repo";

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
      declaredAt: 1_000,
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

  it("refreshes payload when re-recorded with an equal-or-stronger source (declared errors-only then declared none)", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm-v2", notifyPolicy: "none", source: "declared" },
      2_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.origin).toBe("lgtm-v2");
    expect(row?.notifyPolicy).toBe("none");
    expect(row?.source).toBe("declared");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.updatedAt).toBe(2_000);
  });

  it("degrades unrecognized notify_policy to 'all'", () => {
    const s = newStorage();
    // LOAD-BEARING: Fail-open house rule at app.ts:113 — a corrupt row must never silence real work.
    s.db
      .prepare(
        `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("ses_corrupt_policy", "lgtm", "banana", "declared", 1_000, 1_000);

    const row = s.sessionOrigins.get("ses_corrupt_policy");
    expect(row?.notifyPolicy).toBe("all");
  });

  it("degrades unrecognized source to 'inferred'", () => {
    const s = newStorage();
    // LOAD-BEARING: Fail-open house rule at app.ts:113 — a corrupt row must never silence real work.
    s.db
      .prepare(
        `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("ses_corrupt_source", "lgtm", "errors-only", "wat", 1_000, 1_000);

    const row = s.sessionOrigins.get("ses_corrupt_source");
    expect(row?.source).toBe("inferred");
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

  it("does NOT recognize 'override' as a valid origin source (degrades to 'inferred' on read)", () => {
    expect(isOriginSource("override")).toBe(false);
  });

  it("legacy override row degrade: a stored row with source='override' and notify_policy='all' degrades safely on read", () => {
    const s = newStorage();
    s.db
      .prepare(
        `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at, declared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("ses_legacy_override", "user:enable-notify", "all", "override", 1_000, 1_000, 1_000);

    const row = s.sessionOrigins.get("ses_legacy_override");
    expect(row).toEqual({
      sessionId: "ses_legacy_override",
      origin: "user:enable-notify",
      notifyPolicy: "all",
      source: "inferred",
      createdAt: 1_000,
      updatedAt: 1_000,
      declaredAt: 1_000,
    });
  });

  it("a declared write overwrites a legacy 'override' row that degraded to 'inferred'", () => {
    const s = newStorage();
    s.db
      .prepare(
        `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at, declared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("ses_legacy_override", "user:enable-notify", "all", "override", 1_000, 1_000, 1_000);

    s.sessionOrigins.record(
      { sessionId: "ses_legacy_override", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      2_000,
    );

    const row = s.sessionOrigins.get("ses_legacy_override");
    expect(row?.origin).toBe("lgtm");
    expect(row?.notifyPolicy).toBe("errors-only");
    expect(row?.source).toBe("declared");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.updatedAt).toBe(2_000);
  });

  it("new row gets declaredAt = createdAt = now", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.declaredAt).toBe(1_000);
    expect(row?.updatedAt).toBe(1_000);
  });

  it("genuine re-declaration preserves createdAt and updates declaredAt and updatedAt", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      5_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.declaredAt).toBe(5_000);
    expect(row?.updatedAt).toBe(5_000);
  });

  it("rank-guard reject path leaves declaredAt unchanged", () => {
    const s = newStorage();
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );
    s.sessionOrigins.record(
      { sessionId: "ses_a", origin: "guess", notifyPolicy: "none", source: "inferred" },
      5_000,
    );
    const row = s.sessionOrigins.get("ses_a");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.declaredAt).toBe(1_000);
    expect(row?.updatedAt).toBe(1_000);
  });

  it("get() falls back to createdAt when declared_at is NULL in the DB", () => {
    const s = newStorage();
    s.db
      .prepare(
        `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at, declared_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run("ses_legacy", "lgtm", "errors-only", "declared", 1_000, 2_000);

    const row = s.sessionOrigins.get("ses_legacy");
    expect(row?.createdAt).toBe(1_000);
    expect(row?.declaredAt).toBe(1_000);
  });
});

/**
 * `GET /swarm/goose-sessions` (pigeon-a0o8): the goose sessions a local swarm_send reaches,
 * coordinators marked, for swarm_list. opencode's own session list cannot show them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";

const NOW = 1_800_000_000_000;

describe("GET /swarm/goose-sessions", () => {
  let storage: StorageDb;
  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });
  afterEach(() => storage.db.close());

  const list = async () => {
    const res = await createApp(storage, { nowFn: () => NOW })(new Request("http://localhost/swarm/goose-sessions"));
    expect(res.status).toBe(200);
    return ((await res.json()) as { sessions: Array<Record<string, unknown>> }).sessions;
  };

  function goose(id: string, over: { endpoint?: string | null; key?: string; label?: string; seen?: number } = {}) {
    storage.sessions.upsert(
      {
        sessionId: id,
        backendKind: GOOSE_BACKEND_KIND,
        backendEndpoint: over.endpoint === undefined ? "ws://127.0.0.1:4280/acp" : over.endpoint,
        label: over.label ?? id,
        cwd: "/tmp",
      },
      over.seen ?? NOW,
    );
    if (over.key) storage.sessions.pinTopicKey(id, over.key, over.seen ?? NOW);
  }

  it("lists reachable goose sessions, coordinators first with their program", async () => {
    goose("gse_chat0000000001", { seen: NOW });
    goose("gse_coord000000001", { key: "stallwatch:eternal-machinery", label: "📋 eternal-machinery", seen: NOW - 5_000 });
    storage.sessions.upsert({ sessionId: "ses_opencode000001" }, NOW);

    expect(await list()).toEqual([
      {
        session_id: "gse_coord000000001",
        label: "📋 eternal-machinery",
        title: null,
        cwd: "/tmp",
        last_seen: NOW - 5_000,
        program: "eternal-machinery",
        rotation_pending: false,
      },
      expect.objectContaining({ session_id: "gse_chat0000000001", program: null, rotation_pending: false }),
    ]);
  });

  it("leaves out goose rows a send cannot reach, and does not count a non-tag binding as a coordinator", async () => {
    goose("gse_nomailbox00001", { endpoint: null });
    goose("gse_mailbox0000001", { endpoint: null });
    storage.sessions.setPullSources("gse_mailbox0000001", ["telegram-reply", "swarm"], NOW);
    goose("gse_notices0000001", { key: "stallwatch:_notices" });
    const ids = (await list()).map((s) => [s.session_id, s.program]);
    expect(ids).toEqual(expect.arrayContaining([["gse_mailbox0000001", null], ["gse_notices0000001", null]]));
    expect(ids).toHaveLength(2);
  });

  it("marks both rows of a program whose rebind has not succeeded yet", async () => {
    goose("gse_coordOld000001", { key: "stallwatch:pigeon" });
    goose("gse_coordNew000001", { key: "stallwatch:pigeon" });
    expect((await list()).map((s) => s.rotation_pending)).toEqual([true, true]);
  });
});

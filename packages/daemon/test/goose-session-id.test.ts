import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { gooseSessionId, uuidV5 } from "../src/goose/session-id";
import { registerGooseSession } from "../src/goose/register-session";
import { ensureGooseSwarmMailbox } from "../src/goose/swarm-mailbox";
import { ingestGooseLaunchCommand } from "../src/goose/launch-ingest";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";

/**
 * pigeon-k0qn.13.4: a goose session's pigeon id is derived, not random.
 *
 * Before this, every registration of a goose session with no live row minted a
 * fresh random `gse_`. So a row that was reaped (7 days idle) or deleted and then
 * registered again came back under a NEW address: senders holding the old id were
 * told it was "not on this machine", and mail already banked in `pull_inbox` under
 * the old id could never be drained again. Deriving the id from
 * `<machineId>:<gooseId>` makes the address a property of the goose session, so
 * re-creating the row reconnects it to both.
 */

const GSE_ID = /^gse_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("uuidV5", () => {
  it("matches the RFC 4122 v5 reference vector (DNS namespace, www.example.com)", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });
});

describe("gooseSessionId", () => {
  it("is a complete gse_<uuid>, the shape the arbiter accepts as a whole id", () => {
    expect(gooseSessionId("cloudbox", "20261028_1")).toMatch(GSE_ID);
  });

  it("is stable for the same machine and goose id", () => {
    expect(gooseSessionId("cloudbox", "20261028_1")).toBe(gooseSessionId("cloudbox", "20261028_1"));
  });

  /**
   * goose numbers sessions per machine per day, so every machine's first session
   * of a day is `YYYYMMDD_1`. The machine must be in the hash or two machines'
   * sessions collide in the worker's global sessions table.
   */
  it("differs across machines for the same goose id", () => {
    expect(gooseSessionId("cloudbox", "20261028_1")).not.toBe(gooseSessionId("devbox", "20261028_1"));
  });

  it("differs across goose ids on one machine", () => {
    expect(gooseSessionId("cloudbox", "20261028_1")).not.toBe(gooseSessionId("cloudbox", "20261028_2"));
  });

  it("hashes a missing machine id as the empty string, still stable", () => {
    expect(gooseSessionId(null, "20261028_1")).toBe(gooseSessionId(null, "20261028_1"));
    expect(gooseSessionId(null, "20261028_1")).toBe(gooseSessionId("", "20261028_1"));
    expect(gooseSessionId(null, "20261028_1")).toMatch(GSE_ID);
  });
});

describe("goose registration mints the derived id", () => {
  let storage: StorageDb | null = null;
  afterEach(() => {
    if (storage) { storage.db.close(); storage = null; }
  });

  function newApp(machineId: string | undefined = "cloudbox") {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => 1_000, machineId });
  }

  function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
    return app(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("POST /goose/sessions returns gse_ derived from the daemon's machine id", async () => {
    const app = newApp("cloudbox");
    const res = await post(app, "/goose/sessions", { session_id: "20261028_1", endpoint: "ws://a/acp" });
    const json = (await res.json()) as Record<string, string>;
    expect(json.session_id).toBe(gooseSessionId("cloudbox", "20261028_1"));
  });

  it("POST /goose/swarm-mailbox returns the same id as /goose/sessions would", async () => {
    const app = newApp("cloudbox");
    const res = await post(app, "/goose/swarm-mailbox", { session_id: "20261028_1", endpoint: "ws://a/acp" });
    const json = (await res.json()) as Record<string, string>;
    expect(json.session_id).toBe(gooseSessionId("cloudbox", "20261028_1"));
  });

  /** The bug itself: delete the row, register again, and the address and the mail come back. */
  it("a deleted goose row re-registers under the same id and its banked mail drains again", async () => {
    const app = newApp("cloudbox");
    const first = (await (await post(app, "/goose/swarm-mailbox", {
      session_id: "20261028_1",
      endpoint: "ws://a/acp",
    })).json()) as Record<string, string>;
    const gse = first.session_id!;

    const send = await post(app, "/swarm/send", { from: "ses_sender", to: gse, payload: "hello" });
    expect(send.status).toBe(202);

    // Reaped, or killed.
    storage!.sessions.delete(gse);
    expect(storage!.sessions.get(gse)).toBeNull();

    const again = (await (await post(app, "/goose/swarm-mailbox", {
      session_id: "20261028_1",
      endpoint: "ws://a/acp",
    })).json()) as Record<string, unknown>;
    expect(again.session_id).toBe(gse);
    expect(again.created).toBe(true);

    const claimed = storage!.pullInbox.claim(gse, 2_000);
    expect(claimed.map((r) => r.payload)).toEqual(["hello"]);
  });

  it("registering through /goose/sessions after deletion also lands on the same id", async () => {
    const app = newApp("cloudbox");
    const first = (await (await post(app, "/goose/sessions", {
      session_id: "20261028_1",
      endpoint: "ws://a/acp",
    })).json()) as Record<string, string>;
    storage!.sessions.delete(first.session_id!);

    const again = (await (await post(app, "/goose/sessions", {
      session_id: "20261028_1",
      endpoint: "ws://a/acp",
    })).json()) as Record<string, string>;
    expect(again.session_id).toBe(first.session_id);
  });

  /**
   * Migration: a row minted before this change keeps its random id for as long
   * as it lives. Re-keying it would change the address senders (and stall-watch's
   * coordinator registry) already hold, which is the very failure this fixes.
   */
  it("keeps an existing random-id row rather than re-keying it", async () => {
    const app = newApp("cloudbox");
    storage!.sessions.upsert(
      {
        sessionId: "gse_00000000-0000-4000-8000-000000000001",
        backendKind: GOOSE_BACKEND_KIND,
        backendEndpoint: "ws://a/acp",
        backendSessionId: "20261021_6",
      },
      500,
    );

    for (const path of ["/goose/sessions", "/goose/swarm-mailbox"]) {
      const json = (await (await post(app, path, {
        session_id: "20261021_6",
        endpoint: "ws://a/acp",
      })).json()) as Record<string, string>;
      expect(json.session_id).toBe("gse_00000000-0000-4000-8000-000000000001");
    }
    expect(storage!.sessions.get(gooseSessionId("cloudbox", "20261021_6"))).toBeNull();
  });
});

describe("a row already sitting at the derived id for a different goose session", () => {
  let storage: StorageDb | null = null;
  afterEach(() => {
    if (storage) { storage.db.close(); storage = null; }
  });

  /**
   * Cannot arise from a hash collision in practice; it can arise from a hand-edited
   * row or a machine-id change that reuses another machine's name. Either way an
   * upsert would silently repoint a live session at a different goose session.
   */
  it("registerGooseSession refuses instead of overwriting it", () => {
    storage = openStorageDb(":memory:");
    const squatted = gooseSessionId("cloudbox", "20261028_1");
    storage.sessions.upsert(
      { sessionId: squatted, backendKind: GOOSE_BACKEND_KIND, backendSessionId: "20261028_9", backendEndpoint: "ws://x/acp" },
      500,
    );

    const res = registerGooseSession(
      storage.sessions,
      { machineId: "cloudbox", backendSessionId: "20261028_1", endpoint: "ws://a/acp" },
      1_000,
    );
    expect(res.ok).toBe(false);
    expect(storage.sessions.get(squatted)?.backendSessionId).toBe("20261028_9");
  });

  it("ensureGooseSwarmMailbox refuses instead of overwriting it", () => {
    storage = openStorageDb(":memory:");
    const squatted = gooseSessionId("cloudbox", "20261028_1");
    storage.sessions.upsert(
      { sessionId: squatted, backendKind: GOOSE_BACKEND_KIND, backendSessionId: "20261028_9", backendEndpoint: "ws://x/acp" },
      500,
    );

    const res = ensureGooseSwarmMailbox(
      storage.sessions,
      { machineId: "cloudbox", backendSessionId: "20261028_1", endpoint: "ws://a/acp" },
      1_000,
    );
    expect(res).toMatchObject({ ok: false, statusCode: 409 });
    expect(storage.sessions.get(squatted)?.backendSessionId).toBe("20261028_9");
  });
});

describe("/launch --backend goose", () => {
  it("registers the minted goose session under the derived id", async () => {
    const storage = openStorageDb(":memory:");
    await ingestGooseLaunchCommand({
      commandId: "cmd-1",
      directory: "/tmp/proj",
      prompt: "do the thing",
      chatId: "chat-1",
      machineId: "devbox",
      acpUrl: "ws://127.0.0.1:1/acp",
      sessions: storage.sessions,
      now: () => 1_000,
      reachability: async () => ({ kind: "ok" }),
      createMintClient: () => ({
        connect: async () => {},
        newSession: async () => "20261028_1",
        close: () => {},
      }),
      runnerFor: () => ({ deliver: async () => ({ ok: true as const }) }),
      sendTelegramReply: async () => {},
      mintTimeoutMs: 5_000,
    });
    const row = storage.sessions.get(gooseSessionId("devbox", "20261028_1"));
    expect(row?.backendSessionId).toBe("20261028_1");
    storage.db.close();
  });
});

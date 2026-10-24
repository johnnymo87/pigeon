/**
 * Cross-machine relay end to end (pigeon-k0qn.6 + .7): two daemons (devbox sends, cloudbox
 * receives) against the REAL worker relay and poll code, running on a better-sqlite3 shim of the
 * D1 API with the production `d1-schema.sql`. Nothing about the wire is faked.
 *
 * The worker modules are loaded by a runtime path so the daemon's typecheck does not follow them
 * into Cloudflare's types.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter } from "../src/swarm/arbiter";
import { processRelayItems } from "../src/swarm/relay-receiver";
import { notifySenderOfFailure } from "../src/swarm/notify-sender";
import { RelayFailSender } from "../src/swarm/relay-fail-sender";
import { RelayClient, relayPollHeader } from "../src/worker/relay-client";
import { Poller } from "../src/worker/poller";
import { bankOrInsertSwarmMessage } from "../src/swarm/bank-or-insert";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = resolve(here, "../../worker/src");

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
let handleRelay: AnyFn, handleRelayAck: AnyFn, handleRelayFail: AnyFn, handlePollNext: AnyFn, sha256Hex: AnyFn;
let clearCredentialCache: AnyFn;

beforeAll(async () => {
  const relayPath = `${WORKER_SRC}/relay.ts`;
  const pollPath = `${WORKER_SRC}/poll.ts`;
  const credPath = `${WORKER_SRC}/credentials.ts`;
  const relay = await import(/* @vite-ignore */ relayPath);
  const poll = await import(/* @vite-ignore */ pollPath);
  const cred = await import(/* @vite-ignore */ credPath);
  ({ handleRelay, handleRelayAck, handleRelayFail } = relay);
  ({ handlePollNext } = poll);
  ({ sha256Hex, clearCredentialCache } = cred);
});

/** The slice of the D1 API the worker's relay and poll code use, over better-sqlite3. */
function d1(db: BetterSqlite3.Database) {
  const make = (sql: string, args: unknown[] = []): any => {
    const runSync = () => {
      const s = db.prepare(sql);
      if (s.reader) return { results: s.all(...(args as never[])), meta: { changes: 0 } };
      return { results: [], meta: { changes: s.run(...(args as never[])).changes } };
    };
    return {
      bind: (...a: unknown[]) => make(sql, a),
      runSync,
      run: async () => runSync(),
      all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
      async first() {
        const s = db.prepare(sql);
        if (!s.reader) {
          s.run(...(args as never[]));
          return null;
        }
        return (s.get(...(args as never[])) as unknown) ?? null;
      },
    };
  };
  return {
    prepare: (sql: string) => make(sql),
    batch: async (stmts: any[]) => db.transaction(() => stmts.map((s) => s.runSync()))(),
    exec: async (sql: string) => void db.exec(sql),
  };
}

const KEY_DEVBOX = "pgk_" + "D".repeat(43);
const KEY_CLOUDBOX = "pgk_" + "C".repeat(43);
const SENDER = "ses_senderOnDevbox00000000001";
const TARGET = "ses_targetOnCloudbox000000001";
const PULL_TARGET = "ses_pullOnCloudbox00000000001";

interface World {
  worker: BetterSqlite3.Database;
  devbox: StorageDb;
  cloudbox: StorageDb;
  devArbiter: SwarmArbiter;
  cloudArbiter: SwarmArbiter;
  devPoller: Poller;
  cloudPoller: Poller;
  cloudFails: RelayFailSender;
  sendPrompt: ReturnType<typeof vi.fn>;
  /** Test hooks: lose the next relay response (the POST still lands), or the next cloudbox ack. */
  loseNextRelayResponse: boolean;
  dropNextCloudAck: boolean;
}

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) {
    w.worker.close();
    w.devbox.db.close();
    w.cloudbox.db.close();
  }
  worlds = [];
});

async function world(): Promise<World> {
  clearCredentialCache();
  const workerDb = new BetterSqlite3(":memory:");
  workerDb.exec(readFileSync(`${WORKER_SRC}/d1-schema.sql`, "utf8"));
  const DB = d1(workerDb);
  const env = { DB, CCR_API_KEY: "shared-key", SHARED_KEY_REFUSED_MACHINES: "devbox,cloudbox" };
  const now = Date.now();
  for (const [key, machine] of [[KEY_DEVBOX, "devbox"], [KEY_CLOUDBOX, "cloudbox"]] as const) {
    workerDb
      .prepare("INSERT INTO machine_credentials (key_sha256, machine_id, created_at) VALUES (?, ?, ?)")
      .run(await sha256Hex(key), machine, now);
  }
  for (const [session, machine] of [[SENDER, "devbox"], [TARGET, "cloudbox"], [PULL_TARGET, "cloudbox"]]) {
    workerDb
      .prepare("INSERT INTO sessions (session_id, machine_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(session, machine, now, now);
  }

  // The worker's router, reduced to the routes the relay uses.
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/swarm/relay") return handleRelay(DB, env, request);
    if (path === "/swarm/relay/ack") return handleRelayAck(DB, env, request);
    if (path === "/swarm/relay/fail") return handleRelayFail(DB, env, request);
    const next = /^\/machines\/([^/]+)\/next$/.exec(path);
    if (next) return handlePollNext(DB, env, request, decodeURIComponent(next[1]!));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const devbox = openStorageDb(":memory:");
  const cloudbox = openStorageDb(":memory:");
  devbox.sessions.upsert({ sessionId: SENDER, label: "relay work" });
  cloudbox.sessions.upsert({ sessionId: TARGET });
  cloudbox.sessions.upsert({ sessionId: PULL_TARGET, backendKind: "goose-pull" });
  cloudbox.sessions.setPullSources(PULL_TARGET, ["swarm"]);

  const devClient = new RelayClient({ workerUrl: "https://worker", apiKey: KEY_DEVBOX, fetchFn });
  const cloudClient = new RelayClient({ workerUrl: "https://worker", apiKey: KEY_CLOUDBOX, fetchFn });
  const sendPrompt = vi.fn(async () => {});
  const quiet = () => {};

  const devArbiter = new SwarmArbiter({
    storage: devbox,
    clientForSession: () => ({ sendPrompt: vi.fn() }),
    directoryForSession: async () => "/x",
    directoryMissing: () => false,
    localityOf: async (id) => (devbox.sessions.get(id) ? "local" : "remote"),
    selfMachineId: "devbox",
    relay: async (body) => {
      const answer = await devClient.relay(body);
      if (!w.loseNextRelayResponse) return answer;
      w.loseNextRelayResponse = false;
      return { kind: "transient", detail: "relay request failed: The operation was aborted due to timeout" };
    },
    log: quiet,
  });
  const cloudArbiter = new SwarmArbiter({
    storage: cloudbox,
    clientForSession: () => ({ sendPrompt }),
    directoryForSession: async () => "/x",
    directoryMissing: () => false,
    localityOf: async (id) => (cloudbox.sessions.get(id) ? "local" : "remote"),
    selfMachineId: "cloudbox",
    log: quiet,
  });

  const poller = (storage: StorageDb, machine: string, key: string, accept: string[], client: RelayClient) =>
    new Poller(
      { workerUrl: "https://worker", apiKey: key, machineId: machine, relayHeader: relayPollHeader(accept, true) },
      {
        onRelayItems: async (items: unknown[]) => {
          const acks = await processRelayItems({ storage, selfMachineId: machine, acceptFrom: accept, log: quiet }, items);
          if (machine === "cloudbox" && w.dropNextCloudAck) {
            w.dropNextCloudAck = false;
            return;
          }
          await client.ack(acks);
        },
      } as never,
      { fetchFn },
    );

  // eslint-disable-next-line prefer-const
  let w: World;
  w = {
    worker: workerDb,
    devbox,
    cloudbox,
    devArbiter,
    cloudArbiter,
    devPoller: poller(devbox, "devbox", KEY_DEVBOX, [], devClient),
    cloudPoller: poller(cloudbox, "cloudbox", KEY_CLOUDBOX, ["devbox"], cloudClient),
    cloudFails: new RelayFailSender(cloudbox, cloudClient),
    sendPrompt,
    loseNextRelayResponse: false,
    dropNextCloudAck: false,
  };
  worlds.push(w);
  return w;
}

const tick = (p: Poller) => (p as unknown as { tick(): Promise<void> }).tick();

function send(w: World, msgId: string, to: string) {
  bankOrInsertSwarmMessage(w.devbox, {
    msgId,
    fromSession: SENDER,
    toSession: to,
    channel: null,
    kind: "chat",
    priority: "normal",
    replyTo: null,
    payload: `payload of ${msgId}`,
  });
}

function devNotices(w: World) {
  return w.devbox.db
    .prepare("SELECT to_session, reply_to, payload FROM swarm_messages WHERE from_session = 'pigeon'")
    .all() as Array<{ to_session: string; reply_to: string; payload: string }>;
}

function relayRow(w: World, msgId: string) {
  return w.worker.prepare("SELECT status, reason FROM swarm_relay WHERE msg_id = ?").get(msgId);
}

describe("cross-machine relay end to end", () => {
  it("delivers devbox → worker → cloudbox, with the sender's identity and machine in the envelope", async () => {
    const w = await world();
    await tick(w.cloudPoller); // cloudbox advertises what it accepts and is online

    send(w, "msg_e2e_1", TARGET);
    await w.devArbiter.processOnce();
    expect(w.devbox.swarm.getByMsgId("msg_e2e_1")).toMatchObject({ state: "handed_off", verifyFamily: "relayed" });

    await tick(w.cloudPoller);
    expect(relayRow(w, "msg_e2e_1")).toEqual({ status: "delivered", reason: null });
    expect(w.cloudbox.swarm.getByMsgId("msg_e2e_1")).toMatchObject({ fromSession: SENDER, state: "queued" });

    await w.cloudArbiter.processOnce();
    expect(w.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = String(w.sendPrompt.mock.calls[0]![2]);
    expect(prompt).toContain(`from="${SENDER}" from_machine="devbox"`);
    expect(prompt).toContain("payload of msg_e2e_1");
  });

  it("reports a late failure on the receiver back to the sender as a failure item", async () => {
    const w = await world();
    await tick(w.cloudPoller);
    send(w, "msg_e2e_2", TARGET);
    await w.devArbiter.processOnce();
    await tick(w.cloudPoller);
    await w.cloudArbiter.processOnce();

    // The watchdog's "handed over, never confirmed" terminal, on cloudbox.
    const row = w.cloudbox.swarm.getByMsgId("msg_e2e_2")!;
    notifySenderOfFailure(w.cloudbox, row, "nudges exhausted", Date.now(), "present");
    expect(w.cloudbox.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages WHERE from_session = 'pigeon'").get()).toEqual({ n: 0 });
    await w.cloudFails.runOnce();

    await tick(w.devPoller);
    expect(w.devbox.swarm.getByMsgId("msg_e2e_2")!.state).toBe("failed");
    const [n] = devNotices(w);
    expect(n).toMatchObject({ to_session: SENDER, reply_to: "msg_e2e_2" });
    expect(n!.payload).toContain("DELIVERY UNCONFIRMED");
    expect(n!.payload).toContain("on cloudbox");

    // The failure item was acked, so a second poll changes nothing.
    await tick(w.devPoller);
    expect(devNotices(w)).toHaveLength(1);
  });

  it("turns a receiver refusal into a do-not-resend notice for the sender", async () => {
    const w = await world();
    await tick(w.cloudPoller);
    send(w, "msg_e2e_3", PULL_TARGET); // opted into swarm, not swarm-remote
    await w.devArbiter.processOnce();
    await tick(w.cloudPoller);
    expect(relayRow(w, "msg_e2e_3")).toEqual({ status: "refused", reason: "remote_not_accepted" });
    expect(w.cloudbox.pullInbox.getIdentity("msg_e2e_3")).toBeNull();

    await tick(w.devPoller);
    const [n] = devNotices(w);
    expect(n!.payload).toContain("accepts swarm messages from its own machine only");
    expect(n!.payload).toContain("Do not resend");
  });

  it("a worker refusal fails the send at once (cloudbox does not accept devbox)", async () => {
    const w = await world();
    w.cloudPoller = new Poller(
      { workerUrl: "https://worker", apiKey: KEY_CLOUDBOX, machineId: "cloudbox", relayHeader: relayPollHeader([], true) },
      {} as never,
      { fetchFn: (w.devPoller as unknown as { fetchFn: typeof fetch }).fetchFn },
    );
    await tick(w.cloudPoller);
    send(w, "msg_e2e_4", TARGET);
    await w.devArbiter.processOnce();
    expect(w.devbox.swarm.getByMsgId("msg_e2e_4")!.state).toBe("failed");
    expect(devNotices(w)[0]!.payload).toContain("does not accept cross-machine messages from this machine");
  });

  it("a lost 202 followed by a fast receiver refusal still tells the sender", async () => {
    const w = await world();
    await tick(w.cloudPoller);
    w.loseNextRelayResponse = true;
    send(w, "msg_e2e_5", PULL_TARGET);
    await w.devArbiter.processOnce();
    // The worker stored it; devbox thinks the attempt failed and will retry.
    expect(w.devbox.swarm.getByMsgId("msg_e2e_5")).toMatchObject({ state: "queued", attempts: 1 });

    await tick(w.cloudPoller); // cloudbox refuses (remote_not_accepted) before devbox retries
    await tick(w.devPoller); // the failure item reaches devbox while its row is still queued

    expect(w.devbox.swarm.getByMsgId("msg_e2e_5")!.state).toBe("failed");
    expect(devNotices(w)).toHaveLength(1);
    expect(devNotices(w)[0]!.payload).toContain("accepts swarm messages from its own machine only");
  });

  it("a lost ack is re-handed after the lease and acked as a duplicate, without a second row", async () => {
    const w = await world();
    await tick(w.cloudPoller);
    send(w, "msg_e2e_6", TARGET);
    await w.devArbiter.processOnce();
    w.dropNextCloudAck = true;
    await tick(w.cloudPoller);
    expect(relayRow(w, "msg_e2e_6")).toEqual({ status: "leased", reason: null });

    w.worker.prepare("UPDATE swarm_relay SET leased_at = leased_at - 61000 WHERE msg_id = ?").run("msg_e2e_6");
    await tick(w.cloudPoller);

    expect(relayRow(w, "msg_e2e_6")).toEqual({ status: "delivered", reason: null });
    expect(w.cloudbox.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages WHERE msg_id = 'msg_e2e_6'").get()).toEqual({ n: 1 });
  });
});

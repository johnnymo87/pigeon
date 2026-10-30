/**
 * Remote launch end to end (pigeon-k0qn.17): two daemons (devbox requests, cloudbox
 * launches) against the REAL worker remote-launch and poll code, running on a better-sqlite3 shim of the
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
import { Poller } from "../src/worker/poller";
import { relayPollHeader } from "../src/worker/relay-client";
import { RemoteLaunchClient } from "../src/worker/remote-launch-client";
import { RemoteLaunchRequester } from "../src/swarm/remote-launch-requester";
import { type LaunchReceiverDeps } from "../src/swarm/remote-launch-receiver";
import { handleLaunchItems } from "../src/swarm/remote-launch-poll";
import type { OpencodeClient } from "../src/opencode-client";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = resolve(here, "../../worker/src");

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
let handleLaunchRelay: AnyFn, handleLaunchRelayAck: AnyFn, handlePollNext: AnyFn, sha256Hex: AnyFn;
let clearCredentialCache: AnyFn;

beforeAll(async () => {
  const launchPath = `${WORKER_SRC}/remote-launch.ts`;
  const pollPath = `${WORKER_SRC}/poll.ts`;
  const credPath = `${WORKER_SRC}/credentials.ts`;
  const launch = await import(/* @vite-ignore */ launchPath);
  const poll = await import(/* @vite-ignore */ pollPath);
  const cred = await import(/* @vite-ignore */ credPath);
  ({ handleLaunchRelay, handleLaunchRelayAck } = launch);
  ({ handlePollNext } = poll);
  ({ sha256Hex, clearCredentialCache } = cred);
});

/** The slice of the D1 API the worker's remote launch and poll code use, over better-sqlite3. */
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
const SENDER = "ses_requesterOnDevbox000000001";

interface World {
  worker: BetterSqlite3.Database;
  devbox: StorageDb;
  cloudbox: StorageDb;
  requesterA: RemoteLaunchRequester;
  receiverDepsB: LaunchReceiverDeps;
  devLaunchClient: RemoteLaunchClient;
  cloudLaunchClient: RemoteLaunchClient;
  devPoller: Poller;
  cloudPoller: Poller;
  createSession: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  dropNextCloudAck: boolean;
  advanceTime: (ms: number) => void;
  currentTime: () => number;
}

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) {
    w.worker.close();
    w.devbox.db.close();
    w.cloudbox.db.close();
  }
  worlds = [];
  vi.restoreAllMocks();
});

async function world(): Promise<World> {
  clearCredentialCache();
  const workerDb = new BetterSqlite3(":memory:");
  workerDb.exec(readFileSync(`${WORKER_SRC}/d1-schema.sql`, "utf8"));
  const DB = d1(workerDb);
  const env = { DB, CCR_API_KEY: "shared-key", SHARED_KEY_REFUSED_MACHINES: "devbox,cloudbox" };

  let currentNow = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => currentNow);

  for (const [key, machine] of [[KEY_DEVBOX, "devbox"], [KEY_CLOUDBOX, "cloudbox"]] as const) {
    workerDb
      .prepare("INSERT INTO machine_credentials (key_sha256, machine_id, created_at) VALUES (?, ?, ?)")
      .run(await sha256Hex(key), machine, currentNow);
  }
  workerDb
    .prepare("INSERT INTO sessions (session_id, machine_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(SENDER, "devbox", currentNow, currentNow);

  // eslint-disable-next-line prefer-const
  let w: World;

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/launch/relay") return handleLaunchRelay(DB, env, request, currentNow);
    if (path === "/launch/relay/ack") {
      if (w?.dropNextCloudAck) {
        w.dropNextCloudAck = false;
        return new Response("network error", { status: 500 });
      }
      return handleLaunchRelayAck(DB, env, request, currentNow);
    }
    const next = /^\/machines\/([^/]+)\/next$/.exec(path);
    if (next) return handlePollNext(DB, env, request, decodeURIComponent(next[1]!));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const devbox = openStorageDb(":memory:");
  const cloudbox = openStorageDb(":memory:");
  devbox.sessions.upsert({ sessionId: SENDER, label: "launch requester" });

  const devLaunchClient = new RemoteLaunchClient({
    workerUrl: "https://worker",
    apiKey: KEY_DEVBOX,
    fetchFn,
  });
  const cloudLaunchClient = new RemoteLaunchClient({
    workerUrl: "https://worker",
    apiKey: KEY_CLOUDBOX,
    fetchFn,
  });

  const createSession = vi.fn(async (dir: string) => ({
    id: `ses_e2eLaunched_${Math.random().toString(36).slice(2, 8)}`,
    directory: dir,
  }));
  const sendPrompt = vi.fn(async () => {});
  const fakeOpencodeClient = {
    createSession,
    sendPrompt,
    healthCheck: async () => ({ ok: true }),
  } as unknown as OpencodeClient;

  const quiet = () => {};

  const requesterA = new RemoteLaunchRequester({
    storage: devbox,
    client: devLaunchClient,
    sendEnabled: true,
    selfMachineId: "devbox",
    nowFn: () => currentNow,
    log: quiet,
  });

  const receiverDepsB: LaunchReceiverDeps = {
    storage: cloudbox,
    selfMachineId: "cloudbox",
    launchFrom: ["devbox"],
    relaySendEnabled: true,
    opencodeClient: fakeOpencodeClient,
    ack: async (items) => {
      if (w?.dropNextCloudAck) {
        w.dropNextCloudAck = false;
        return false;
      }
      return cloudLaunchClient.ack(items);
    },
    statDirectory: (dir: string) => dir !== "/nonexistent",
    spawn: () => ({ unref: () => {} } as any),
    nowFn: () => currentNow,
    log: quiet,
  };

  const receiverDepsA: LaunchReceiverDeps = {
    storage: devbox,
    selfMachineId: "devbox",
    launchFrom: [],
    relaySendEnabled: true,
    opencodeClient: fakeOpencodeClient,
    ack: async (items) => devLaunchClient.ack(items),
    statDirectory: (dir: string) => dir !== "/nonexistent",
    spawn: () => ({ unref: () => {} } as any),
    nowFn: () => currentNow,
    log: quiet,
  };

  const devPoller = new Poller(
    {
      workerUrl: "https://worker",
      apiKey: KEY_DEVBOX,
      machineId: "devbox",
      relayHeader: relayPollHeader(["cloudbox"], true, []),
    },
    {
      onLaunchItems: async (items: unknown[]) => {
        await handleLaunchItems(
          {
            requester: requesterA,
            client: devLaunchClient,
            receiverDeps: receiverDepsA,
            log: quiet,
          },
          items,
        );
      },
    } as never,
    { fetchFn },
  );

  const cloudPoller = new Poller(
    {
      workerUrl: "https://worker",
      apiKey: KEY_CLOUDBOX,
      machineId: "cloudbox",
      relayHeader: relayPollHeader(["devbox"], true, ["devbox"]),
    },
    {
      onLaunchItems: async (items: unknown[]) => {
        await handleLaunchItems(
          {
            client: cloudLaunchClient,
            receiverDeps: receiverDepsB,
            log: quiet,
          },
          items,
        );
      },
    } as never,
    { fetchFn },
  );

  w = {
    worker: workerDb,
    devbox,
    cloudbox,
    requesterA,
    receiverDepsB,
    devLaunchClient,
    cloudLaunchClient,
    devPoller,
    cloudPoller,
    createSession,
    sendPrompt,
    dropNextCloudAck: false,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
    currentTime: () => currentNow,
  };
  worlds.push(w);
  return w;
}

const tick = (p: Poller) => (p as unknown as { tick(): Promise<void> }).tick();

function resultsInA(w: World) {
  return w.devbox.db
    .prepare("SELECT to_session, kind, payload FROM swarm_messages WHERE kind = 'launch.result' AND to_session = ?")
    .all(SENDER) as Array<{ to_session: string; kind: string; payload: string }>;
}

describe("remote launch end to end", () => {
  it("1. A requests → B's poll hands out → B launches → ack → A's poll → A's storage holds one launch.result swarm row", async () => {
    const w = await world();
    // Both poll once to advertise accept lists and mark online
    await tick(w.devPoller);
    await tick(w.cloudPoller);

    w.createSession.mockResolvedValueOnce({ id: "ses_e2eLaunched01", directory: "/projects/foo" });

    const reqResult = await w.requesterA.handleRequest({
      launch_id: "rl_e2e_1",
      from: SENDER,
      machine: "cloudbox",
      directory: "/projects/foo",
      prompt: "hello from A",
    });
    expect(reqResult.status).toBe(202);
    expect(reqResult.body).toMatchObject({ status: "accepted", launch_id: "rl_e2e_1" });

    // B polls and runs launch
    await tick(w.cloudPoller);
    expect(w.createSession).toHaveBeenCalledTimes(1);
    expect(w.sendPrompt).toHaveBeenCalledTimes(1);
    expect(w.sendPrompt).toHaveBeenCalledWith(
      "ses_e2eLaunched01",
      "/projects/foo",
      expect.stringContaining(`[Remote launch requested by ${SENDER} on devbox`),
      expect.any(Object),
    );

    // A polls and receives result
    await tick(w.devPoller);
    const results = resultsInA(w);
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("launch.result");
    expect(results[0]!.payload).toContain("REMOTE LAUNCH STARTED");
    expect(results[0]!.payload).toContain("launch rl_e2e_1");
    expect(results[0]!.payload).toContain("session ses_e2eLaunched01 on cloudbox");

    // Second poll on A does not duplicate the result
    await tick(w.devPoller);
    expect(resultsInA(w)).toHaveLength(1);
  });

  it("2. Lost ack: B processes, ack dropped; lease lapses; re-handout → no second createSession; ack lands; A gets exactly one result", async () => {
    const w = await world();
    await tick(w.devPoller);
    await tick(w.cloudPoller);

    w.createSession.mockResolvedValueOnce({ id: "ses_e2eLaunched02", directory: "/projects/foo" });

    const reqResult = await w.requesterA.handleRequest({
      launch_id: "rl_e2e_2",
      from: SENDER,
      machine: "cloudbox",
      directory: "/projects/foo",
      prompt: "hello from A #2",
    });
    expect(reqResult.status).toBe(202);

    // B's first poll processes the launch, but ack drops
    w.dropNextCloudAck = true;
    await tick(w.cloudPoller);
    expect(w.createSession).toHaveBeenCalledTimes(1);

    // Lease on worker expires after 60s
    w.advanceTime(65_000);

    // B polls again — launch is re-handed out by worker
    await tick(w.cloudPoller);
    // B sees existing settled row and does NOT call createSession again
    expect(w.createSession).toHaveBeenCalledTimes(1);

    // A polls and receives the single result
    await tick(w.devPoller);
    const results = resultsInA(w);
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toContain("session ses_e2eLaunched02 on cloudbox");
  });

  it("3. B never polls: A's polls past 15 min → A gets never_collected", async () => {
    const w = await world();
    await tick(w.devPoller);
    await tick(w.cloudPoller);

    const reqResult = await w.requesterA.handleRequest({
      launch_id: "rl_e2e_3",
      from: SENDER,
      machine: "cloudbox",
      directory: "/projects/foo",
      prompt: "hello from A #3",
    });
    expect(reqResult.status).toBe(202);

    // B never polls!
    // Advance time past 15 min TTL (15 * 60_000 ms)
    w.advanceTime(15 * 60_000 + 5_000);

    // A polls: worker expires the launch as never_collected and hands result to A
    await tick(w.devPoller);
    const results = resultsInA(w);
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toContain("REMOTE LAUNCH NOT STARTED");
    expect(results[0]!.payload).toContain("never collected by cloudbox and did NOT start");
  });

  it("4. B refuses (no_such_directory) → A's result says refused with that reason", async () => {
    const w = await world();
    await tick(w.devPoller);
    await tick(w.cloudPoller);

    const reqResult = await w.requesterA.handleRequest({
      launch_id: "rl_e2e_4",
      from: SENDER,
      machine: "cloudbox",
      directory: "/nonexistent",
      prompt: "hello from A #4",
    });
    expect(reqResult.status).toBe(202);

    // B polls and detects directory does not exist
    await tick(w.cloudPoller);
    expect(w.createSession).not.toHaveBeenCalled();

    // A polls and receives refusal result
    await tick(w.devPoller);
    const results = resultsInA(w);
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toContain("REMOTE LAUNCH REFUSED");
    expect(results[0]!.payload).toContain("did NOT start on cloudbox (no_such_directory)");
  });
});

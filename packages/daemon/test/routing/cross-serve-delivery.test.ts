import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { openStorageDb } from "../../src/storage/database";
import { IngressRouter } from "../../src/routing/router";
import { OpencodeClientFactory } from "../../src/routing/client-factory";
import { makeDirectoryResolver } from "../../src/routing/directory-resolver";
import { SessionDirectoryRegistry } from "../../src/swarm/registry";
import { SwarmArbiter } from "../../src/swarm/arbiter";
import type { ServeInstanceRecord } from "../../src/routing/types";

interface FakeServe {
  server: Server;
  url: string;
  received: string[];
}

function startFakeServe(): Promise<FakeServe> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url || "";
    if (req.method === "GET" && url.startsWith("/session/")) {
      const parts = url.split("/");
      const id = parts[parts.length - 1];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, directory: "/dir" }));
      return;
    }
    if (req.method === "POST" && url.endsWith("/prompt_async")) {
      const parts = url.split("/");
      const id = parts[2] || "";
      received.push(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    if (req.method === "GET" && url === "/global/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "string" ? 0 : addr?.port;
      const url = `http://127.0.0.1:${port}`;
      resolve({ server, url, received });
    });
  });
}

describe("cross-serve-delivery integration", () => {
  let fakeA: FakeServe;
  let fakeB: FakeServe;

  beforeAll(async () => {
    fakeA = await startFakeServe();
    fakeB = await startFakeServe();
  });

  afterAll(async () => {
    const close = (s?: { server: import("node:http").Server }) =>
      s?.server ? new Promise<void>((res) => s.server.close(() => res())) : Promise.resolve();
    await close(fakeA);
    await close(fakeB);
  });

  it("proves end-to-end swarm routing across fake serves including failover", async () => {
    let now = Date.now();
    const storage = openStorageDb(":memory:");

    // 1. Seed two healthy serves
    const serve0: ServeInstanceRecord = {
      serveId: "serve-0",
      instanceUuid: "uuid-0",
      endpoint: fakeA.url,
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const serve1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: fakeB.url,
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    storage.serves.upsert(serve0);
    storage.serves.upsert(serve1);

    // 2. Build a real IngressRouter over storage
    const ingressRouter = new IngressRouter(storage, {
      leaseTtlMs: 10_000,
      staleServeMs: 10_000,
      idleMigrateMs: 10_000,
      dormantTtlMs: 20_000,
      activeTurnCap: 10,
    });

    const clientFactory = new OpencodeClientFactory(ingressRouter, () => now);
    const clientForSession = (sid: string) => clientFactory.forSession(sid);

    // Use the shared pool-aware read-only directory resolver
    const directoryForSession = makeDirectoryResolver({ ingressRouter, fallbackBaseUrl: undefined, nowFn: () => now });

    // 3. Force placement: ses_A -> serve-0, ses_B -> serve-1
    storage.assignments.upsert({
      sessionId: "ses_A",
      directoryKey: null,
      desiredServeId: "serve-0",
      ownerGeneration: 1,
      state: "assigned",
      lastPlacedAt: now,
      updatedAt: now,
    });
    storage.leases.acquireCAS(
      {
        sessionId: "ses_A",
        serveId: "serve-0",
        instanceUuid: "uuid-0",
        ownerGeneration: 1,
        binaryEpoch: 0,
      },
      now,
      10_000,
    );

    storage.assignments.upsert({
      sessionId: "ses_B",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastPlacedAt: now,
      updatedAt: now,
    });
    storage.leases.acquireCAS(
      {
        sessionId: "ses_B",
        serveId: "serve-1",
        instanceUuid: "uuid-1",
        ownerGeneration: 1,
        binaryEpoch: 0,
      },
      now,
      10_000,
    );

    // 4. Insert message ses_A -> ses_B
    storage.swarm.insert(
      {
        msgId: "msg_1",
        fromSession: "ses_A",
        toSession: "ses_B",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hello B",
      },
      now,
    );

    // 5. Construct SwarmArbiter and processOnce
    const arbiter = new SwarmArbiter({
      storage,
      clientForSession,
      directoryForSession,
      nowFn: () => now,
      log: () => {},
    });

    await arbiter.processOnce();

    // 6. ASSERT: fakeB received "ses_B", fakeA did not. Msg state is handed_off.
    expect(fakeB.received).toContain("ses_B");
    expect(fakeA.received).not.toContain("ses_B");
    expect(storage.swarm.getByMsgId("msg_1")?.state).toBe("handed_off");

    // 7. Reverse: ses_B -> ses_A
    storage.swarm.insert(
      {
        msgId: "msg_2",
        fromSession: "ses_B",
        toSession: "ses_A",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hello A",
      },
      now,
    );

    await arbiter.processOnce();
    expect(fakeA.received).toContain("ses_A");
    expect(storage.swarm.getByMsgId("msg_2")?.state).toBe("handed_off");

    // 8. Failover: serve-1 dies. Marking it unhealthy is NOT enough on its own --
    // since bead pigeon-pov an unexpired lease proves the owner is alive-but-busy
    // (a CPU-stalled serve looks identical to a dead one from outside), so routing
    // deliberately keeps delivering to it until the lease lapses rather than
    // yanking the lease out from under an in-flight turn. A genuinely dead serve
    // stops renewing, so advance past leaseTtlMs (10_000) to reach the real
    // failover, keeping serve-0's heartbeat fresh so it stays an eligible target.
    storage.serves.setHealth("serve-1", "unhealthy", now);
    now += 10_001;
    storage.serves.upsert({ ...serve0, heartbeatAt: now });

    storage.swarm.insert(
      {
        msgId: "msg_3",
        fromSession: "ses_A",
        toSession: "ses_B",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hello B again",
      },
      now,
    );

    // Run processOnce; since serve-1 is unhealthy, ses_B must failover to serve-0
    await arbiter.processOnce();

    // Assert fakeA received ses_B delivery during failover
    expect(fakeA.received).toContain("ses_B");
    expect(storage.swarm.getByMsgId("msg_3")?.state).toBe("handed_off");
  });
});

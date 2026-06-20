import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { IngressRouter, NoHealthyServeError } from "../../src/routing/router";
import { OpencodeClientFactory } from "../../src/routing/client-factory";
import type { ServeInstanceRecord } from "../../src/routing/types";

describe("OpencodeClientFactory", () => {
  // Test 1: Endpoint caching
  it("Endpoint caching: two sessions with same apiBase return same client instance, different return different", () => {
    const stubRouter = {
      ensureRouted: (sessionId: string, _now: number) => {
        if (sessionId === "ses-1" || sessionId === "ses-2") {
          return {
            sessionId,
            serveId: "serve-1",
            instanceUuid: "uuid-1",
            ownerGeneration: 1,
            apiBase: "http://localhost:8001",
            eventUrl: "http://localhost:8001/event",
            expiresAt: 12345,
          };
        } else {
          return {
            sessionId,
            serveId: "serve-2",
            instanceUuid: "uuid-2",
            ownerGeneration: 1,
            apiBase: "http://localhost:8002",
            eventUrl: "http://localhost:8002/event",
            expiresAt: 12345,
          };
        }
      },
    };

    const factory = new OpencodeClientFactory(stubRouter);

    const client1 = factory.forSession("ses-1");
    const client2 = factory.forSession("ses-2");
    const client3 = factory.forSession("ses-3");

    expect(client1).toBeDefined();
    expect(client2).toBe(client1); // SAME instance (same apiBase)
    expect(client3).toBeDefined();
    expect(client3).not.toBe(client1); // DIFFERENT instance (different apiBase)
  });

  // Test 2: forEndpoint caching
  it("forEndpoint caching: multiple calls for same endpoint return same instance", () => {
    const stubRouter = {
      ensureRouted: () => {
        throw new Error("not used");
      },
    };
    const factory = new OpencodeClientFactory(stubRouter);

    const clientA1 = factory.forEndpoint("http://a");
    const clientA2 = factory.forEndpoint("http://a");
    const clientB = factory.forEndpoint("http://b");

    expect(clientA1).toBeDefined();
    expect(clientA2).toBe(clientA1);
    expect(clientB).toBeDefined();
    expect(clientB).not.toBe(clientA1);
  });

  // Test 3: No healthy serve -> undefined
  it("No healthy serve -> returns undefined", () => {
    const stubRouter = {
      ensureRouted: () => {
        throw new NoHealthyServeError();
      },
    };
    const factory = new OpencodeClientFactory(stubRouter);

    const client = factory.forSession("any-session");
    expect(client).toBeUndefined();
  });

  // Test 4: Other errors propagate
  it("Other errors propagate", () => {
    const stubRouter = {
      ensureRouted: () => {
        throw new Error("Database locked");
      },
    };
    const factory = new OpencodeClientFactory(stubRouter);

    expect(() => factory.forSession("any-session")).toThrow("Database locked");
  });

  // Test 5: Real router integration
  it("Real router integration: two sessions on different serves return different clients", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    const factory = new OpencodeClientFactory(router, () => now);

    const sidA = "session-a";
    const resA = router.ensureRouted(sidA, now);
    const firstServeId = resA.serveId;

    let sidB = "";
    // Find a session ID that lands on the other serve
    for (let i = 1; i < 100; i++) {
      const candidateSid = `session-b-${i}`;
      const resCandidate = router.ensureRouted(candidateSid, now);
      if (resCandidate.serveId !== firstServeId) {
        sidB = candidateSid;
        break;
      }
    }

    expect(sidB).not.toBe("");

    const clientA = factory.forSession(sidA);
    const clientB = factory.forSession(sidB);

    expect(clientA).toBeDefined();
    expect(clientB).toBeDefined();
    expect(clientB).not.toBe(clientA);
  });
});

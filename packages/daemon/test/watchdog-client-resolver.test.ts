import { describe, expect, it, vi } from "vitest";
import { makeWatchdogResolveClients } from "../src/swarm/watchdog-client-resolver";
import type { ServeInstanceRecord, RouteResult, RoutingMetaRecord } from "../src/routing/types";
import type { WatchdogClient } from "../src/swarm/delivery-watchdog";

function serve(id: string, endpoint: string): ServeInstanceRecord {
  return {
    serveId: id,
    instanceUuid: `uuid-${id}`,
    endpoint,
    binaryEpoch: 0,
    healthState: "healthy",
    heartbeatAt: 1000,
    draining: false,
  };
}

function meta(): RoutingMetaRecord {
  return { schemaVersion: 1, ddlChecksum: "x", binaryEpoch: 0, updatedAt: 0 };
}

function fakeClientFactory() {
  const clients = new Map<string, WatchdogClient>();
  const forEndpoint = vi.fn((endpoint: string): WatchdogClient => {
    let c = clients.get(endpoint);
    if (!c) {
      c = { getSessionMessages: vi.fn(), abortSession: vi.fn() };
      clients.set(endpoint, c);
    }
    return c;
  });
  return { forEndpoint, clients };
}

describe("makeWatchdogResolveClients", () => {
  it("pool configured + prospective route hit: preferred = routed serve's client (from the shared factory); all = every healthy serve", () => {
    const healthy = [serve("serve-0", "http://a"), serve("serve-1", "http://b")];
    const serveRegistry = { listHealthy: vi.fn(() => healthy) };
    const routingMeta = { get: vi.fn(() => meta()) };
    const route: RouteResult = {
      sessionId: "ses_1",
      serveId: "serve-1",
      instanceUuid: "uuid-serve-1",
      ownerGeneration: 1,
      apiBase: "http://b",
      eventUrl: "http://b/event",
      expiresAt: 0,
      prospective: true,
    };
    const ingressRouter = { resolveProspectiveRoute: vi.fn(() => route) };
    const { forEndpoint } = fakeClientFactory();
    const clientFactory = { forEndpoint };

    const resolveClients = makeWatchdogResolveClients({
      ingressRouter,
      serveRegistry,
      routingMeta,
      clientFactory,
      staleServeMs: 15000,
      nowFn: () => 2000,
    });

    const result = resolveClients("ses_1");

    expect(serveRegistry.listHealthy).toHaveBeenCalledWith(2000, 15000, 0);
    expect(ingressRouter.resolveProspectiveRoute).toHaveBeenCalledWith("ses_1", 2000);
    expect(result.all).toHaveLength(2);
    expect(result.preferred).toBe(forEndpoint("http://b")); // same cached instance
    expect(result.all).toContain(forEndpoint("http://a"));
    expect(result.all).toContain(forEndpoint("http://b"));
  });

  it("pool configured + no prospective route (never placed): preferred falls back to any healthy serve", () => {
    const healthy = [serve("serve-0", "http://a")];
    const serveRegistry = { listHealthy: vi.fn(() => healthy) };
    const routingMeta = { get: vi.fn(() => meta()) };
    const ingressRouter = { resolveProspectiveRoute: vi.fn(() => null) };
    const { forEndpoint } = fakeClientFactory();
    const clientFactory = { forEndpoint };

    const resolveClients = makeWatchdogResolveClients({
      ingressRouter,
      serveRegistry,
      routingMeta,
      clientFactory,
      staleServeMs: 15000,
    });

    const result = resolveClients("ses_new");
    expect(result.preferred).toBe(forEndpoint("http://a"));
    expect(result.all).toHaveLength(1);
  });

  it("pool configured but no healthy serves: empty set, resolveProspectiveRoute not even consulted", () => {
    const serveRegistry = { listHealthy: vi.fn(() => []) };
    const routingMeta = { get: vi.fn(() => meta()) };
    const ingressRouter = { resolveProspectiveRoute: vi.fn() };
    const { forEndpoint } = fakeClientFactory();

    const resolveClients = makeWatchdogResolveClients({
      ingressRouter,
      serveRegistry,
      routingMeta,
      clientFactory: { forEndpoint },
      staleServeMs: 15000,
    });

    const result = resolveClients("ses_x");
    expect(result.preferred).toBeUndefined();
    expect(result.all).toEqual([]);
    expect(ingressRouter.resolveProspectiveRoute).not.toHaveBeenCalled();
  });

  it("routing not configured: falls back to the single plain client (both preferred and sole broadcast entry)", () => {
    const singleClient: WatchdogClient = { getSessionMessages: vi.fn(), abortSession: vi.fn() };
    const serveRegistry = { listHealthy: vi.fn() };
    const routingMeta = { get: vi.fn() };

    const resolveClients = makeWatchdogResolveClients({
      serveRegistry,
      routingMeta,
      staleServeMs: 15000,
      singleClient,
    });

    const result = resolveClients("ses_x");
    expect(result.preferred).toBe(singleClient);
    expect(result.all).toEqual([singleClient]);
    expect(serveRegistry.listHealthy).not.toHaveBeenCalled();
  });

  it("routing not configured and no single client: empty set", () => {
    const serveRegistry = { listHealthy: vi.fn() };
    const routingMeta = { get: vi.fn() };

    const resolveClients = makeWatchdogResolveClients({
      serveRegistry,
      routingMeta,
      staleServeMs: 15000,
    });

    const result = resolveClients("ses_x");
    expect(result.preferred).toBeUndefined();
    expect(result.all).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { seedServes } from "../../src/routing/serve-registry";

describe("serve-registry", () => {
  it("seeds serve-0/serve-1 for endpoints with unknown health and deterministic uuidFn", () => {
    const s = openStorageDb(":memory:");
    const endpoints = ["http://127.0.0.1:4096", "http://127.0.0.1:4097"];
    let uuidCount = 0;
    const uuidFn = () => `mock-uuid-${uuidCount++}`;

    seedServes(s.serves, endpoints, 1000, { uuidFn, binaryEpoch: 42 });

    const s0 = s.serves.get("serve-0");
    expect(s0).toEqual({
      serveId: "serve-0",
      instanceUuid: "mock-uuid-0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 42,
      healthState: "unknown",
      heartbeatAt: 1000,
      draining: false,
    });

    const s1 = s.serves.get("serve-1");
    expect(s1).toEqual({
      serveId: "serve-1",
      instanceUuid: "mock-uuid-1",
      endpoint: "http://127.0.0.1:4097",
      binaryEpoch: 42,
      healthState: "unknown",
      heartbeatAt: 1000,
      draining: false,
    });

    s.db.close();
  });

  it("is non-destructive on subsequent seeds: preserves instanceUuid and health state/heartbeat", () => {
    const s = openStorageDb(":memory:");
    const endpoints = ["http://127.0.0.1:4096"];
    
    // First seed
    seedServes(s.serves, endpoints, 1000, { uuidFn: () => "uuid-A", binaryEpoch: 1 });
    
    // Manually transition to healthy and change heartbeat
    s.serves.setHealth("serve-0", "healthy", 2000);

    // Second seed with different uuidFn and binaryEpoch, and even endpoint if changed
    seedServes(s.serves, ["http://127.0.0.1:8080"], 3000, { uuidFn: () => "uuid-B", binaryEpoch: 2 });

    const s0 = s.serves.get("serve-0");
    expect(s0).toEqual({
      serveId: "serve-0",
      instanceUuid: "uuid-A", // Preserved!
      endpoint: "http://127.0.0.1:8080", // Updated!
      binaryEpoch: 2, // Updated!
      healthState: "healthy", // Preserved!
      heartbeatAt: 2000, // Preserved!
      draining: false, // Preserved!
    });

    s.db.close();
  });
});

import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { seedServes } from "../../src/routing/serve-registry";
import type { ServeInstanceRecord } from "../../src/routing/types";

describe("serve-registry", () => {
  it("creates non-healthy stub for missing serves", () => {
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
      binaryEpoch: 0,
      healthState: "unknown",
      heartbeatAt: 0,
      draining: false,
    });

    const s1 = s.serves.get("serve-1");
    expect(s1).toEqual({
      serveId: "serve-1",
      instanceUuid: "mock-uuid-1",
      endpoint: "http://127.0.0.1:4097",
      binaryEpoch: 0,
      healthState: "unknown",
      heartbeatAt: 0,
      draining: false,
    });

    s.db.close();
  });

  it("leaves existing serve-written rows entirely untouched", () => {
    const s = openStorageDb(":memory:");
    
    // Create an existing serve-written row
    const existingRow: ServeInstanceRecord = {
      serveId: "serve-0",
      instanceUuid: "uuid-X",
      endpoint: "http://127.0.0.1:1234",
      binaryEpoch: 2,
      healthState: "healthy",
      heartbeatAt: 5000,
      draining: false,
    };
    s.serves.upsert(existingRow);

    // Call seedServes (which would normally map serve-0 to endpoints[0])
    seedServes(s.serves, ["http://127.0.0.1:4096"], 6000, { uuidFn: () => "uuid-Y", binaryEpoch: 1 });

    // Assert it survives byte-for-byte
    const s0 = s.serves.get("serve-0");
    expect(s0).toEqual(existingRow);

    s.db.close();
  });

  it("is idempotent and never overwrites existing or stub rows", () => {
    const s = openStorageDb(":memory:");
    const endpoints = ["http://127.0.0.1:4096"];

    // First seed creates a stub
    seedServes(s.serves, endpoints, 1000, { uuidFn: () => "uuid-stub", binaryEpoch: 1 });
    const stub = s.serves.get("serve-0");
    expect(stub?.healthState).toBe("unknown");
    expect(stub?.heartbeatAt).toBe(0);

    // Call seedServes again, should do nothing
    seedServes(s.serves, endpoints, 2000, { uuidFn: () => "uuid-other", binaryEpoch: 2 });
    const stubAfter = s.serves.get("serve-0");
    expect(stubAfter).toEqual(stub);

    s.db.close();
  });
});

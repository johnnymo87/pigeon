import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("Daemon Auth", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(authToken?: string) {
    storage = openStorageDb(":memory:");
    return createApp(storage, {
      nowFn: () => 1_000,
      authToken,
    });
  }

  it("1. Disabled (back-compat): createApp WITHOUT authToken -> normal non-401 status", async () => {
    const app = newApp();
    const response = await app(new Request("http://localhost/cleanup", { method: "POST" }));
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);

    const health = await app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
  });

  it("2. Enabled, missing header: createApp { authToken: 'secret' } -> POST /cleanup is 401", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/cleanup", { method: "POST" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("3. Enabled, correct header: createApp { authToken: 'secret' } -> Authorization: Bearer secret is not 401", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/cleanup", {
      method: "POST",
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(response.status).not.toBe(401);
  });

  it("4. Enabled, wrong header: createApp { authToken: 'secret' } -> Authorization: Bearer nope is 401", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/cleanup", {
      method: "POST",
      headers: { "Authorization": "Bearer nope" },
    }));
    expect(response.status).toBe(401);
  });

  it("5. Health open with token set: GET /health -> 200", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
  });

  it("6. Control route protected: GET /route?session_id=ses_x with token set + no header -> 401; with correct header -> not 401", async () => {
    const app = newApp("secret");
    
    // No header
    const response1 = await app(new Request("http://localhost/route?session_id=ses_x"));
    expect(response1.status).toBe(401);

    // Correct header
    const response2 = await app(new Request("http://localhost/route?session_id=ses_x", {
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(response2.status).not.toBe(401);
  });

  it("7. Read route open: GET /sessions with token set + no header -> not 401", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/sessions"));
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);
  });
});

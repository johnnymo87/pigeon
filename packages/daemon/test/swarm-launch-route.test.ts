import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { RemoteLaunchRequester } from "../src/swarm/remote-launch-requester";
import type { RemoteLaunchClient } from "../src/worker/remote-launch-client";

describe("POST /swarm/launch route", () => {
  let storage: StorageDb | null = null;
  const authToken = "secret-token-123";

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  const postLaunch = (
    app: ReturnType<typeof createApp>,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    app(
      new Request("http://localhost/swarm/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("returns 503 no_worker when remoteLaunch is not provided", async () => {
    const app = createApp(storage!, {});
    const res = await postLaunch(app, {
      launch_id: "lnch_001",
      from: "ses_sender123",
      machine: "devbox",
      directory: "/home/dev/pigeon",
      prompt: "hello",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_worker" });
  });

  it("returns 400 invalid when JSON body is malformed", async () => {
    const fakeRequester = {
      handleRequest: vi.fn(),
    } as unknown as RemoteLaunchRequester;

    const app = createApp(storage!, { remoteLaunch: fakeRequester });
    const res = await postLaunch(app, "not valid json {", {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid",
      detail: "invalid JSON body",
    });
    expect(fakeRequester.handleRequest).not.toHaveBeenCalled();
  });

  it("requires auth when authToken is configured", async () => {
    const fakeRequester = {
      handleRequest: vi.fn().mockResolvedValue({
        status: 202,
        body: { launch_id: "lnch_001", status: "accepted", to_machine: "devbox" },
      }),
    } as unknown as RemoteLaunchRequester;

    const app = createApp(storage!, {
      authToken,
      remoteLaunch: fakeRequester,
    });

    // 1. Missing auth
    const resNoAuth = await postLaunch(app, { launch_id: "lnch_001" });
    expect(resNoAuth.status).toBe(401);
    expect(fakeRequester.handleRequest).not.toHaveBeenCalled();

    // 2. Wrong auth
    const resBadAuth = await postLaunch(
      app,
      { launch_id: "lnch_001" },
      { Authorization: "Bearer wrong-token" },
    );
    expect(resBadAuth.status).toBe(401);
    expect(fakeRequester.handleRequest).not.toHaveBeenCalled();

    // 3. Correct auth
    const resOk = await postLaunch(
      app,
      { launch_id: "lnch_001" },
      { Authorization: `Bearer ${authToken}` },
    );
    expect(resOk.status).toBe(202);
    expect(await resOk.json()).toEqual({
      launch_id: "lnch_001",
      status: "accepted",
      to_machine: "devbox",
    });
    expect(fakeRequester.handleRequest).toHaveBeenCalledWith({ launch_id: "lnch_001" });
  });

  it("delegates to remoteLaunch.handleRequest and forwards status and body", async () => {
    const fakeRequester = {
      handleRequest: vi.fn().mockResolvedValue({
        status: 400,
        body: { error: "invalid", detail: "prompt must be 1-16000 code points" },
      }),
    } as unknown as RemoteLaunchRequester;

    const app = createApp(storage!, { remoteLaunch: fakeRequester });
    const res = await postLaunch(app, { launch_id: "lnch_bad" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid",
      detail: "prompt must be 1-16000 code points",
    });
  });

  it("integration: answers per contract including idempotent repeat", async () => {
    const client: Pick<RemoteLaunchClient, "request" | "ack"> = {
      request: vi.fn().mockResolvedValue({
        kind: "accepted",
        toMachine: "devbox",
        duplicate: false,
      }),
      ack: vi.fn().mockResolvedValue(true),
    };

    const requester = new RemoteLaunchRequester({
      storage: storage!,
      client,
      sendEnabled: true,
      selfMachineId: "cloudbox",
      nowFn: () => 1_000_000,
    });

    const app = createApp(storage!, { remoteLaunch: requester });

    const payload = {
      launch_id: "lnch_e2e_1",
      from: "ses_sender123",
      machine: "devbox",
      directory: "/home/dev/pigeon",
      prompt: "echo hello",
    };

    // First call -> 202 accepted
    const res1 = await postLaunch(app, payload);
    expect(res1.status).toBe(202);
    expect(await res1.json()).toEqual({
      launch_id: "lnch_e2e_1",
      status: "accepted",
      to_machine: "devbox",
    });
    expect(client.request).toHaveBeenCalledTimes(1);

    // Second call with same payload -> 202 accepted (idempotent, no second client request)
    const res2 = await postLaunch(app, payload);
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({
      launch_id: "lnch_e2e_1",
      status: "accepted",
      to_machine: "devbox",
    });
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});

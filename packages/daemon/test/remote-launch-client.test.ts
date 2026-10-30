import { describe, expect, it, vi } from "vitest";
import {
  RemoteLaunchClient,
  type RemoteLaunchRequestBody,
  type RemoteLaunchAckItem,
} from "../src/worker/remote-launch-client";

describe("RemoteLaunchClient", () => {
  const DEFAULT_BODY: RemoteLaunchRequestBody = {
    launch_id: "launch-123",
    from: "ses_sender",
    machine: "cloudbox",
    directory: "~/projects/pigeon",
    prompt: "say hello",
    tag: "billing",
    expires_at: 1_800_000_000,
  };

  describe("request", () => {
    it("sends correct URL, headers, and body", async () => {
      let seenUrl = "";
      let seenInit: RequestInit | undefined;
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(JSON.stringify({ accepted: true, to_machine: "cloudbox" }), {
          status: 202,
        });
      }) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://worker.pigeon.test",
        apiKey: "pgk_secret_123",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);

      expect(seenUrl).toBe("https://worker.pigeon.test/launch/relay");
      expect(seenInit?.method).toBe("POST");
      expect(new Headers(seenInit?.headers).get("Authorization")).toBe("Bearer pgk_secret_123");
      expect(new Headers(seenInit?.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(seenInit?.body))).toEqual(DEFAULT_BODY);
      expect(res).toEqual({
        kind: "accepted",
        toMachine: "cloudbox",
        duplicate: false,
      });
    });

    it("handles accepted response with duplicate=true", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(
          JSON.stringify({
            accepted: true,
            duplicate: true,
            launch_id: "launch-123",
            to_machine: "cloudbox",
            expires_at: 1_800_000_000,
          }),
          { status: 202 },
        ),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toEqual({
        kind: "accepted",
        toMachine: "cloudbox",
        duplicate: true,
      });
    });

    it.each([
      [400, "invalid", "prompt exceeds maximum length"],
      [409, "launch_id_conflict", "that launch_id is already used"],
      [410, "expired", "fewer than one lease of life left"],
      [403, "sender_not_yours", "ses_sender is registered to another machine"],
      [409, "same_machine", "cannot launch on the calling machine"],
      [403, "receiver_not_retired", "receiver still accepts shared key"],
      [403, "not_accepted", "receiver does not accept launches from caller"],
      [503, "target_offline", "receiver is not polling"],
      [409, "no_return_path", "remote launch requires a working swarm relay"],
      [429, "queue_full", "10 launches already wait for target"],
      [429, "rate_limited", "caller has created 30 launches in the last hour"],
      [503, "launch_unavailable", "launch table missing"],
      [403, "machine_mismatch", "caller devbox does not match from_machine cloudbox"],
    ])("classifies %i with error %s as refused", async (status, code, detail) => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ error: code, detail }), { status }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toEqual({
        kind: "refused",
        code,
        detail,
        status,
      });
    });

    it("classifies 404 with no code as refused with worker_too_old", async () => {
      const fetchFn = vi.fn(async () =>
        new Response("404 page not found", { status: 404 }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toMatchObject({
        kind: "refused",
        code: "worker_too_old",
        status: 404,
      });
    });

    it("classifies 401 with no known code as refused with unauthorized", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toMatchObject({
        kind: "refused",
        code: "unauthorized",
        status: 401,
      });
    });

    it("classifies 503 with empty body as transient", async () => {
      const fetchFn = vi.fn(async () =>
        new Response("", { status: 503 }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res.kind).toBe("transient");
      expect(res).toHaveProperty("detail");
    });

    it("classifies unknown error codes as transient", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ error: "cf_worker_crashed", detail: "boom" }), {
          status: 500,
        }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toEqual({
        kind: "transient",
        detail: "worker answered 500 cf_worker_crashed: boom",
      });
    });

    it("classifies network errors and timeouts as transient without throwing", async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      }) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const res = await client.request(DEFAULT_BODY);
      expect(res).toEqual({
        kind: "transient",
        detail: "launch relay request failed: connect ECONNREFUSED 127.0.0.1:443",
      });
    });
  });

  describe("ack", () => {
    const SAMPLE_ITEMS: RemoteLaunchAckItem[] = [
      {
        kind: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        outcome: "launched",
        session_id: "ses_target_1",
      },
      {
        kind: "result",
        from_machine: "cloudbox",
        result_id: "r:l2",
        outcome: "delivered",
      },
    ];

    it("returns true immediately for empty items array without fetching", async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch;
      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      const ok = await client.ack([]);
      expect(ok).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("sends POST to /launch/relay/ack and returns true on 200 { ok: true }", async () => {
      let seenUrl = "";
      let seenInit: RequestInit | undefined;
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://worker.pigeon.test",
        apiKey: "pgk_secret_123",
        fetchFn,
      });

      const ok = await client.ack(SAMPLE_ITEMS);
      expect(ok).toBe(true);
      expect(seenUrl).toBe("https://worker.pigeon.test/launch/relay/ack");
      expect(seenInit?.method).toBe("POST");
      expect(JSON.parse(String(seenInit?.body))).toEqual({ items: SAMPLE_ITEMS });
    });

    it("returns false on 200 when ok is not true", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), { status: 200 }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      expect(await client.ack(SAMPLE_ITEMS)).toBe(false);
    });

    it("returns false on non-200 responses", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid", detail: "bad items" }), { status: 400 }),
      ) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      expect(await client.ack(SAMPLE_ITEMS)).toBe(false);
    });

    it("returns false on network exceptions without throwing", async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error("timeout");
      }) as unknown as typeof fetch;

      const client = new RemoteLaunchClient({
        workerUrl: "https://w",
        apiKey: "k",
        fetchFn,
      });

      expect(await client.ack(SAMPLE_ITEMS)).toBe(false);
    });
  });
});

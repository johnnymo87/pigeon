import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, BIND_TIMEOUT_MS } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { WorkerResult } from "../src/worker/poller";

describe("named topic binding routes", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(opts: Parameters<typeof createApp>[1] = {}) {
    storage = openStorageDb(":memory:");
    return { app: createApp(storage, opts), storage };
  }

  function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
    return app(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  describe("POST /session-start with named_topic", () => {
    it("echoes machine_id and omits named_topic_bound when named_topic is absent", async () => {
      const { app } = newApp({ machineId: "machine-alpha" });
      const res = await post(app, "/session-start", { session_id: "ses_1", notify: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: "machine-alpha",
      });
    });

    it("echoes machine_id: null when machineId is not configured", async () => {
      const { app } = newApp({});
      const res = await post(app, "/session-start", { session_id: "ses_1", notify: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
      });
    });

    it("returns named_topic_error: 'invalid named_topic' for malformed topic", async () => {
      const { app } = newApp({ machineId: "mach-1" });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        named_topic: { key: "invalid key with spaces", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: "mach-1",
        named_topic_bound: false,
        named_topic_error: "invalid named_topic",
      });
    });

    it("returns named_topic_error: 'notify is required' when notify is false", async () => {
      const { app } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: false,
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "notify is required",
      });
    });

    it("returns named_topic_error: 'not a pull session' and skips bind when backend is not pull", async () => {
      const bindNamedTopic = vi.fn();
      const { app } = newApp({ bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "opencode-plugin-direct",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "not a pull session",
      });
      expect(bindNamedTopic).not.toHaveBeenCalled();
    });

    it("returns named_topic_error: 'worker registration failed' when onSessionStart throws", async () => {
      const onSessionStart = vi.fn().mockRejectedValue(new Error("network explode"));
      const bindNamedTopic = vi.fn();
      const { app } = newApp({ onSessionStart, bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "worker registration failed",
      });
      expect(bindNamedTopic).not.toHaveBeenCalled();
    });

    it("returns 200 even when onSessionStart throws if named_topic is absent", async () => {
      const onSessionStart = vi.fn().mockRejectedValue(new Error("network explode"));
      const { app } = newApp({ onSessionStart });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
      });
    });

    it("returns named_topic_error: 'worker registration failed' and skips bind when onSessionStart returns ok:false", async () => {
      const callOrder: string[] = [];
      const onSessionStart = vi.fn().mockImplementation(async () => {
        callOrder.push("register");
        return { ok: false, kind: "http_error", status: 503 } as WorkerResult;
      });
      const bindNamedTopic = vi.fn().mockImplementation(async () => {
        callOrder.push("bind");
        return { messageThreadId: 42 };
      });

      const { app } = newApp({ onSessionStart, bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "worker registration failed",
      });
      expect(callOrder).toEqual(["register"]);
      expect(bindNamedTopic).not.toHaveBeenCalled();
    });

    it("returns named_topic_error: 'no worker connection' when bindNamedTopic is missing", async () => {
      const onSessionStart = vi.fn().mockResolvedValue({ ok: true, status: 200 } as WorkerResult);
      const { app } = newApp({ onSessionStart });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "no worker connection",
      });
    });

    it("returns named_topic_error: 'bind failed: <msg>' when bindNamedTopic throws", async () => {
      const onSessionStart = vi.fn().mockResolvedValue({ ok: true, status: 200 } as WorkerResult);
      const bindNamedTopic = vi.fn().mockRejectedValue(new Error("topics/named/bind returned 502"));
      const { app } = newApp({ onSessionStart, bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "bind failed: topics/named/bind returned 502",
      });
    });

    it("reports named_topic_error: 'bind timed out' when binding exceeds timeout", async () => {
      expect(BIND_TIMEOUT_MS).toBe(8_000);
      const onSessionStart = vi.fn().mockResolvedValue({ ok: true, status: 200 } as WorkerResult);
      const bindNamedTopic = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
      const { app } = newApp({
        onSessionStart,
        bindNamedTopic,
        bindTimeoutMs: 10,
      });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "bind timed out",
      });
    });

    it("calls register BEFORE bind and returns named_topic_bound: true on success", async () => {
      const callOrder: string[] = [];
      const onSessionStart = vi.fn().mockImplementation(async () => {
        callOrder.push("register");
        return { ok: true, status: 200 } as WorkerResult;
      });
      const bindNamedTopic = vi.fn().mockImplementation(async () => {
        callOrder.push("bind");
        return { messageThreadId: 42 };
      });

      const { app } = newApp({ machineId: "mach-prod", onSessionStart, bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_1",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic One" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_1",
        machine_id: "mach-prod",
        named_topic_bound: true,
      });
      expect(callOrder).toEqual(["register", "bind"]);
      expect(bindNamedTopic).toHaveBeenCalledWith(
        { sessionId: "ses_1", key: "digest:topic-1", name: "Topic One" },
        expect.any(AbortSignal),
      );
    });
  });

  describe("POST /session-unbind", () => {
    it("returns 400 when session_id is missing", async () => {
      const { app } = newApp();
      const res = await post(app, "/session-unbind", {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "session_id is required" });
    });

    it("returns 503 when no worker connection is wired", async () => {
      const { app } = newApp({});
      const res = await post(app, "/session-unbind", { session_id: "ses_1" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "no worker connection" });
    });

    it("returns 200 { ok: true, unbound: n } on success and does not delete local session row", async () => {
      const unbindNamedTopic = vi.fn().mockResolvedValue({ unbound: 1 });
      const { app, storage: s } = newApp({ unbindNamedTopic });
      s.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);

      const res = await post(app, "/session-unbind", { session_id: "ses_1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, unbound: 1 });
      expect(unbindNamedTopic).toHaveBeenCalledWith("ses_1", expect.any(AbortSignal));
      // Session row preserved
      expect(s.sessions.get("ses_1")).not.toBeNull();
    });

    it("returns 502 on failure", async () => {
      const unbindNamedTopic = vi.fn().mockRejectedValue(new Error("network error"));
      const { app } = newApp({ unbindNamedTopic });
      const res = await post(app, "/session-unbind", { session_id: "ses_1" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "unbind failed: network error" });
    });

    it("returns 504 on timeout", async () => {
      const unbindNamedTopic = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
      const { app } = newApp({ unbindNamedTopic, bindTimeoutMs: 10 });
      const res = await post(app, "/session-unbind", { session_id: "ses_1" });
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ error: "unbind timed out" });
    });

    it("clears the local pin on success", async () => {
      const unbindNamedTopic = vi.fn().mockResolvedValue({ unbound: 1 });
      const { app, storage: s } = newApp({ unbindNamedTopic });
      s.sessions.upsert({ sessionId: "gse_1", notify: true }, 1_000);
      s.sessions.setBoundTopicKey("gse_1", "stallwatch:mono", 1_000);

      const res = await post(app, "/session-unbind", { session_id: "gse_1" });
      expect(res.status).toBe(200);
      expect(s.sessions.get("gse_1")?.boundTopicKey).toBeNull();
    });

    it("keeps the pin when the unbind fails: the binding may still exist", async () => {
      const unbindNamedTopic = vi.fn().mockRejectedValue(new Error("network error"));
      const { app, storage: s } = newApp({ unbindNamedTopic });
      s.sessions.upsert({ sessionId: "gse_1", notify: true }, 1_000);
      s.sessions.setBoundTopicKey("gse_1", "stallwatch:mono", 1_000);

      const res = await post(app, "/session-unbind", { session_id: "gse_1" });
      expect(res.status).toBe(502);
      expect(s.sessions.get("gse_1")?.boundTopicKey).toBe("stallwatch:mono");
    });
  });

  describe("POST /session-start binding a pull session", () => {
    it("does not pin a pull session: it re-registers every episode and needs no pin", async () => {
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app, storage: s } = newApp({ bindNamedTopic });
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "digest:topic-1", name: "Topic" },
      });
      expect((await res.json()).named_topic_bound).toBe(true);
      expect(s.sessions.get("ses_pull")?.boundTopicKey).toBeNull();
    });

    it("refuses to steal a key bound to a goose-acp session", async () => {
      // stall-watch's per-tick goose-pull upkeep re-binds its mailbox to the
      // program topic every tick. Once a program has moved to a goose-acp
      // coordinator, that upkeep must not silently take the topic back.
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app, storage: s } = newApp({ bindNamedTopic });
      s.sessions.upsert(
        { sessionId: "gse_coord", notify: true, backendKind: "goose-acp", backendSessionId: "20261015_1" },
        1_000,
      );
      s.sessions.setBoundTopicKey("gse_coord", "stallwatch:mono", 1_000);

      const res = await post(app, "/session-start", {
        session_id: "ses_stallwatch_mono",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "stallwatch:mono", name: "mono" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session_id: "ses_stallwatch_mono",
        machine_id: null,
        named_topic_bound: false,
        named_topic_error: "topic is bound to goose-acp session gse_coord",
      });
      expect(bindNamedTopic).not.toHaveBeenCalled();
      expect(s.sessions.get("gse_coord")?.boundTopicKey).toBe("stallwatch:mono");
    });
  });

  describe("POST /session-start refuses backend-kind conversion", () => {
    it("409s when the supplied backend_kind differs from the stored one, and writes nothing", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert({ sessionId: "ses_pull", notify: true, backendKind: "goose-pull", label: "mailbox" }, 1_000);
      const res = await post(app, "/session-start", {
        session_id: "ses_pull",
        notify: true,
        label: "hijack",
        backend_kind: "opencode-plugin-direct",
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/backend_kind=goose-pull.*refusing to convert it to opencode-plugin-direct/);
      const row = s.sessions.get("ses_pull")!;
      expect(row.backendKind).toBe("goose-pull");
      expect(row.label).toBe("mailbox");
    });

    it("409s on a goose-acp row asked to become a pull session", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert(
        { sessionId: "gse_1", notify: true, backendKind: "goose-acp", backendEndpoint: "ws://a/acp", backendSessionId: "20261015_1" },
        1_000,
      );
      const res = await post(app, "/session-start", { session_id: "gse_1", notify: true, backend_kind: "goose-pull" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/POST \/goose\/sessions/);
      expect(s.sessions.get("gse_1")?.backendKind).toBe("goose-acp");
    });

    it("409s on a goose-acp row even when backend_kind is omitted", async () => {
      // /session-start rewrites the row wholesale (endpoint, token, cwd, label);
      // a goose-acp row is owned by /goose/sessions.
      const { app, storage: s } = newApp();
      s.sessions.upsert(
        { sessionId: "gse_1", notify: true, backendKind: "goose-acp", backendEndpoint: "ws://a/acp", backendSessionId: "20261015_1" },
        1_000,
      );
      const res = await post(app, "/session-start", {
        session_id: "gse_1",
        notify: true,
        backend_endpoint: "http://127.0.0.1:9/",
      });
      expect(res.status).toBe(409);
      expect(s.sessions.get("gse_1")?.backendEndpoint).toBe("ws://a/acp");
    });

    it("409s when asked to create a goose-acp row: those are registered through /goose/sessions", async () => {
      const { app, storage: s } = newApp();
      const res = await post(app, "/session-start", {
        session_id: "ses_new",
        notify: true,
        backend_kind: "goose-acp",
      });
      expect(res.status).toBe(409);
      expect(s.sessions.get("ses_new")).toBeNull();
    });

    it("still accepts a re-registration of the same kind, and one that omits the kind", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert({ sessionId: "ses_pull", notify: true, backendKind: "goose-pull" }, 1_000);
      expect((await post(app, "/session-start", { session_id: "ses_pull", backend_kind: "goose-pull" })).status).toBe(200);
      expect((await post(app, "/session-start", { session_id: "ses_pull" })).status).toBe(200);
      expect(s.sessions.get("ses_pull")?.backendKind).toBe("goose-pull");
    });

    it("still lets a kind be set on a row that has none", async () => {
      const { app, storage: s } = newApp();
      s.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);
      const res = await post(app, "/session-start", { session_id: "ses_1", backend_kind: "opencode-plugin-direct" });
      expect(res.status).toBe(200);
      expect(s.sessions.get("ses_1")?.backendKind).toBe("opencode-plugin-direct");
    });
  });

  describe("POST /goose/sessions with named_topic", () => {
    const body = {
      session_id: "20261015_1",
      endpoint: "ws://127.0.0.1:1/acp",
      label: "stall-watch mono",
      named_topic: { key: "stallwatch:mono", name: "mono" },
    };

    it("registers, then binds the topic to the pigeon id, and pins the row", async () => {
      const callOrder: string[] = [];
      const onSessionStart = vi.fn().mockImplementation(async () => {
        callOrder.push("register");
        return { ok: true, status: 200 } as WorkerResult;
      });
      const bindNamedTopic = vi.fn().mockImplementation(async () => {
        callOrder.push("bind");
        return { messageThreadId: 42 };
      });
      const { app, storage: s } = newApp({ machineId: "cloudbox", onSessionStart, bindNamedTopic });

      const res = await post(app, "/goose/sessions", body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({
        ok: true,
        session_id: expect.stringMatching(/^gse_/),
        backend_session_id: "20261015_1",
        backend: "goose-acp",
        machine_id: "cloudbox",
        named_topic_bound: true,
      });
      expect(callOrder).toEqual(["register", "bind"]);
      expect(bindNamedTopic).toHaveBeenCalledWith(
        { sessionId: json.session_id, key: "stallwatch:mono", name: "mono" },
        expect.any(AbortSignal),
      );
      expect(s.sessions.get(json.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");
    });

    it("is idempotent: registering again rebinds the same row", async () => {
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app } = newApp({ bindNamedTopic });
      const a = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      const b = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      expect(b.session_id).toBe(a.session_id);
      expect(b.named_topic_bound).toBe(true);
      expect(bindNamedTopic).toHaveBeenCalledTimes(2);
    });

    it("rotation: a new goose session bound to the same key takes the pin from the old row", async () => {
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app, storage: s } = newApp({ bindNamedTopic });
      const a = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      const b = (await (await post(app, "/goose/sessions", { ...body, session_id: "20261015_2" })).json()) as Record<string, unknown>;
      expect(b.session_id).not.toBe(a.session_id);
      expect(s.sessions.get(b.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");
      expect(s.sessions.get(a.session_id as string)?.boundTopicKey).toBeNull();
    });

    it("may take a key from a goose-pull session (the migration step)", async () => {
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app, storage: s } = newApp({ bindNamedTopic });
      const pull = await post(app, "/session-start", {
        session_id: "ses_stallwatch_mono",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "stallwatch:mono", name: "mono" },
      });
      expect((await pull.json()).named_topic_bound).toBe(true);

      const json = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      expect(json.named_topic_bound).toBe(true);
      expect(s.sessions.get(json.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");

      // ...and from then on the pull client's per-tick upkeep cannot take it back.
      const again = await post(app, "/session-start", {
        session_id: "ses_stallwatch_mono",
        notify: true,
        backend_kind: "goose-pull",
        named_topic: { key: "stallwatch:mono", name: "mono" },
      });
      expect((await again.json()).named_topic_error).toBe(`topic is bound to goose-acp session ${json.session_id}`);
      expect(bindNamedTopic).toHaveBeenCalledTimes(2);
    });

    it("reports, but does not fail on, a worker registration error", async () => {
      const onSessionStart = vi.fn().mockRejectedValue(new Error("network explode"));
      const bindNamedTopic = vi.fn();
      const { app, storage: s } = newApp({ onSessionStart, bindNamedTopic });
      const res = await post(app, "/goose/sessions", body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.named_topic_bound).toBe(false);
      expect(json.named_topic_error).toBe("worker registration failed");
      expect(bindNamedTopic).not.toHaveBeenCalled();
      expect(s.sessions.get(json.session_id as string)?.boundTopicKey).toBeNull();
    });

    it("reports an invalid named_topic without binding", async () => {
      const bindNamedTopic = vi.fn();
      const { app } = newApp({ bindNamedTopic });
      const res = await post(app, "/goose/sessions", { ...body, named_topic: { key: "bad key" } });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.named_topic_bound).toBe(false);
      expect(json.named_topic_error).toBe("invalid named_topic");
      expect(bindNamedTopic).not.toHaveBeenCalled();
    });

    it("reports a bind failure but keeps the pin: a failed call is not proof of no binding", async () => {
      // The worker writes the binding as its last step, so a reset after that
      // point fails here while the topic IS bound. Unpinned, that coordinator
      // would be reaped at 7 days and its topic silently unbound.
      const bindNamedTopic = vi.fn().mockRejectedValue(new Error("socket hang up"));
      const { app, storage: s } = newApp({ bindNamedTopic });
      const json = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      expect(json.named_topic_bound).toBe(false);
      expect(json.named_topic_error).toBe("bind failed: socket hang up");
      expect(s.sessions.get(json.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");
    });

    it("a failed rotation keeps the old row pinned too, until a bind succeeds", async () => {
      const bindNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 42 });
      const { app, storage: s } = newApp({ bindNamedTopic });
      const a = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;

      bindNamedTopic.mockRejectedValueOnce(new Error("socket hang up"));
      const b = (await (await post(app, "/goose/sessions", { ...body, session_id: "20261015_2" })).json()) as Record<string, unknown>;
      expect(b.named_topic_bound).toBe(false);
      expect(s.sessions.get(a.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");
      expect(s.sessions.get(b.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");

      const retry = (await (await post(app, "/goose/sessions", { ...body, session_id: "20261015_2" })).json()) as Record<string, unknown>;
      expect(retry.named_topic_bound).toBe(true);
      expect(s.sessions.get(a.session_id as string)?.boundTopicKey).toBeNull();
      expect(s.sessions.get(b.session_id as string)?.boundTopicKey).toBe("stallwatch:mono");
    });

    it("reports 'no worker connection' when the daemon has none", async () => {
      const { app } = newApp({});
      const json = (await (await post(app, "/goose/sessions", body)).json()) as Record<string, unknown>;
      expect(json.named_topic_bound).toBe(false);
      expect(json.named_topic_error).toBe("no worker connection");
    });

    it("leaves the response unchanged when named_topic is absent", async () => {
      const { app } = newApp({ machineId: "cloudbox" });
      const { named_topic: _omit, ...plain } = body;
      const json = (await (await post(app, "/goose/sessions", plain)).json()) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(["backend", "backend_session_id", "ok", "session_id"]);
    });
  });
});

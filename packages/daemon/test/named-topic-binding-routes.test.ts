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
  });
});

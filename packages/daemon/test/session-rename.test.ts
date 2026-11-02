import { describe, it, expect, vi, beforeEach } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database.js";
import { handleSessionRename, type SessionRenameDeps } from "../src/session-rename.js";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind.js";
import { OPENCODE_BACKEND_KIND } from "../src/routing/opencode-routable.js";
import { PULL_BACKEND_KIND } from "../src/adapters/goose-pull.js";
import { TopicRenameError } from "../src/worker/poller.js";

describe("handleSessionRename", () => {
  let storage: StorageDb;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  it("returns 400 when title is missing or placeholder", async () => {
    storage.sessions.upsert({ sessionId: "s1", backendKind: "goose-acp", notify: true });

    const deps: SessionRenameDeps = { storage };

    const r1 = await handleSessionRename(deps, "s1", {});
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "invalid_title" });

    const r2 = await handleSessionRename(deps, "s1", { title: "   " });
    expect(r2.status).toBe(400);

    const r3 = await handleSessionRename(deps, "s1", { title: "New Chat" });
    expect(r3.status).toBe(400);

    const r4 = await handleSessionRename(deps, "s1", { title: "New session - 2026-11-02T10:00:00Z" });
    expect(r4.status).toBe(400);
  });

  it("returns 404 when session is not in storage", async () => {
    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "unknown", { title: "Valid Title" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("returns 409 bound_session when session has boundTopicKey", async () => {
    storage.sessions.upsert({ sessionId: "s_bound", backendKind: "goose-acp", notify: true });
    storage.sessions.pinTopicKey("s_bound", "key_1");

    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "s_bound", { title: "Valid Title" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bound_session" });
  });

  it("returns 409 pull_session when backend is goose-pull", async () => {
    storage.sessions.upsert({ sessionId: "s_pull", backendKind: PULL_BACKEND_KIND, notify: true });

    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "s_pull", { title: "Valid Title" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pull_session" });
  });

  it("returns 409 unsupported_backend when backend is neither goose nor opencode-routable", async () => {
    storage.sessions.upsert({ sessionId: "s_other", backendKind: "other-backend", notify: true });

    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "s_other", { title: "Valid Title" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "unsupported_backend" });
  });

  it("returns 503 when renameGoose is missing for a goose session", async () => {
    storage.sessions.upsert({ sessionId: "s_goose", backendKind: GOOSE_BACKEND_KIND, notify: true });

    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "s_goose", { title: "Valid Title" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "goose rename not configured" });
  });

  it("returns 503 when renameOpencode is missing for an opencode session", async () => {
    storage.sessions.upsert({ sessionId: "s_oc", backendKind: OPENCODE_BACKEND_KIND, notify: true });

    const deps: SessionRenameDeps = { storage };
    const res = await handleSessionRename(deps, "s_oc", { title: "Valid Title" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "opencode rename not configured" });
  });

  it("returns 502 with step 'backend' when backend rename throws, leaving DB title and topic untouched", async () => {
    storage.sessions.upsert({ sessionId: "s_goose", backendKind: GOOSE_BACKEND_KIND, title: "Original Title", notify: true });

    const renameTopic = vi.fn();
    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockRejectedValue(new Error("goose socket closed")),
      renameTopic,
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      step: "backend",
      error: "goose socket closed",
    });

    // DB title untouched
    expect(storage.sessions.get("s_goose")?.title).toBe("Original Title");
    // Topic never called
    expect(renameTopic).not.toHaveBeenCalled();
  });

  it("succeeds for goose session: renames backend, sets DB title, renames topic with dir = session.cwd", async () => {
    storage.sessions.upsert({
      sessionId: "s_goose",
      backendKind: GOOSE_BACKEND_KIND,
      cwd: "/home/dev/work",
      notify: true,
    });

    const renameGoose = vi.fn().mockResolvedValue(undefined);
    const renameTopic = vi.fn().mockResolvedValue({ renamed: true, name: "New Title · ~/work" });
    const deps: SessionRenameDeps = {
      storage,
      renameGoose,
      renameTopic,
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      title: "New Title",
      backend: "renamed",
      stored: true,
      topic: {
        status: "renamed",
        renamed: true,
        name: "New Title · ~/work",
      },
    });

    expect(renameGoose).toHaveBeenCalledTimes(1);
    expect(storage.sessions.get("s_goose")?.title).toBe("New Title");
    expect(renameTopic).toHaveBeenCalledWith(
      { sessionId: "s_goose", title: "New Title", dir: "/home/dev/work" },
      expect.any(AbortSignal),
    );
  });

  it("succeeds for opencode session: renames opencode, sets DB title, renames topic", async () => {
    storage.sessions.upsert({
      sessionId: "s_oc",
      backendKind: OPENCODE_BACKEND_KIND,
      cwd: "/projects/repo",
      notify: true,
    });

    const renameOpencode = vi.fn().mockResolvedValue(undefined);
    const renameTopic = vi.fn().mockResolvedValue({ renamed: true, name: "Plan v2 · ~/repo" });
    const deps: SessionRenameDeps = {
      storage,
      renameOpencode,
      renameTopic,
    };

    const res = await handleSessionRename(deps, "s_oc", { title: "Plan v2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      title: "Plan v2",
      backend: "renamed",
      stored: true,
      topic: {
        status: "renamed",
        renamed: true,
        name: "Plan v2 · ~/repo",
      },
    });

    expect(renameOpencode).toHaveBeenCalledTimes(1);
    expect(storage.sessions.get("s_oc")?.title).toBe("Plan v2");
  });

  it("skips topic rename when renameTopic is absent (no worker)", async () => {
    storage.sessions.upsert({
      sessionId: "s_goose",
      backendKind: GOOSE_BACKEND_KIND,
      notify: true,
    });

    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockResolvedValue(undefined),
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      title: "New Title",
      backend: "renamed",
      stored: true,
      topic: {
        status: "skipped",
        reason: "no_worker",
      },
    });

    expect(storage.sessions.get("s_goose")?.title).toBe("New Title");
  });

  it("returns 502 with step 'topic' and stored:true when topic rename throws", async () => {
    storage.sessions.upsert({
      sessionId: "s_goose",
      backendKind: GOOSE_BACKEND_KIND,
      notify: true,
    });

    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockResolvedValue(undefined),
      renameTopic: vi.fn().mockRejectedValue(new Error("topics/rename returned 502: telegram_failed")),
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      step: "topic",
      backend: "renamed",
      stored: true,
      error: "topics/rename returned 502: telegram_failed",
    });

    // DB title was updated because step 1 & 2 succeeded
    expect(storage.sessions.get("s_goose")?.title).toBe("New Title");
  });

  it("passes the worker's status and error code through so a caller can tell retryable from terminal", async () => {
    storage.sessions.upsert({ sessionId: "s_goose", backendKind: GOOSE_BACKEND_KIND, notify: true });
    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockResolvedValue(undefined),
      renameTopic: vi.fn().mockRejectedValue(new TopicRenameError(409, "bound_session")),
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      step: "topic",
      worker_status: 409,
      worker_error: "bound_session",
    });
  });

  it("marks topic status as 'unchanged' when worker returns renamed: false", async () => {
    storage.sessions.upsert({
      sessionId: "s_goose",
      backendKind: GOOSE_BACKEND_KIND,
      notify: true,
    });

    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockResolvedValue(undefined),
      renameTopic: vi.fn().mockResolvedValue({ renamed: false, reason: "topics_disabled" }),
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      title: "New Title",
      backend: "renamed",
      stored: true,
      topic: {
        status: "unchanged",
        renamed: false,
        reason: "topics_disabled",
      },
    });
  });

  it("defaults dir to empty string when session cwd is null", async () => {
    storage.sessions.upsert({
      sessionId: "s_goose",
      backendKind: GOOSE_BACKEND_KIND,
      cwd: null,
      notify: true,
    });

    const renameTopic = vi.fn().mockResolvedValue({ renamed: true });
    const deps: SessionRenameDeps = {
      storage,
      renameGoose: vi.fn().mockResolvedValue(undefined),
      renameTopic,
    };

    const res = await handleSessionRename(deps, "s_goose", { title: "New Title" });
    expect(res.status).toBe(200);
    expect(renameTopic).toHaveBeenCalledWith(
      { sessionId: "s_goose", title: "New Title", dir: "" },
      expect.any(AbortSignal),
    );
  });
});

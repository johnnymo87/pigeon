import { describe, expect, it, vi } from "vitest";
import { createRequesterTagResolver } from "../src/swarm/requester-tag";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import type { TagKeySession, TagKeySessionLookup } from "../src/tag-key";

describe("createRequesterTagResolver", () => {
  function makeSessions(rows: Record<string, TagKeySession>): TagKeySessionLookup {
    return {
      get: (id: string) => rows[id] ?? null,
    };
  }

  it("passes through ses_ session id to oc-tags which", async () => {
    const runOcTags = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "my-project\tmanual\tses_root\tsession\n",
      stderr: "",
    });
    const sessions = makeSessions({});
    const resolve = createRequesterTagResolver({ sessions, runOcTags });

    const tag = await resolve("ses_abc12345");

    expect(tag).toBe("my-project");
    expect(runOcTags).toHaveBeenCalledWith(["which", "--", "ses_abc12345"]);
  });

  it("maps goose row to goose:<native> for oc-tags which", async () => {
    const runOcTags = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "goose-work\tmanual\tses_root\tsession\n",
      stderr: "",
    });
    const sessions = makeSessions({
      gse_session123: {
        sessionId: "gse_session123",
        backendKind: GOOSE_BACKEND_KIND,
        backendSessionId: "native_sess_99",
      },
    });
    const resolve = createRequesterTagResolver({ sessions, runOcTags });

    const tag = await resolve("gse_session123");

    expect(tag).toBe("goose-work");
    expect(runOcTags).toHaveBeenCalledWith(["which", "--", "goose:native_sess_99"]);
  });

  it("returns null for unmappable gse_ without calling oc-tags", async () => {
    const runOcTags = vi.fn();
    // No row in sessions
    const sessions = makeSessions({});
    const resolve = createRequesterTagResolver({ sessions, runOcTags });

    const tag = await resolve("gse_missing");

    expect(tag).toBeNull();
    expect(runOcTags).not.toHaveBeenCalled();
  });

  it("inherits program for coordinator without calling oc-tags", async () => {
    const runOcTags = vi.fn();
    const sessions = makeSessions({
      gse_coordinator: {
        sessionId: "gse_coordinator",
        backendKind: GOOSE_BACKEND_KIND,
        backendSessionId: "native_coord",
        boundTopicKey: "stallwatch:honk-app",
      },
    });
    const resolve = createRequesterTagResolver({ sessions, runOcTags });

    const tag = await resolve("gse_coordinator");

    expect(tag).toBe("honk-app");
    expect(runOcTags).not.toHaveBeenCalled();
  });

  it("returns null and logs when coordinator program tag is invalid without calling oc-tags", async () => {
    const runOcTags = vi.fn();
    const log = vi.fn();
    const sessions = makeSessions({
      gse_invalid_coord: {
        sessionId: "gse_invalid_coord",
        backendKind: GOOSE_BACKEND_KIND,
        backendSessionId: "native_coord_bad",
        boundTopicKey: "stallwatch:INVALID TAG WITH SPACES",
      },
    });
    const resolve = createRequesterTagResolver({ sessions, runOcTags, log });

    const tag = await resolve("gse_invalid_coord");

    expect(tag).toBeNull();
    expect(runOcTags).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("coordinator"),
      expect.objectContaining({ sessionId: "gse_invalid_coord" }),
    );
  });

  it("returns null when oc-tags which returns directory tag (not session tag)", async () => {
    const runOcTags = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "repo-tag\tmanual\tses_root\tdirectory\n",
      stderr: "",
    });
    const sessions = makeSessions({});
    const resolve = createRequesterTagResolver({ sessions, runOcTags });

    const tag = await resolve("ses_abc12345");

    expect(tag).toBeNull();
  });

  it("returns null when oc-tags runner is not available", async () => {
    const sessions = makeSessions({});
    const resolve = createRequesterTagResolver({ sessions, runOcTags: undefined });

    const tag = await resolve("ses_abc12345");

    expect(tag).toBeNull();
  });
});

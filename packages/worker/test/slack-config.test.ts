/**
 * Slack outbound, task 1 (bead pigeon-4ogz.3): workspace config from secrets, the D1 handle
 * tables, and `GET /whoami`'s `transport`. Plan: docs/plans/2026-11-20-slack-outbound-plan.md.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import {
  SLACK_HANDLE_MIN,
  clearSlackConfigWarnings,
  slackChatId,
  slackWorkspaceForMachine,
  slackWorkspaceForTeam,
  teamIdOfChat,
} from "../src/chat/slack-config";
import { sha256Hex } from "../src/credentials";

const WS = {
  teamId: "T0CFG",
  appId: "A0CFG",
  domain: "acme",
  botToken: "xoxb-1",
  userToken: "xoxp-1",
  signingSecret: "sign",
  ownerUserId: "U0OWNER",
};

function withSecret(key: string, value: unknown): Env {
  return { ...env, [key]: typeof value === "string" ? value : JSON.stringify(value) } as Env;
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearSlackConfigWarnings();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("slackWorkspaceForMachine", () => {
  it("reads SLACK_WORKSPACE_<MACHINE>, upper-casing and mapping - to _", () => {
    const e = withSecret("SLACK_WORKSPACE_CLOUD_BOX", WS);
    expect(slackWorkspaceForMachine(e, "cloud-box")).toEqual(WS);
    expect(slackWorkspaceForMachine(e, "cloudbox")).toBeNull();
  });

  it("is absent with no secret, and never logs for that", () => {
    expect(slackWorkspaceForMachine(env as Env, "nosuch-machine")).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("treats unparseable JSON as absent and logs once per key per isolate", () => {
    const e = withSecret("SLACK_WORKSPACE_BROKEN", "{not json");
    expect(slackWorkspaceForMachine(e, "broken")).toBeNull();
    expect(slackWorkspaceForMachine(e, "broken")).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // The log names the key and never echoes the secret value.
    expect(JSON.stringify(errorSpy.mock.calls[0])).toContain("SLACK_WORKSPACE_BROKEN");
    expect(JSON.stringify(errorSpy.mock.calls[0])).not.toContain("not json");
  });

  it("treats a missing or non-string field as absent", () => {
    for (const field of Object.keys(WS)) {
      const bad: Record<string, unknown> = { ...WS };
      delete bad[field];
      expect(slackWorkspaceForMachine(withSecret("SLACK_WORKSPACE_PART", bad), "part")).toBeNull();
    }
    expect(
      slackWorkspaceForMachine(withSecret("SLACK_WORKSPACE_PART", { ...WS, teamId: 5 }), "part"),
    ).toBeNull();
    expect(
      slackWorkspaceForMachine(withSecret("SLACK_WORKSPACE_PART", { ...WS, botToken: "" }), "part"),
    ).toBeNull();
    expect(slackWorkspaceForMachine(withSecret("SLACK_WORKSPACE_PART", "null"), "part")).toBeNull();
  });

  it("keeps only the known fields", () => {
    const e = withSecret("SLACK_WORKSPACE_EXTRA", { ...WS, extra: "x" });
    expect(slackWorkspaceForMachine(e, "extra")).toEqual(WS);
  });
});

describe("slackWorkspaceForTeam", () => {
  it("finds the workspace by team id among the SLACK_WORKSPACE_* keys", () => {
    const e = {
      ...withSecret("SLACK_WORKSPACE_ONE", { ...WS, teamId: "T1" }),
      SLACK_WORKSPACE_TWO: JSON.stringify({ ...WS, teamId: "T2", domain: "two" }),
      SLACK_WORKSPACE_JUNK: "{",
      SLACK_OTHER: JSON.stringify({ ...WS, teamId: "T3" }),
    } as unknown as Env;
    expect(slackWorkspaceForTeam(e, "T2")?.domain).toBe("two");
    expect(slackWorkspaceForTeam(e, "T1")?.teamId).toBe("T1");
    expect(slackWorkspaceForTeam(e, "T3")).toBeNull();
    expect(slackWorkspaceForTeam(e, "T9")).toBeNull();
  });
});

describe("chat addresses", () => {
  it("round-trips slack:<team>", () => {
    expect(slackChatId(WS)).toBe("slack:T0CFG");
    expect(teamIdOfChat("slack:T0CFG")).toBe("T0CFG");
  });
  it("teamIdOfChat is null for anything else", () => {
    expect(teamIdOfChat("8248645256")).toBeNull();
    expect(teamIdOfChat(8248645256)).toBeNull();
    expect(teamIdOfChat("slack:")).toBeNull();
    expect(teamIdOfChat("slackT1")).toBeNull();
  });
});

describe("slack handle tables", () => {
  it("hands out handles at or above 2^40 without touching sqlite_sequence", async () => {
    expect(SLACK_HANDLE_MIN).toBe(2 ** 40);
    const conv = await env.DB.prepare(
      "INSERT INTO slack_conversations (team_id, channel_id, created_at) VALUES ('T0H', 'C1', 1) RETURNING handle",
    ).first<{ handle: number }>();
    expect(conv!.handle).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    const post = await env.DB.prepare(
      "INSERT INTO slack_posts (team_id, channel_id, ts, created_at) VALUES ('T0H', 'C1', '1.1', 1) RETURNING handle",
    ).first<{ handle: number }>();
    expect(post!.handle).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
  });

  it("applying the schema twice keeps exactly one seed row per table", async () => {
    for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_conversations WHERE team_id = '_seed'").first<{ n: number }>();
    const p = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_posts WHERE team_id = '_seed'").first<{ n: number }>();
    expect(c!.n).toBe(1);
    expect(p!.n).toBe(1);
  });

  it("(team, channel) and (team, channel, ts) are unique", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO slack_conversations (team_id, channel_id, created_at) VALUES ('T0U', 'C1', 1)",
    ).run();
    const dup = await env.DB.prepare(
      "INSERT OR IGNORE INTO slack_conversations (team_id, channel_id, created_at) VALUES ('T0U', 'C1', 2)",
    ).run();
    expect(dup.meta.changes).toBe(0);
  });
});

describe("GET /whoami transport", () => {
  const KEY = "pgk_" + "S".repeat(43);
  const MACHINE = "slack-who";

  async function whoami(e: Env, key: string): Promise<unknown> {
    const res = await worker.fetch(
      new Request("https://worker/whoami", { headers: { Authorization: `Bearer ${key}` } }),
      e,
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
       VALUES (?, ?, ?, NULL, 'test')`,
    )
      .bind(await sha256Hex(KEY), MACHINE, Date.now())
      .run();
  });

  it("adds transport: slack only for a machine whose workspace secret is valid", async () => {
    const e = withSecret("SLACK_WORKSPACE_SLACK_WHO", WS);
    expect(await whoami(e, KEY)).toEqual({ credential: "machine", machine_id: MACHINE, transport: "slack" });
  });

  it("is byte-identical to the Telegram response with no secret", async () => {
    expect(await whoami(env as Env, KEY)).toEqual({ credential: "machine", machine_id: MACHINE });
  });

  it("a malformed secret reads as Telegram", async () => {
    const e = withSecret("SLACK_WORKSPACE_SLACK_WHO", { ...WS, botToken: undefined });
    expect(await whoami(e, KEY)).toEqual({ credential: "machine", machine_id: MACHINE });
  });

  it("never adds transport for the shared key, even with secrets present", async () => {
    const e = withSecret("SLACK_WORKSPACE_SLACK_WHO", WS);
    expect(await whoami(e, "test-api-key")).toEqual({ credential: "shared", machine_id: null });
  });
});

describe("parse cache", () => {
  const secretParses = (spy: ReturnType<typeof vi.spyOn>, raw: string) =>
    spy.mock.calls.filter((c: unknown[]) => c[0] === raw).length;

  it("parses a given secret string once per isolate, however often it is looked up", () => {
    const raw = JSON.stringify(WS);
    const e = withSecret("SLACK_WORKSPACE_CACHED", raw);
    const spy = vi.spyOn(JSON, "parse");
    try {
      for (let i = 0; i < 3; i++) {
        expect(slackWorkspaceForMachine(e, "cached")).toEqual(WS);
        expect(slackWorkspaceForTeam(e, WS.teamId)).toEqual(WS);
      }
      expect(secretParses(spy, raw)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("is keyed on the raw string, so a rotated secret is read afresh", () => {
    const first = withSecret("SLACK_WORKSPACE_ROTATED", WS);
    expect(slackWorkspaceForMachine(first, "rotated")?.botToken).toBe("xoxb-1");
    const second = withSecret("SLACK_WORKSPACE_ROTATED", { ...WS, botToken: "xoxb-2" });
    expect(slackWorkspaceForMachine(second, "rotated")?.botToken).toBe("xoxb-2");
  });

  it("caches a broken secret too, and still logs it once", () => {
    const e = withSecret("SLACK_WORKSPACE_BAD_CACHE", "{nope");
    const spy = vi.spyOn(JSON, "parse");
    try {
      for (let i = 0; i < 3; i++) expect(slackWorkspaceForMachine(e, "bad-cache")).toBeNull();
      expect(secretParses(spy, "{nope")).toBe(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

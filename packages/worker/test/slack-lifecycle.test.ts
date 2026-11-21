/**
 * Slack housekeeping and link surfaces (bead pigeon-4ogz.3, task 4): the topic reaper's Slack
 * rows, the `slack_posts` retention sweep, `/topics/rename` on a Slack row, and the Slack link
 * URLs of mention buttons and `/topics/lookup`. Plan: docs/plans/2026-11-20-slack-outbound-plan.md
 * ("Other call sites").
 *
 * Slack is a fetchMock with `disableNetConnect` and `assertNoPendingInterceptors`, so a missing OR
 * an unexpected provider call fails the test. Every test uses its own ids: the D1
 * tables are shared by the whole file.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import d1Schema from "../src/d1-schema.sql?raw";
import { sha256Hex } from "../src/credentials";
import { hasSlackWorkspaceSecret, slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { SLACK_POST_SWEEP_CAP, SLACK_POST_TTL_MS, sweepSlackPosts } from "../src/chat/slack-posts";
import { slackArchiveUrl } from "../src/slack";
import { resolveMentionKeyboard } from "../src/mention-links";
import { handleTopicLookup } from "../src/topic-lookup";
import { handleTopicRename } from "../src/topic-rename";
import { closeOrphanedTopics, reapTopics } from "../src/topic-reaper";
import { finalize, getBySession, reserve } from "../src/topics";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  // The D1 tables are shared with the other test files, and the reaper and the cron select ANY
  // orphaned row, so a Telegram topic left behind by another file would be closed in these tests.
  await env.DB.prepare("DELETE FROM topics").run();
  fetchMock.activate();
  fetchMock.disableNetConnect();
  slackCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
});

// ─── fixtures ──────────────────────────────────────────────────────────────

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;

interface Machine {
  machineId: string;
  key: string;
  ws: SlackWorkspace;
}

async function mkMachine(domain = "acme"): Promise<Machine> {
  const machineId = `sl${stamp()}`.toLowerCase().slice(0, 30);
  const key = ("pgk_" + machineId + "x".repeat(43)).slice(0, 47);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
  const ws: SlackWorkspace = {
    teamId: `T${stamp()}`.toUpperCase(),
    appId: "A0APP",
    domain,
    botToken: "xoxb-bot",
    userToken: "xoxp-user",
    signingSecret: "sig",
    ownerUserId: "U0OWNER",
  };
  return { machineId, key, ws };
}

function envFor(machines: Machine[], extra: Record<string, unknown> = {}): Env {
  const secrets: Record<string, string> = {};
  for (const m of machines) secrets[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  return { ...env, ...secrets, ...extra } as unknown as Env;
}

interface SlackCall {
  method: string;
  params: URLSearchParams;
}
const slackCalls: SlackCall[] = [];

function slack(method: string, reply: Record<string, unknown>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(200, (opts: { body?: unknown }) => {
      slackCalls.push({ method, params: new URLSearchParams(String(opts.body)) });
      return reply;
    });
}
const methods = () => slackCalls.map((c) => c.method);

async function seedChannel(teamId: string, channelId: string): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(teamId, channelId)
    .first<{ handle: number }>();
  return row!.handle;
}

async function seedSession(machineId: string, updatedAt = Date.now()): Promise<string> {
  const sessionId = `ses_${String(++counter).padStart(4, "0")}lc${Date.now().toString(36)}`;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, 'l', ?, ?)",
  )
    .bind(sessionId, machineId, updatedAt, updatedAt)
    .run();
  return sessionId;
}

/** A session's Slack topic row, optionally already closed. */
async function seedSlackTopic(
  sessionId: string,
  machineId: string,
  ws: SlackWorkspace,
  opts: { closedAt?: number } = {},
) {
  const channelId = `CLC${stamp()}`.toUpperCase();
  const handle = await seedChannel(ws.teamId, channelId);
  await reserve(env.DB, { sessionId, machineId, chatId: slackChatId(ws), name: "Old title · ~/p" });
  await finalize(env.DB, {
    sessionId,
    chatId: slackChatId(ws),
    messageThreadId: handle,
    name: "Old title · ~/p",
    provisional: false,
  });
  if (opts.closedAt !== undefined) {
    await env.DB.prepare("UPDATE topics SET state = 'closed', closed_at = ? WHERE session_id = ?")
      .bind(opts.closedAt, sessionId)
      .run();
  }
  return { channelId, handle };
}

const SHARED = "test-api-key";

// ─── slack_posts retention ─────────────────────────────────────────────────

describe("sweepSlackPosts", () => {
  const post = async (team: string, ts: string, createdAt: number) => {
    await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, 'C1', ?, 'x', ?)")
      .bind(team, ts, createdAt)
      .run();
  };
  const countFor = async (team: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_posts WHERE team_id = ?").bind(team).first<{ n: number }>())!.n;

  it("deletes posts past the 30-day TTL, keeps newer ones, and never the _seed row", async () => {
    const team = `TSWEEP${stamp()}`;
    const now = 100 * DAY;
    await post(team, "1.1", now - SLACK_POST_TTL_MS - 1);
    await post(team, "1.2", now - SLACK_POST_TTL_MS - DAY);
    await post(team, "1.3", now - SLACK_POST_TTL_MS + 1000);
    await post(team, "1.4", now);
    const deleted = await sweepSlackPosts(env.DB, { now });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await countFor(team)).toBe(2);
    const seed = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_posts WHERE team_id = '_seed'").first<{ n: number }>();
    expect(seed!.n).toBe(1);
  });

  it("deletes at most `cap` rows per call, oldest first", async () => {
    const team = `TCAP${stamp()}`;
    const now = 500 * DAY;
    for (let i = 0; i < 5; i++) await post(team, `2.${i}`, now - SLACK_POST_TTL_MS - (5 - i) * 1000);
    // Sweep everything older than the cutoff in this file first so only this team's rows count.
    await sweepSlackPosts(env.DB, { now: now - 2 * SLACK_POST_TTL_MS });
    expect(await sweepSlackPosts(env.DB, { now, cap: 2 })).toBe(2);
    expect(await countFor(team)).toBe(3);
    const oldest = await env.DB.prepare("SELECT ts FROM slack_posts WHERE team_id = ? ORDER BY created_at LIMIT 1")
      .bind(team)
      .first<{ ts: string }>();
    expect(oldest?.ts).toBe("2.2");
    expect(SLACK_POST_SWEEP_CAP).toBe(5000);
  });

  it("logs and returns 0 when the table is missing or D1 errors (never throws)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      prepare: () => {
        throw new Error("no such table: slack_posts");
      },
    } as unknown as D1Database;
    expect(await sweepSlackPosts(broken)).toBe(0);
    const rejecting = {
      prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error("D1_ERROR")) }) }),
    } as unknown as D1Database;
    expect(await sweepSlackPosts(rejecting)).toBe(0);
    // Only the real D1 error is an error: a missing table is a quiet log line (see below).
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("a missing table is a console.log, not an error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const missing = {
      prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error("D1_ERROR: no such table: slack_posts")) }) }),
    } as unknown as D1Database;
    expect(await sweepSlackPosts(missing)).toBe(0);
    expect(err).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

// ─── the hourly cron ───────────────────────────────────────────────────────

describe("scheduled", () => {
  it("sweeps old slack_posts and archives a Slack orphan in the close window, using the Slack secret", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    // 04:00 UTC: inside the daily close window, so orphans are closed this tick.
    const scheduledTime = Date.UTC(2031, 0, 15, 4, 0, 0);
    vi.setSystemTime(scheduledTime);
    try {
      const team = m.ws.teamId;
      await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, 'C1', '9.1', 'x', ?)")
        .bind(team, scheduledTime - SLACK_POST_TTL_MS - DAY)
        .run();
      const sessionId = await seedSession(m.machineId, scheduledTime - 30 * DAY);
      const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws);
      slack("conversations.archive", { ok: true });

      await worker.scheduled({ scheduledTime, cron: "0 * * * *", noRetry() {} } as unknown as ScheduledController, e);

      expect(slackCalls.find((c) => c.method === "conversations.archive")?.params.get("channel")).toBe(channelId);
      expect((await getBySession(env.DB, sessionId))?.state).toBe("closed");
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_posts WHERE team_id = ?").bind(team).first<{ n: number }>();
      expect(left!.n).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduled: the slack_posts sweep only runs when Slack is configured", () => {
  const run = (e: Env, scheduledTime: number) =>
    worker.scheduled({ scheduledTime, cron: "0 * * * *", noRetry() {} } as unknown as ScheduledController, e);
  const oldPost = async (team: string) => {
    await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, 'C1', '8.1', 'x', ?)")
      .bind(team, Date.now() - SLACK_POST_TTL_MS - DAY)
      .run();
  };
  const count = async (team: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_posts WHERE team_id = ?").bind(team).first<{ n: number }>())!.n;

  it("a worker with no SLACK_WORKSPACE_* secret leaves slack_posts alone", async () => {
    const team = `TNOSLACK${stamp()}`;
    await oldPost(team);
    expect(hasSlackWorkspaceSecret({ ...env } as unknown as Env)).toBe(false);
    await run({ ...env } as unknown as Env, Date.UTC(2031, 0, 15, 5, 0, 0));
    expect(await count(team)).toBe(1);
  });

  it("with one, it sweeps", async () => {
    const m = await mkMachine();
    const team = m.ws.teamId;
    await oldPost(team);
    await run(envFor([m]), Date.UTC(2031, 0, 15, 5, 0, 0));
    expect(await count(team)).toBe(0);
  });

  it("hasSlackWorkspaceSecret counts any SLACK_WORKSPACE_* key, valid or not, and nothing else", () => {
    expect(hasSlackWorkspaceSecret({ SLACK_NOTIFY_OWNER: "x" } as unknown as Env)).toBe(false);
    expect(hasSlackWorkspaceSecret({ SLACK_WORKSPACE_DEVBOX: "not json" } as unknown as Env)).toBe(true);
  });
});

// ─── reaper ────────────────────────────────────────────────────────────────

describe("topic reaper on Slack rows", () => {
  it("reapTopics drops a Slack row with no provider call, even without the workspace secret", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId, 1000);
    const now = 400 * DAY;
    await seedSlackTopic(sessionId, m.machineId, m.ws, { closedAt: now - 40 * DAY });
    // No interceptors and net connect disabled: a provider call would fail the test.
    const res = await reapTopics(env.DB, { now, limit: 50 });
    expect(res.reaped).toBeGreaterThanOrEqual(1);
    expect(await getBySession(env.DB, sessionId)).toBeNull();
    // The conversation mapping stays: a channel can only be archived, never deleted.
    const conv = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_conversations WHERE team_id = ?")
      .bind(m.ws.teamId)
      .first<{ n: number }>();
    expect(conv!.n).toBe(1);
  });

  it("closeOrphanedTopics archives a Slack row through the transport, given the env", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId, 1000);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws);
    slack("conversations.archive", { ok: true });
    const res = await closeOrphanedTopics(env.DB, { now: 400 * DAY, limit: 50, env: envFor([m]) });
    expect(res.closedOrphans).toBeGreaterThanOrEqual(1);
    expect(slackCalls.find((c) => c.method === "conversations.archive")?.params.get("channel")).toBe(channelId);
    expect((await getBySession(env.DB, sessionId))?.state).toBe("closed");
  });
});

describe("closeOrphanedTopics: numeric rows, reservations and a 429", () => {
  const TG_CHAT = "-100777";
  const NOW = 400 * DAY;

  async function seedOrphan(machineId: string, chat: { ws: SlackWorkspace } | { tg: string } | { reservation: string }) {
    const sessionId = await seedSession(machineId, 1000);
    if ("ws" in chat) {
      await seedSlackTopic(sessionId, machineId, chat.ws);
    } else if ("reservation" in chat) {
      await reserve(env.DB, { sessionId, machineId, chatId: chat.reservation, name: "reserved" });
    } else {
      await reserve(env.DB, { sessionId, machineId, chatId: chat.tg, name: "tg" });
      await finalize(env.DB, {
        sessionId,
        chatId: chat.tg,
        messageThreadId: 100 + ++counter,
        name: "tg",
        provisional: false,
      });
    }
    return sessionId;
  }

  const states = async (ids: string[]) => Promise.all(ids.map(async (id) => (await getBySession(env.DB, id))?.state));

  it("a 429 skips the remaining provider calls, and reports rateLimited; rows needing no call are still handled", async () => {
    const m = await mkMachine();
    const slackIds = [await seedOrphan(m.machineId, { ws: m.ws }), await seedOrphan(m.machineId, { ws: m.ws })];
    const numeric = await seedOrphan(m.machineId, { tg: TG_CHAT });
    const reserved = await seedOrphan(m.machineId, { reservation: slackChatId(m.ws) });
    // One archive only: a second Slack call would find no interceptor and fail the test.
    fetchMock
      .get("https://slack.com")
      .intercept({ method: "POST", path: "/api/conversations.archive" })
      .reply(429, { ok: false, error: "ratelimited" }, { headers: { "retry-after": "5" } });

    const res = await closeOrphanedTopics(env.DB, { now: NOW, limit: 50, env: envFor([m]) });

    expect(res.rateLimited).toBe(true);
    // The reservation has no conversation to close: it is just marked closed. The numeric row is
    // deleted without a call and is not counted as closed.
    expect(res.closedOrphans).toBeGreaterThanOrEqual(1);
    expect(await states([reserved])).toEqual(["closed"]);
    expect(await getBySession(env.DB, numeric)).toBeNull();
    // The limited row and the skipped one both stay open for the next tick.
    expect(await states(slackIds)).toEqual(["open", "open"]);
  });

  it("numeric rows are only deleted from D1: no provider call, no 429 accounting, not counted as closed", async () => {
    const m = await mkMachine();
    const ids = [await seedOrphan(m.machineId, { tg: TG_CHAT }), await seedOrphan(m.machineId, { tg: TG_CHAT })];
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM topics").first<{ n: number }>())!.n;
    // No interceptors and net connect disabled: a provider call would fail the test.
    const res = await closeOrphanedTopics(env.DB, { now: NOW, limit: 50 });
    expect(res).toEqual({ closedOrphans: 0, rateLimited: false });
    expect(await Promise.all(ids.map((id) => getBySession(env.DB, id)))).toEqual([null, null]);
    expect(before).toBe(2);
  });

  it("a closed numeric row is reaped by deleting it, with no provider call", async () => {
    const m = await mkMachine();
    const sessionId = await seedOrphan(m.machineId, { tg: TG_CHAT });
    await env.DB.prepare("UPDATE topics SET state = 'closed', closed_at = ? WHERE session_id = ?")
      .bind(NOW - 40 * DAY, sessionId)
      .run();
    const res = await reapTopics(env.DB, { now: NOW, limit: 50 });
    expect(res.reaped).toBe(1);
    expect(await getBySession(env.DB, sessionId)).toBeNull();
  });

  it("no 429: rateLimited is false and the Slack row is closed", async () => {
    const m = await mkMachine();
    const id = await seedOrphan(m.machineId, { ws: m.ws });
    slack("conversations.archive", { ok: true });
    const res = await closeOrphanedTopics(env.DB, { now: NOW, limit: 50, env: envFor([m]) });
    expect(res).toEqual({ closedOrphans: 1, rateLimited: false });
    expect(await states([id])).toEqual(["closed"]);
  });
});

// ─── /topics/rename ────────────────────────────────────────────────────────

describe("/topics/rename on a Slack row", () => {
  it("renames the channel and topic line from the row's session id, then the D1 name", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws);
    slack("conversations.info", { ok: true, channel: { name: "old-title", topic: { value: "Old" } } });
    slack("conversations.rename", { ok: true });
    slack("conversations.setTopic", { ok: true });

    const res = await handleTopicRename(
      env.DB,
      envFor([m]),
      new Request("https://worker/topics/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.key}` },
        body: JSON.stringify({ sessionId, title: "Fresh name", dir: "~/projects/p" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: true, name: "Fresh name · ~/projects/p" });
    expect(methods()).toEqual(["conversations.info", "conversations.rename", "conversations.setTopic"]);
    expect(slackCalls[1]!.params.get("channel")).toBe(channelId);
    const sid8 = sessionId.replace(/^ses_/, "").toLowerCase().slice(0, 8);
    expect(slackCalls[1]!.params.get("name")).toBe(`fresh-name-${sid8}`);
    expect(slackCalls[2]!.params.get("topic")).toContain(`🆔 ${sessionId}`);
    expect((await getBySession(env.DB, sessionId))?.name).toBe("Fresh name · ~/projects/p");
  });
});

// ─── link URLs ─────────────────────────────────────────────────────────────

describe("Slack link URLs", () => {
  const TG_SESSION = () => `ses_${stamp()}tg00000000`;

  it("mention buttons link a Slack row to its channel's archive URL, and a numeric row gets none", async () => {
    const m = await mkMachine("acme");
    const slackSession = `ses_${stamp()}sl0000000`;
    const { channelId } = await seedSlackTopic(slackSession, m.machineId, m.ws);
    const tgSession = TG_SESSION();
    await reserve(env.DB, { sessionId: tgSession, machineId: m.machineId, chatId: "-1001234567890", name: "tg · ~/p" });
    await finalize(env.DB, { sessionId: tgSession, chatId: "-1001234567890", messageThreadId: 4321, name: "tg · ~/p", provisional: false });

    const text = `see ${slackSession} and ${tgSession}`;
    const kb = await resolveMentionKeyboard(env.DB, text, "ses_self00000000", envFor([m]));
    expect(kb?.inline_keyboard.map((r) => r[0]!.url)).toEqual([slackArchiveUrl("acme", channelId)]);
  });

  it("a Slack row gets no button without an env, without a workspace for its team, or without a conversation", async () => {
    const m = await mkMachine();
    const s1 = `ses_${stamp()}nb1000000`;
    await seedSlackTopic(s1, m.machineId, m.ws);
    expect(await resolveMentionKeyboard(env.DB, `x ${s1}`, "ses_self00000000")).toBeUndefined();
    expect(await resolveMentionKeyboard(env.DB, `x ${s1}`, "ses_self00000000", envFor([]))).toBeUndefined();

    const s2 = `ses_${stamp()}nb2000000`;
    await reserve(env.DB, { sessionId: s2, machineId: m.machineId, chatId: slackChatId(m.ws), name: "n" });
    await finalize(env.DB, { sessionId: s2, chatId: slackChatId(m.ws), messageThreadId: 2 ** 40 + 99999, name: "n", provisional: false });
    expect(await resolveMentionKeyboard(env.DB, `x ${s2}`, "ses_self00000000", envFor([m]))).toBeUndefined();
  });

  const lookup = (e: Env, ids: string[]) =>
    handleTopicLookup(
      env.DB,
      e,
      new Request("https://worker/topics/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SHARED}` },
        body: JSON.stringify({ sessionIds: ids }),
      }),
    );

  it("/topics/lookup adds url on Slack rows only; a numeric entry has no url field", async () => {
    const m = await mkMachine("beta");
    const slackSession = `ses_${stamp()}lk0000000`;
    const { channelId, handle } = await seedSlackTopic(slackSession, m.machineId, m.ws);
    const tgSession = TG_SESSION();
    await reserve(env.DB, { sessionId: tgSession, machineId: m.machineId, chatId: "-1001234567890", name: "tg" });
    await finalize(env.DB, { sessionId: tgSession, chatId: "-1001234567890", messageThreadId: 777, name: "tg", provisional: false });

    const res = await lookup(envFor([m]), [slackSession, tgSession, "ses_missing"]);
    expect(await res.json()).toEqual({
      topics: {
        [slackSession]: {
          chatId: slackChatId(m.ws),
          messageThreadId: handle,
          state: "open",
          url: slackArchiveUrl("beta", channelId),
        },
        [tgSession]: { chatId: "-1001234567890", messageThreadId: 777, state: "open" },
        ses_missing: null,
      },
    });
  });

  it("/topics/lookup answers url null for a Slack row it cannot link (workspace secret gone)", async () => {
    const m = await mkMachine();
    const s = `ses_${stamp()}lk1000000`;
    const { handle } = await seedSlackTopic(s, m.machineId, m.ws);
    const res = await lookup(envFor([]), [s]);
    expect(await res.json()).toEqual({
      topics: { [s]: { chatId: slackChatId(m.ws), messageThreadId: handle, state: "open", url: null } },
    });
  });
});

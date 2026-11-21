/**
 * POST /notifications/send with `rich: {markdown, dialect: "slack"}` (pigeon-p909, ported to Slack
 * by pigeon-4ogz.13): the worker tries one Slack markdown block and, on a rejection, sends the
 * plain text it was given, once, loudly. Which dialect may go rich at all, the size limit and the
 * kill switch are in slack-routing.test.ts ("rich dialect matrix"); this file is the retry,
 * dedupe and mention-button behaviour around that send.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { handleSendNotification } from "../src/notifications";
import {
  envWith,
  mkSlackMachine,
  postJson,
  posted,
  resetSlackCalls,
  seedSession,
  seedSlackTopic,
  slack,
  slackCalls,
  slackOf,
  stamp,
  type SlackMachine,
} from "./slack-harness";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";
const MENTIONED = "ses_e71285defffe4WBGXJlfV2dBZ2";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

let m: SlackMachine;
let e: Env;
let sessionId: string;
let channelId: string;

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  resetSlackCalls();
  m = await mkSlackMachine({ domain: "acme" });
  e = envWith([m]);
  sessionId = await seedSession(m.machineId, "rich");
  ({ channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws));
});

afterEach(() => {
  fetchMock.get("https://slack.com").cleanMocks();
  fetchMock.deactivate();
  vi.restoreAllMocks();
});

const send = (extra: Record<string, unknown> = {}) =>
  handleSendNotification(
    env.DB,
    e,
    postJson("/notifications/send", m.key, {
      sessionId,
      text: "plain chunk 0",
      notificationId: `s:${sessionId}:${stamp()}`,
      rich: { markdown: TABLE, dialect: "slack" },
      ...extra,
    }),
  );

const blocksOf = (i: number) =>
  JSON.parse(slackCalls[i]!.params.get("blocks") ?? "[]") as Array<{ type: string; elements?: Array<Record<string, any>> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const buttonsOf = (i: number) => blocksOf(i).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);

describe("POST /notifications/send with rich", () => {
  it("falls back to the plain text once on a rejection, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
    slack("chat.postMessage", posted(channelId));
    const res = await send();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(json).toMatchObject({ ok: true, rich: "fallback" });
    expect(json.richError).toMatchObject({ errorClass: "rejected_format" });
    expect(slackOf("chat.postMessage")).toHaveLength(2);
    expect(blocksOf(0).map((b) => b.type)).toContain("markdown");
    expect(blocksOf(1).map((b) => b.type)).not.toContain("markdown");
    expect(warn).toHaveBeenCalledWith(
      "[worker] rich message rejected, sending plain",
      expect.objectContaining({ sessionId }),
    );
  });

  it("does not fall back on an upstream failure: the outbox retries the rich send", async () => {
    slack("chat.postMessage", { ok: false, error: "fatal_error" }, 500);
    const res = await send();
    expect(res.status).toBe(502);
    expect(slackOf("chat.postMessage")).toHaveLength(1);
  });

  it("passes a 429 through as a rate limit", async () => {
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "7" });
    const res = await send();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfter: 7 });
  });

  it("sends plain and adds no rich field when the request has no rich", async () => {
    slack("chat.postMessage", posted(channelId));
    const res = await send({ rich: undefined });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("rich");
    expect(blocksOf(0).map((b) => b.type)).not.toContain("markdown");
  });

  it("ignores a malformed rich field", async () => {
    slack("chat.postMessage", posted(channelId));
    const res = await send({ rich: { markdown: 5, dialect: "slack" } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("rich");
  });

  describe("mention buttons", () => {
    beforeEach(async () => {
      // One shared id across tests, each in its own workspace: start from no row.
      await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(MENTIONED).run();
      await seedSlackTopic(MENTIONED, m.machineId, m.ws, "Worker A");
    });

    it("are built from the markdown for rich, and from the plain text for the fallback", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      // Rejected with the buttons, then without them (the markdown itself is the problem), then
      // the plain chunk goes with the buttons its own text asks for (none).
      slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
      slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
      slack("chat.postMessage", posted(channelId));
      const res = await send({ rich: { markdown: `${TABLE}\n\nsee ses_e71285de`, dialect: "slack" } });
      expect(await res.json()).toMatchObject({ rich: "fallback" });
      expect(buttonsOf(0)).toMatchObject([{ type: "button", text: { text: "Worker A" } }]);
      expect(buttonsOf(1)).toEqual([]);
      expect(buttonsOf(2)).toEqual([]);
    });

    it("retries rich without the link buttons when the rich send with them is rejected", async () => {
      slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
      slack("chat.postMessage", posted(channelId));
      const res = await send({ rich: { markdown: `${TABLE}\n\nsee ses_e71285de`, dialect: "slack" } });
      expect(await res.json()).toMatchObject({ rich: "sent" });
      expect(slackOf("chat.postMessage")).toHaveLength(2);
      expect(buttonsOf(0)).toHaveLength(1);
      expect(buttonsOf(1)).toEqual([]);
      expect(blocksOf(1).map((b) => b.type)).toContain("markdown");
    });
  });

  describe("a retry of a delivered notification", () => {
    it("answers a delivered rich send with rich: sent, so the daemon skips the other chunks", async () => {
      slack("chat.postMessage", posted(channelId));
      const notificationId = `s:${sessionId}:dedup#c0`;
      const first = (await (await send({ notificationId })).json()) as { messageId: number };
      const retry = await send({ notificationId });
      expect(await retry.json()).toMatchObject({ ok: true, messageId: first.messageId, deduplicated: true, rich: "sent" });
      expect(slackOf("chat.postMessage")).toHaveLength(1);
    });

    it("answers a plain fallback as deduplicated without rich: sent", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
      slack("chat.postMessage", posted(channelId));
      const notificationId = `s:${sessionId}:fb#c0`;
      await send({ notificationId });
      const retry = await send({ notificationId });
      const json = (await retry.json()) as Record<string, unknown>;
      expect(json).toMatchObject({ ok: true, deduplicated: true });
      expect(json.rich).not.toBe("sent");
      expect(slackOf("chat.postMessage")).toHaveLength(2);
    });
  });
});

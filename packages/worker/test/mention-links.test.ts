import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import {
  extractMentionedIds,
  buttonLabel,
  resolveMentionKeyboard,
  MAX_MENTION_LINKS,
} from "../src/mention-links";
import { handleSendNotification } from "../src/notifications";
import { slackArchiveUrl } from "../src/slack";
import { slackChatId, type SlackWorkspace } from "../src/chat/slack-config";
import {
  envWith,
  mkSlackMachine,
  postJson,
  posted,
  resetSlackCalls,
  seedChannel,
  seedAlerts,
  seedSession,
  slack,
  slackCalls,
  stamp,
} from "./slack-harness";

const CHAT_ID = "-1001234567890";
const SELF_ID = "ses_aaaaaaaaaaaa1111111111111a";
const WORKER_A = "ses_e71285defffe4WBGXJlfV2dBZ2";
const WORKER_B = "ses_e70000000000aBcDeFgHiJkLmN";
const GOOSE = "gse_1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM topics").run();
});

async function seedTopic(
  sessionId: string,
  threadId: number | null,
  name: string | null = "n",
  chatId = CHAT_ID,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', 1, 1)`,
  )
    .bind(sessionId, "m1", chatId, threadId, name)
    .run();
}

describe("extractMentionedIds", () => {
  it("finds full and shortened ses_/gse_ ids in text order, deduped", () => {
    const text = `ping ses_e71285de, then ${WORKER_B} and ses_e71285de again; coordinator gse_1a2b3c4d`;
    expect(extractMentionedIds(text, SELF_ID)).toEqual(["ses_e71285de", WORKER_B, "gse_1a2b3c4d"]);
  });

  it("ignores ids shorter than 8 characters after the prefix", () => {
    expect(extractMentionedIds("ses_abc and ses_1234567", SELF_ID)).toEqual([]);
  });

  it("does not match inside a longer word", () => {
    expect(extractMentionedIds("xses_e71285defffe and my_ses_e71285defffe", SELF_ID)).toEqual([]);
  });

  it("skips the notifying session itself, full or shortened", () => {
    expect(extractMentionedIds(`🆔 ${SELF_ID} and ses_aaaaaaaa`, SELF_ID)).toEqual([]);
  });

  it("caps the candidate list", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `ses_${String(i).padStart(8, "0")}`);
    expect(extractMentionedIds(ids.join(" "), SELF_ID).length).toBe(2 * MAX_MENTION_LINKS);
  });
});

describe("buttonLabel", () => {
  it("drops the directory suffix of a titled topic name", () => {
    expect(buttonLabel("Fix flaky test · ~/projects/mono", "ses_x")).toBe("Fix flaky test");
  });

  it("keeps a directory-only name and falls back to the id", () => {
    expect(buttonLabel("~/projects/pigeon", "ses_x")).toBe("~/projects/pigeon");
    expect(buttonLabel(null, "ses_e71285de")).toBe("ses_e71285de");
    expect(buttonLabel("   ", "ses_e71285de")).toBe("ses_e71285de");
  });

  it("truncates long labels", () => {
    const label = buttonLabel("x".repeat(100), "ses_x");
    expect([...label].length).toBe(64);
    expect(label.endsWith("…")).toBe(true);
  });
});

// ─── shared resolution logic, on Slack rows ────────────────────────────────

describe("resolveMentionKeyboard (Slack rows)", () => {
  let ws: SlackWorkspace;
  let e: Env;
  const channels = new Map<string, string>();

  beforeAll(async () => {
    const m = await mkSlackMachine({ teamId: `TMENT${stamp()}`.toUpperCase(), domain: "acme" });
    ws = m.ws;
    e = envWith([m]);
  });

  /** A topic row in this workspace, over a conversation Slack knows, unless `handle` is given. */
  async function seedSlackRow(sessionId: string, name: string | null, handle?: number | null): Promise<void> {
    let thread: number | null;
    if (handle !== undefined) {
      thread = handle;
    } else {
      const channelId = `CM${stamp()}`.toUpperCase();
      thread = await seedChannel(ws.teamId, channelId);
      channels.set(sessionId, channelId);
    }
    await seedTopic(sessionId, thread, name, slackChatId(ws));
  }
  const url = (sessionId: string) => slackArchiveUrl("acme", channels.get(sessionId)!);

  it("links a shortened id to the one topic it prefixes, labelled by title", async () => {
    await seedSlackRow(WORKER_A, "Rework goose delivery · ~/projects/pigeon");
    const kb = await resolveMentionKeyboard(env.DB, "worker ses_e71285de is stuck", SELF_ID, e);
    expect(kb).toEqual({ inline_keyboard: [[{ text: "Rework goose delivery", url: url(WORKER_A) }]] });
  });

  it("links full ids and goose ids, in mention order", async () => {
    await seedSlackRow(WORKER_A, "A");
    await seedSlackRow(GOOSE, "G");
    const kb = await resolveMentionKeyboard(env.DB, `${GOOSE} then ${WORKER_A}`, SELF_ID, e);
    expect(kb?.inline_keyboard.map((r: Array<{ text: string }>) => r[0]!.text)).toEqual(["G", "A"]);
  });

  it("gives no button for an ambiguous prefix, a missing topic, a reserved row, or a conversation Slack does not know", async () => {
    await seedSlackRow(WORKER_A, "A");
    await seedSlackRow("ses_e71285de0000aaaaaaaaaaaaaa", "A2");
    await seedSlackRow(WORKER_B, "reserved", null);
    await seedSlackRow("ses_e6000000000000000000000000", "unknown", 2 ** 40 + 987654321);
    const kb = await resolveMentionKeyboard(
      env.DB,
      "ses_e71285de ses_e7000000 ses_e6000000 ses_ffffffff",
      SELF_ID,
      e,
    );
    expect(kb).toBeUndefined();
  });
});

describe("resolveMentionKeyboard", () => {
  it("[Telegram t.me] links a shortened id to the one topic it prefixes, labelled by title", async () => {
    await seedTopic(WORKER_A, 77, "Rework goose delivery · ~/projects/pigeon");
    const kb = await resolveMentionKeyboard(env.DB, "worker ses_e71285de is stuck", SELF_ID);
    expect(kb).toEqual({
      inline_keyboard: [[{ text: "Rework goose delivery", url: "https://t.me/c/1234567890/77" }]],
    });
  });

  it("[Telegram t.me] links full ids and goose ids, in mention order", async () => {
    await seedTopic(WORKER_A, 77, "A");
    await seedTopic(GOOSE, 78, "G");
    const kb = await resolveMentionKeyboard(env.DB, `${GOOSE} then ${WORKER_A}`, SELF_ID);
    expect(kb?.inline_keyboard.map((r: Array<{ text: string }>) => r[0]!.text)).toEqual(["G", "A"]);
  });

  it("[Telegram t.me] gives no button for an ambiguous prefix, a missing topic, a reserved row, or a non-supergroup chat", async () => {
    await seedTopic(WORKER_A, 77, "A");
    await seedTopic("ses_e71285de0000aaaaaaaaaaaaaa", 79, "A2");
    await seedTopic(WORKER_B, null, "reserved");
    await seedTopic("ses_e6000000000000000000000000", 80, "private", "12345");
    const kb = await resolveMentionKeyboard(
      env.DB,
      "ses_e71285de ses_e7000000 ses_e6000000 ses_ffffffff",
      SELF_ID,
    );
    expect(kb).toBeUndefined();
  });

  it("does not treat SQL LIKE wildcards in the id as wildcards", async () => {
    await seedTopic("sesXe71285defffe4WBGXJlfV2dBZ2", 81, "not a session");
    expect(await resolveMentionKeyboard(env.DB, "ses_e71285de", SELF_ID)).toBeUndefined();
  });

  it("returns undefined when nothing is mentioned, without touching D1", async () => {
    const throwingDb = {
      prepare() {
        throw new Error("must not query");
      },
    } as unknown as D1Database;
    expect(await resolveMentionKeyboard(throwingDb, `🆔 ${SELF_ID}`, SELF_ID)).toBeUndefined();
  });

  it("fails open when D1 throws", async () => {
    const throwingDb = {
      prepare() {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    expect(await resolveMentionKeyboard(throwingDb, "ses_e71285de", SELF_ID)).toBeUndefined();
  });
});

describe("POST /notifications/send adds mention links (Slack)", () => {
  let m: Awaited<ReturnType<typeof mkSlackMachine>>;
  let e: Env;
  let sender: string;
  let workerUrl: string;

  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    resetSlackCalls();
    m = await mkSlackMachine({ domain: "acme" });
    e = envWith([m]);
    sender = await seedSession(m.machineId, "coord");
    await seedAlerts(m.ws);
    const channelId = `CMW${stamp()}`.toUpperCase();
    const handle = await seedChannel(m.ws.teamId, channelId);
    await seedTopic(WORKER_A, handle, "Rework goose delivery · ~/projects/pigeon", slackChatId(m.ws));
    workerUrl = slackArchiveUrl("acme", channelId);
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  const send = (body: Record<string, unknown>) =>
    handleSendNotification(
      env.DB,
      e,
      postJson("/notifications/send", m.key, { sessionId: sender, threaded: false, ...body }),
    );

  const buttons = () => {
    const blocks = JSON.parse(slackCalls[0]!.params.get("blocks") ?? "[]") as Array<{
      type: string;
      elements?: Array<Record<string, unknown>>;
    }>;
    return blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
  };

  it("attaches a url button when the text mentions a session with a topic", async () => {
    slack("chat.postMessage", posted("CALERTS1"));
    const res = await send({ text: "ses_e71285de finished", replyMarkup: { inline_keyboard: [] } });
    expect(res.status).toBe(200);
    expect(buttons()).toMatchObject([{ type: "button", url: workerUrl, text: { text: "Rework goose delivery" } }]);
  });

  it("leaves a caller's own keyboard alone", async () => {
    const own = { inline_keyboard: [[{ text: "Yes", callback_data: "cmd:tok:v1:q0" }]] };
    slack("chat.postMessage", posted("CALERTS1"));
    await send({ text: "ses_e71285de?", replyMarkup: own });
    expect(buttons()).toMatchObject([{ type: "button", value: "cmd:tok:v1:q0" }]);
    expect(buttons().some((b) => "url" in b)).toBe(false);
  });
});

describe("POST /notifications/send adds mention links (Telegram)", () => {
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-api-key",
  };
  const SENDER = "mention-sender";
  const ALLOWED_CHAT = "8248645256";

  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(SENDER, "machine-1", "coord", now, now)
      .run();
    await seedTopic(WORKER_A, 77, "Rework goose delivery · ~/projects/pigeon");
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  function captureSends(replies: Array<{ status: number; body: unknown }>): any[] {
    const sent: any[] = [];
    for (const r of replies) {
      fetchMock
        .get("https://api.telegram.org")
        .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
        .reply(r.status, (opts: any) => {
          const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
          sent.push(JSON.parse(raw));
          return r.body as any;
        });
    }
    return sent;
  }

  function send(body: Record<string, unknown>): Promise<Response> {
    return SELF.fetch("https://worker/notifications/send", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionId: SENDER, chatId: ALLOWED_CHAT, threaded: false, ...body }),
    });
  }

  it("resends once without the buttons when Telegram rejects them with a 400", async () => {
    const sent = captureSends([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: BUTTON_URL_INVALID" } },
      { status: 200, body: { ok: true, result: { message_id: 503 } } },
    ]);
    const res = await send({ text: "ses_e71285de finished" });
    expect(res.status).toBe(200);
    expect(sent.length).toBe(2);
    expect(sent[0].reply_markup?.inline_keyboard?.length).toBe(1);
    expect(sent[1].reply_markup).toBeUndefined();
  });
});

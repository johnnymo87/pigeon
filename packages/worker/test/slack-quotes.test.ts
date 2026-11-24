import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import {
  isValidStoredQuote,
  putQuote,
  getQuote,
  sweepSlackQuotes,
  extractQuoteIdFromReplyMarkup,
  SLACK_QUOTE_TTL_MS,
  MAX_QUOTE_PAYLOAD_CHARS,
  type StoredQuote,
} from "../src/slack-quotes";
import { handleSendNotification } from "../src/notifications";
import { sha256Hex } from "../src/credentials";
import { slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { fakeSlack } from "./slack-harness";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

let srv: ReturnType<typeof fakeSlack>;

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  srv = fakeSlack();
});

afterEach(() => {
  fetchMock.get("https://slack.com").cleanMocks();
  fetchMock.deactivate();
  vi.restoreAllMocks();
});

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

interface Machine {
  machineId: string;
  key: string;
  ws: SlackWorkspace;
}

async function mkMachine(): Promise<Machine> {
  const machineId = `m_${stamp()}`.toLowerCase().slice(0, 30);
  const key = ("pgk_" + machineId + "x".repeat(43)).slice(0, 47);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
  const ws: SlackWorkspace = {
    teamId: `T${stamp()}`.slice(0, 11).toUpperCase(),
    appId: "A1",
    domain: "test",
    botToken: `xoxb-${stamp()}`,
    userToken: `xoxp-${stamp()}`,
    signingSecret: "s1",
    ownerUserId: "U_OWNER",
  };
  return { machineId, key, ws };
}

function envFor(machines: Machine[]): Env {
  const e: Record<string, unknown> = { ...env };
  for (const m of machines) {
    e[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  }
  return e as unknown as Env;
}

async function seedSession(machineId: string, sessionId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sessions (session_id, machine_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(sessionId, machineId, Date.now(), Date.now())
    .run();
}

function sampleQuote(sessionId: string): StoredQuote {
  return {
    v: 1,
    sessionId,
    passages: [
      {
        header: "# 11-24 13:05 (wake: mail) · ask",
        lines: ["line 1", "line 2"],
        first: true,
      },
      {
        header: "# 11-24 13:05 (wake: mail) · ask",
        lines: ["line 3"],
        first: false,
      },
    ],
    total: 2,
  };
}

describe("isValidStoredQuote", () => {
  it("accepts a well-formed StoredQuote", () => {
    expect(isValidStoredQuote(sampleQuote("ses_123"))).toBe(true);
  });

  it("rejects non-objects or null", () => {
    expect(isValidStoredQuote(null)).toBe(false);
    expect(isValidStoredQuote(undefined)).toBe(false);
    expect(isValidStoredQuote("quote")).toBe(false);
    expect(isValidStoredQuote(123)).toBe(false);
  });

  it("rejects v !== 1", () => {
    const q: unknown = { ...sampleQuote("ses_123"), v: 2 };
    expect(isValidStoredQuote(q)).toBe(false);
  });

  it("rejects non-string or empty sessionId", () => {
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), sessionId: "" })).toBe(false);
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), sessionId: 123 })).toBe(false);
  });

  it("rejects non-array passages or malformed passage", () => {
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), passages: null })).toBe(false);
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), passages: [] })).toBe(false);
    expect(
      isValidStoredQuote({
        ...sampleQuote("ses_123"),
        passages: [{ header: "h", lines: [123], first: true }],
      }),
    ).toBe(false);
    expect(
      isValidStoredQuote({
        ...sampleQuote("ses_123"),
        passages: [{ header: 123, lines: ["ok"], first: true }],
      }),
    ).toBe(false);
    expect(
      isValidStoredQuote({
        ...sampleQuote("ses_123"),
        passages: [{ header: "h", lines: ["ok"], first: "not-bool" }],
      }),
    ).toBe(false);
  });

  it("rejects invalid total", () => {
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), total: -1 })).toBe(false);
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), total: 1.5 })).toBe(false);
    expect(isValidStoredQuote({ ...sampleQuote("ses_123"), total: "2" })).toBe(false);
  });
});

describe("extractQuoteIdFromReplyMarkup", () => {
  it("extracts quoteId from callback_data quote:<id>", () => {
    const markup = {
      inline_keyboard: [[{ text: "Answer", callback_data: "quote:abcd1234efgh" }]],
    };
    expect(extractQuoteIdFromReplyMarkup(markup)).toBe("abcd1234efgh");
  });

  it("returns null when no quote callback_data exists", () => {
    expect(extractQuoteIdFromReplyMarkup(null)).toBe(null);
    expect(extractQuoteIdFromReplyMarkup({})).toBe(null);
    expect(
      extractQuoteIdFromReplyMarkup({
        inline_keyboard: [[{ text: "Other", callback_data: "cmd:tok:act" }]],
      }),
    ).toBe(null);
    expect(
      extractQuoteIdFromReplyMarkup({
        inline_keyboard: [[{ text: "Empty", callback_data: "quote:" }]],
      }),
    ).toBe(null);
  });
});

describe("putQuote and getQuote", () => {
  it("stores and retrieves a StoredQuote", async () => {
    const quoteId = `qid_${stamp()}`;
    const quote = sampleQuote("ses_put_get");
    await putQuote(env.DB, quoteId, quote);

    const retrieved = await getQuote(env.DB, quoteId);
    expect(retrieved).toEqual(quote);
  });

  it("is idempotent: duplicate putQuote does not overwrite or error", async () => {
    const quoteId = `qid_${stamp()}`;
    const quote1 = sampleQuote("ses_idem_1");
    const quote2 = { ...quote1, total: 99 };

    await putQuote(env.DB, quoteId, quote1);
    await putQuote(env.DB, quoteId, quote2);

    const retrieved = await getQuote(env.DB, quoteId);
    expect(retrieved?.total).toBe(2);
  });

  it("returns null for unknown quoteId", async () => {
    expect(await getQuote(env.DB, "nonexistent")).toBe(null);
  });

  it("returns null on corrupt JSON in payload_json", async () => {
    const quoteId = `qid_corrupt_${stamp()}`;
    await env.DB.prepare(
      "INSERT INTO slack_quotes (quote_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(quoteId, "ses_corrupt", "{not valid json", Date.now())
      .run();

    const retrieved = await getQuote(env.DB, quoteId);
    expect(retrieved).toBe(null);
  });

  it("handles missing table gracefully without throwing", async () => {
    const fakeDb = {
      prepare: () => {
        throw new Error("no such table: slack_quotes");
      },
    } as unknown as D1Database;

    await expect(putQuote(fakeDb, "qid", sampleQuote("s1"))).resolves.toBeUndefined();
    expect(await getQuote(fakeDb, "qid")).toBe(null);
  });
});

describe("sweepSlackQuotes", () => {
  it("returns 0 and does not throw when table is missing", async () => {
    const fakeDb = {
      prepare: () => {
        throw new Error("no such table: slack_quotes");
      },
    } as unknown as D1Database;

    expect(await sweepSlackQuotes(fakeDb)).toBe(0);
  });
  it("deletes rows older than 7 days and respects cap", async () => {
    const now = Date.now();
    const oldTime = now - SLACK_QUOTE_TTL_MS - 1000;
    const freshTime = now - 1000;

    await env.DB.prepare(
      "INSERT INTO slack_quotes (quote_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind("q_old_1", "ses_1", JSON.stringify(sampleQuote("ses_1")), oldTime)
      .run();
    await env.DB.prepare(
      "INSERT INTO slack_quotes (quote_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind("q_old_2", "ses_1", JSON.stringify(sampleQuote("ses_1")), oldTime)
      .run();
    await env.DB.prepare(
      "INSERT INTO slack_quotes (quote_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind("q_fresh", "ses_1", JSON.stringify(sampleQuote("ses_1")), freshTime)
      .run();

    // Cap at 1
    const swept1 = await sweepSlackQuotes(env.DB, { now, cap: 1 });
    expect(swept1).toBe(1);

    // Second sweep deletes the second old row
    const swept2 = await sweepSlackQuotes(env.DB, { now });
    expect(swept2).toBe(1);

    // Fresh row remains
    expect(await getQuote(env.DB, "q_fresh")).not.toBe(null);
    expect(await getQuote(env.DB, "q_old_1")).toBe(null);
    expect(await getQuote(env.DB, "q_old_2")).toBe(null);
  });
});

describe("POST /notifications/send with quote", () => {
  it("stores quote data in slack_quotes before posting and sends the message", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const quote = sampleQuote(sid);

    const req = new Request("https://worker/notifications/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${m.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sid,
        text: "✍️ Answer 2 passage(s) from this /quote",
        threaded: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
        },
        quote,
      }),
    });

    const res = await handleSendNotification(env.DB, e, req);
    expect(res.status).toBe(200);

    const stored = await getQuote(env.DB, quoteId);
    expect(stored).toEqual(quote);
  });

  it("is idempotent on retry", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const quote = sampleQuote(sid);

    const makeReq = () =>
      new Request("https://worker/notifications/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${m.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: sid,
          text: "✍️ Answer 2 passage(s) from this /quote",
          threaded: false,
          replyMarkup: {
            inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
          },
          quote,
        }),
      });

    const res1 = await handleSendNotification(env.DB, e, makeReq());
    expect(res1.status).toBe(200);

    const res2 = await handleSendNotification(env.DB, e, makeReq());
    expect(res2.status).toBe(200);

    const stored = await getQuote(env.DB, quoteId);
    expect(stored).toEqual(quote);
  });

  it("rejects invalid quote with 400", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const invalidQuote = { ...sampleQuote(sid), v: 2 }; // invalid version

    const req = new Request("https://worker/notifications/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${m.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sid,
        text: "Answer",
        threaded: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
        },
        quote: invalidQuote,
      }),
    });

    const res = await handleSendNotification(env.DB, e, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/quote/i);
  });

  it("rejects quote when sessionId does not match body sessionId", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const mismatchQuote = sampleQuote("other_session");

    const req = new Request("https://worker/notifications/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${m.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sid,
        text: "Answer",
        threaded: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
        },
        quote: mismatchQuote,
      }),
    });

    const res = await handleSendNotification(env.DB, e, req);
    expect(res.status).toBe(400);
  });

  it("rejects quote when payload JSON exceeds 200,000 characters", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const hugeQuote: StoredQuote = {
      v: 1,
      sessionId: sid,
      passages: [
        {
          header: "h",
          lines: ["x".repeat(200_001)],
          first: true,
        },
      ],
      total: 1,
    };

    const req = new Request("https://worker/notifications/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${m.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sid,
        text: "Answer",
        threaded: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
        },
        quote: hugeQuote,
      }),
    });

    const res = await handleSendNotification(env.DB, e, req);
    expect(res.status).toBe(400);
  });

  it("missing slack_quotes table logs and posts anyway", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const sid = `ses_${stamp()}`;
    await seedSession(m.machineId, sid);

    const quoteId = `qid_${stamp()}`;
    const quote = sampleQuote(sid);

    const dbProxy = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            if (query.includes("slack_quotes")) {
              throw new Error("no such table: slack_quotes");
            }
            return target.prepare(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const req = new Request("https://worker/notifications/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${m.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sid,
        text: "✍️ Answer 2 passage(s) from this /quote",
        threaded: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Answer", callback_data: `quote:${quoteId}` }]],
        },
        quote,
      }),
    });

    const res = await handleSendNotification(dbProxy, e, req);
    expect(res.status).toBe(200);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createQuoteHandler } from "../src/goose/quote-command";
import { QuoteUnsupportedError, type QuoteResult } from "../src/goose/quote-types";
import type { QuoteMessage } from "../src/worker/poller";
import type { SessionRecord } from "../src/storage/types";
import type { UpsertOutboxInput } from "../src/storage/outbox-repo";

function makeMessage(overrides: Partial<QuoteMessage> = {}): QuoteMessage {
  return {
    commandId: "cmd_12345",
    commandType: "quote",
    sessionId: "ses_goose_1",
    chatId: "C12345",
    metadata: {
      pick: { kind: "since" },
      full: false,
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "ses_goose_1",
    ppid: null,
    pid: null,
    startTime: null,
    lastHumanMsgId: null,
    notify: true,
    ptyPath: null,
    nvimSocket: null,
    backendProtocolVersion: null,
    pullSources: [],
    label: "my-session-label",
    title: "My Session Title",
    state: "running",
    backendKind: "goose-acp",
    backendEndpoint: "ws://127.0.0.1:4000/acp",
    backendAuthToken: "secret-token",
    backendSessionId: "native_goose_1",
    boundTopicKey: null,
    cwd: "/home/dev/project",
    createdAt: 1000,
    updatedAt: 1000,
    lastSeen: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

function makeQuoteResult(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    summary: "Trimmed 2 lines",
    replies: [
      {
        header: "# 11-24 13:00 · ask",
        passages: [["Line 1", "Line 2"], ["Line 3"]],
        inProgress: false,
      },
    ],
    notices: [],
    warnings: [],
    empty: null,
    model: "claude-opus-5-5",
    ...overrides,
  };
}

describe("createQuoteHandler", () => {
  it("returns quickly while run() proceeds detached", async () => {
    let resolveQuote!: (res: QuoteResult) => void;
    const quotePromise = new Promise<QuoteResult>((resolve) => {
      resolveQuote = resolve;
    });

    const quoteSpy = vi.fn().mockReturnValue(quotePromise);
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: quoteSpy,
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: vi.fn().mockResolvedValue(undefined),
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
    });

    const msg = makeMessage();
    const handlePromise = handler(msg);

    // handler resolves quickly before quote completes
    await expect(handlePromise).resolves.toBeUndefined();
    expect(outbox).toHaveLength(0);

    // now complete the quote call
    resolveQuote(makeQuoteResult());
    // wait a tick for detached run to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(2);
  });

  it("ignores redelivered command id seen in the last hour", async () => {
    const replies: string[] = [];
    const createClient = vi.fn();
    let currentTime = 10_000;

    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
      now: () => currentTime,
    });

    const msg = makeMessage({ commandId: "cmd_repeat" });
    await handler(msg);
    await handler(msg);

    expect(createClient).toHaveBeenCalledTimes(1);

    // after > 1 hour, command id is accepted again
    currentTime += 3_600_001;
    await handler(msg);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("validates metadata and replies 'Malformed /quote' on bad metadata", async () => {
    const replies: string[] = [];
    const createClient = vi.fn();

    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    const msg = makeMessage({ metadata: { pick: { kind: "invalid" as any }, full: false } });
    await handler(msg);

    expect(replies).toEqual(["Malformed /quote"]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("replies 'Session not found' when session does not exist", async () => {
    const replies: string[] = [];
    const handler = createQuoteHandler({
      getSession: () => null,
      createClient: vi.fn(),
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(replies).toEqual(["Session not found"]);
  });

  it("replies '/quote works only for goose sessions for now.' for non-goose backend", async () => {
    const replies: string[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession({ backendKind: "opencode" }),
      createClient: vi.fn(),
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(replies).toEqual(["/quote works only for goose sessions for now."]);
  });

  it("replies naming backendEndpoint when backendEndpoint is missing", async () => {
    const replies: string[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession({ backendEndpoint: null }),
      createClient: vi.fn(),
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage({ sessionId: "ses_goose_1" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("backendEndpoint");
    expect(replies[0]).toContain("ses_goose_1");
  });

  it("replies bare goose warning if client.isHonk is false and closes client", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: false,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn(),
      close: vi.fn(),
    };

    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(client.connect).toHaveBeenCalled();
    expect(client.quote).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(replies).toEqual(["this session is on bare goose, not honkd; /quote needs honkd"]);
  });

  it("derives tag from boundTopicKey matching stallwatch:<tag>", async () => {
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(makeQuoteResult()),
      close: vi.fn(),
    };

    const handler = createQuoteHandler({
      getSession: () => makeSession({ boundTopicKey: "stallwatch:my-program" }),
      createClient: () => client,
      reply: vi.fn(),
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage({ commandId: "cmd_tagged" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(client.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: "my-program",
        sessionId: "native_goose_1",
        quoteId: "cmd_tagged",
      }),
      { timeoutMs: 600_000 },
    );
  });

  it("omits tag when boundTopicKey is null or not a stallwatch tag", async () => {
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(makeQuoteResult()),
      close: vi.fn(),
    };

    const handler = createQuoteHandler({
      getSession: () => makeSession({ boundTopicKey: null }),
      createClient: () => client,
      reply: vi.fn(),
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(client.quote).toHaveBeenCalledWith(
      expect.not.objectContaining({ tag: expect.anything() }),
      { timeoutMs: 600_000 },
    );
  });

  it("handles QuoteUnsupportedError with version message", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockRejectedValue(new QuoteUnsupportedError()),
      close: vi.fn(),
    };

    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([
      "honkd on devbox does not support /quote yet (needs honk-9qf.31.7).",
    ]);
  });

  it("handles other errors from client.quote", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockRejectedValue(new Error("socket timeout")),
      close: vi.fn(),
    };

    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: vi.fn(),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(replies).toEqual(["/quote failed: socket timeout"]);
  });

  it("calls close() and sends a '/quote failed: …' reply when client.connect() rejects", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: true,
      connect: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:4000")),
      quote: vi.fn(),
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.quote).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
    expect(replies).toEqual(["/quote failed: connect ECONNREFUSED 127.0.0.1:4000"]);
  });

  it("replies emptyText when result.empty is present", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(
        makeQuoteResult({
          empty: "nothing_since",
          replies: [],
          summary: null,
        }),
      ),
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(outbox).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Nothing has replied since your last message");
  });

  it("replies emptyText instead of posting when result.empty is null but zero passages after flattening", async () => {
    const replies: string[] = [];
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(
        makeQuoteResult({
          empty: null,
          replies: [
            {
              header: "# 11-24 13:00 · ask",
              passages: [],
              inProgress: false,
            },
          ],
          summary: null,
        }),
      ),
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: async (text: string) => {
        replies.push(text);
      },
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(outbox).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe("No replies to quote.");
  });

  it("upserts body and answer outbox entries with correct shapes and ordering", async () => {
    const quoteResult = makeQuoteResult({
      summary: "# honk: kept 2 lines",
      replies: [
        {
          header: "# 11-24 13:00 · ask",
          passages: [
            ["passage 1 line A", "passage 1 line B"],
            ["passage 2 line A"],
          ],
          inProgress: false,
        },
      ],
    });

    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(quoteResult),
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const nowTime = 50_000;

    const handler = createQuoteHandler({
      getSession: () =>
        makeSession({
          sessionId: "ses_abc",
          title: "Test Session",
          cwd: "/home/dev/test",
        }),
      createClient: () => client,
      reply: vi.fn(),
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
      now: () => nowTime,
    });

    await handler(makeMessage({ commandId: "cmd_999", sessionId: "ses_abc" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(outbox).toHaveLength(2);

    // 1. Body entry
    const bodyEntry = outbox[0]!;
    expect(bodyEntry.notificationId).toBe("qt:ses_abc:cmd_999");
    expect(bodyEntry.sessionId).toBe("ses_abc");
    expect(bodyEntry.kind).toBe("quote");
    expect(bodyEntry.afterNotificationId).toBeUndefined();

    const bodyPayload = JSON.parse(bodyEntry.payload);
    expect(bodyPayload.title).toBe("Test Session");
    expect(bodyPayload.dir).toBe("/home/dev/test");
    expect(bodyPayload.threaded).toBe(true);
    expect(bodyPayload.replyMarkup).toBeUndefined();
    expect(bodyPayload.messages.length).toBeGreaterThanOrEqual(1);
    expect(bodyPayload.rich).toEqual({
      markdown: expect.stringContaining("📋 /quote since your last message · Test Session"),
      dialect: "slack",
    });

    // 2. Answer entry
    const answerEntry = outbox[1]!;
    expect(answerEntry.notificationId).toBe("qa:ses_abc:cmd_999");
    expect(answerEntry.sessionId).toBe("ses_abc");
    expect(answerEntry.kind).toBe("quote");
    expect(answerEntry.afterNotificationId).toBe("qt:ses_abc:cmd_999");

    const answerPayload = JSON.parse(answerEntry.payload);
    expect(answerPayload.title).toBe("Test Session");
    expect(answerPayload.dir).toBe("/home/dev/test");
    expect(answerPayload.threaded).toBe(true);
    expect(answerPayload.messages).toEqual([
      { text: "✍️ Answer 2 passage(s) from this /quote" },
    ]);
    expect(answerPayload.replyMarkup).toEqual({
      inline_keyboard: [[{ text: "Answer", callback_data: "quote:cmd_999" }]],
    });
    expect(answerPayload.quote).toEqual({
      v: 1,
      sessionId: "ses_abc",
      passages: [
        {
          header: "# 11-24 13:00 · ask",
          lines: ["passage 1 line A", "passage 1 line B"],
          first: true,
        },
        {
          header: "# 11-24 13:00 · ask",
          lines: ["passage 2 line A"],
          first: false,
        },
      ],
      total: 2,
    });
  });

  it("appends capping text to answer post when passages are capped", async () => {
    // Generate 50 passages (cap is 45)
    const passages: string[][] = [];
    for (let i = 0; i < 50; i++) {
      passages.push([`passage ${i}`]);
    }

    const quoteResult = makeQuoteResult({
      replies: [
        {
          header: "# 11-24 13:00 · ask",
          passages,
          inProgress: false,
        },
      ],
    });

    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(quoteResult),
      close: vi.fn(),
    };

    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => client,
      reply: vi.fn(),
      upsertOutbox: (input: UpsertOutboxInput) => outbox.push(input),
      machineId: "devbox",
    });

    await handler(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(outbox).toHaveLength(2);
    const answerPayload = JSON.parse(outbox[1]!.payload);
    expect(answerPayload.messages[0].text).toBe(
      "✍️ Answer 45 passage(s) from this /quote — the first 45 of 50",
    );
    expect(answerPayload.quote.total).toBe(50);
    expect(answerPayload.quote.passages).toHaveLength(45);
  });

  it("never produces an unhandled rejection when an error occurs in detached run", async () => {
    const logged: string[] = [];
    const handler = createQuoteHandler({
      getSession: () => {
        throw new Error("unexpected db error");
      },
      createClient: vi.fn(),
      reply: vi.fn(),
      upsertOutbox: vi.fn(),
      machineId: "devbox",
      log: (msg: string) => logged.push(msg),
    });

    await expect(handler(makeMessage())).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("unhandled error in /quote handler: unexpected db error");
  });
});

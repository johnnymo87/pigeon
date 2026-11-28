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

  it("times out hung client.connect() after 10_000 ms, sends '/quote failed: …', and closes client", async () => {
    vi.useFakeTimers();
    try {
      const replies: string[] = [];
      const client = {
        isHonk: true,
        connect: vi.fn().mockReturnValue(new Promise(() => {})), // never resolving
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
      expect(client.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.close).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([
        "/quote failed: goose connect did not answer within 10000ms",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps body post at 12000 chars while keeping all passages in the stored quote modal", async () => {
    // 5 passages of 3400 chars each.
    // Body post shows 3 passages and ends with '… 2 more passage(s): open them with Answer.'
    // Stored quote has all 5 passages.
    const replies = Array.from({ length: 5 }, (_, i) => ({
      header: `# 11-24 13:0${i} · reply ${i + 1}`,
      passages: [[`passage ${i + 1} line: ${"x".repeat(3300)}`]],
      inProgress: false,
    }));
    const client = {
      isHonk: true,
      connect: vi.fn().mockResolvedValue(undefined),
      quote: vi.fn().mockResolvedValue(makeQuoteResult({ replies })),
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
    const bodyInput = outbox[0]!;
    const answerInput = outbox[1]!;

    const bodyPayload = JSON.parse(bodyInput.payload);
    const bodyText = bodyPayload.messages.map((m: any) => m.text).join("");
    expect(bodyText.length).toBeLessThanOrEqual(12000);
    expect(bodyText).toContain("[1] 11-24 13:00 · reply 1");
    expect(bodyText).toContain("[2] 11-24 13:01 · reply 2");
    expect(bodyText).toContain("[3] 11-24 13:02 · reply 3");
    expect(bodyText).not.toContain("[4]");
    expect(bodyText).toContain("… 2 more passage(s): open them with Answer.");

    const answerPayload = JSON.parse(answerInput.payload);
    expect(answerPayload.quote.passages).toHaveLength(5);
    expect(answerPayload.quote.passages[0].header).toBe("# 11-24 13:00 · reply 1");
    expect(answerPayload.quote.passages[4].header).toBe("# 11-24 13:04 · reply 5");
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

  it("forwards notes to client.quote, stores prefills + unmatchedNotes, and reports counts", async () => {
    const outbox: UpsertOutboxInput[] = [];
    const quoteSpy = vi.fn().mockResolvedValue({
      summary: "# trimmed",
      replies: [
        {
          header: "# 11-28 08:00 · ask",
          passages: [["q1"], ["q2"]],
          prefills: ["yes on q1", null],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: "claude-opus-5-5",
      unmatchedNotes: ["extra thought"],
    });
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => ({
        isHonk: true,
        connect: vi.fn().mockResolvedValue(undefined),
        quote: quoteSpy,
        close: vi.fn(),
      }),
      reply: vi.fn(),
      upsertOutbox: (input) => outbox.push(input),
      machineId: "cloudbox",
    });

    await handler(
      makeMessage({
        commandId: "cmd_notes_1",
        metadata: { pick: { kind: "since" }, full: false, notes: "yes on q1\nextra thought" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(quoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ notes: "yes on q1\nextra thought" }),
      { timeoutMs: 600_000 },
    );
    expect(outbox).toHaveLength(2);
    const answerPayload = JSON.parse(outbox[1]!.payload);
    expect(answerPayload.messages[0].text).toBe(
      "✍️ Answer 2 passage(s) from this /quote (1 prefilled, 1 unmatched note)",
    );
    expect(answerPayload.quote.passages[0].prefill).toBe("yes on q1");
    expect(answerPayload.quote.passages[1].prefill).toBeUndefined();
    expect(answerPayload.quote.unmatchedNotes).toEqual(["extra thought"]);
  });

  it("preserves raw notes with a warning when an older honkd ignores notes (deploy-skew guard)", async () => {
    const outbox: UpsertOutboxInput[] = [];
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => ({
        isHonk: true,
        connect: vi.fn().mockResolvedValue(undefined),
        quote: vi.fn().mockResolvedValue({
          summary: "# trimmed",
          replies: [
            {
              header: "# 11-28 08:00 · ask",
              passages: [["q1"]],
              inProgress: false,
            },
          ],
          notices: [],
          warnings: [],
          empty: null,
          model: "claude-opus-5-5",
        }),
        close: vi.fn(),
      }),
      reply: vi.fn(),
      upsertOutbox: (input) => outbox.push(input),
      machineId: "cloudbox",
    });

    await handler(
      makeMessage({
        commandId: "cmd_notes_skew",
        metadata: { pick: { kind: "since" }, full: false, notes: "my important note" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(outbox).toHaveLength(2);
    const bodyPayload = JSON.parse(outbox[0]!.payload);
    expect(bodyPayload.messages[0].text).toContain("honkd on cloudbox did not match your notes");
    const answerPayload = JSON.parse(outbox[1]!.payload);
    expect(answerPayload.quote.unmatchedNotes).toEqual(["my important note"]);
  });

  it("still offers Answer modal when result is empty but unmatchedNotes is non-empty", async () => {
    const outbox: UpsertOutboxInput[] = [];
    const replySpy = vi.fn();
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => ({
        isHonk: true,
        connect: vi.fn().mockResolvedValue(undefined),
        quote: vi.fn().mockResolvedValue({
          summary: null,
          replies: [],
          notices: [],
          warnings: [],
          empty: "nothing_since",
          model: null,
          unmatchedNotes: ["stand-alone note"],
        }),
        close: vi.fn(),
      }),
      reply: replySpy,
      upsertOutbox: (input) => outbox.push(input),
      machineId: "cloudbox",
    });

    await handler(
      makeMessage({
        commandId: "cmd_notes_empty",
        metadata: { pick: { kind: "since" }, full: false, notes: "stand-alone note" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(replySpy).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(2);
    const answerPayload = JSON.parse(outbox[1]!.payload);
    expect(answerPayload.messages[0].text).toBe(
      "✍️ Send 1 unmatched note(s) from this /quote",
    );
    expect(answerPayload.quote).toEqual({
      v: 1,
      sessionId: "ses_goose_1",
      passages: [],
      total: 0,
      unmatchedNotes: ["stand-alone note"],
      notesRaw: "stand-alone note",
    });
  });

  it("preserves raw notes in failure replies when /quote errors", async () => {
    const replySpy = vi.fn();
    const handler = createQuoteHandler({
      getSession: () => makeSession(),
      createClient: () => ({
        isHonk: true,
        connect: vi.fn().mockRejectedValue(new Error("socket closed")),
        quote: vi.fn(),
        close: vi.fn(),
      }),
      reply: replySpy,
      upsertOutbox: vi.fn(),
      machineId: "cloudbox",
    });

    await handler(
      makeMessage({
        commandId: "cmd_notes_err",
        metadata: { pick: { kind: "since" }, full: false, notes: "keep my @channel note" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(replySpy).toHaveBeenCalledTimes(1);
    const text = replySpy.mock.calls[0]![0] as string;
    expect(text).toContain("/quote failed: socket closed");
    expect(text).toContain("Your notes (copy before retrying):");
    expect(text).toContain("keep my @\u200dchannel note");
  });
});

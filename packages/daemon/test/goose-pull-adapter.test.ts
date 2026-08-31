import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GoosePullAdapter, PULL_BACKEND_KIND } from "../src/adapters/goose-pull";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import type { ExecuteMessage } from "../src/worker/poller";
import type { SessionRecord } from "../src/storage/types";

/**
 * The goose-pull adapter: the point at which a Telegram reply stops trying to be
 * pushed at a server that does not exist and is banked for collection instead.
 */
describe("GoosePullAdapter", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newDb(sessionId = "ses_lane"): StorageDb {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId, notify: true, backendKind: PULL_BACKEND_KIND, label: "maven-renovate" },
      1_000,
    );
    return storage;
  }

  function session(s: StorageDb, sessionId = "ses_lane"): SessionRecord {
    return s.sessions.get(sessionId)!;
  }

  it("banks a command and reports it as banked, not as delivered", async () => {
    const s = newDb();
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    const result = await adapter.deliverCommand(session(s), "stop repinning #4259", {
      commandId: "cmd-1",
      chatId: "42",
    });

    expect(result.ok).toBe(true);
    // The flag is what makes command-ingest tell the human the truth about
    // latency. Without it the human sees Telegram's "Command sent" toast and
    // nothing else, which is false by up to ~68h for this backend.
    expect(result.meta?.banked).toBe(true);

    const [row] = s.pullInbox.claim("ses_lane", 3_000);
    expect(row!.payload).toBe("stop repinning #4259");
    expect(row!.source).toBe("telegram-reply");
    expect(row!.chatId).toBe("42");
  });

  it("derives the bank id from the commandId, so an ingest retry banks once", async () => {
    const s = newDb();
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    await adapter.deliverCommand(session(s), "hello", { commandId: "cmd-1" });
    await adapter.deliverCommand(session(s), "hello", { commandId: "cmd-1" });
    expect(s.pullInbox.pendingCount("ses_lane", 3_000)).toBe(1);
  });

  it("banks a question answer with its request id, so the lane can validate it", async () => {
    const s = newDb();
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    const result = await adapter.deliverQuestionReply(
      session(s),
      { questionRequestId: "req-7", answers: [["yes"], ["and rebase first"]] },
      { commandId: "cmd-2", chatId: "42" },
    );

    expect(result.ok).toBe(true);
    expect(result.meta?.banked).toBe(true);
    const [row] = s.pullInbox.claim("ses_lane", 3_000);
    expect(row!.source).toBe("question-answer");
    expect(row!.questionRequestId).toBe("req-7");
    expect(row!.payload).toContain("yes");
    expect(row!.payload).toContain("and rebase first");
  });

  // MEASURED ON A LIVE DAEMON, 2026-08-31, and the reason this column exists.
  // While a question is pending, command-ingest routes EVERY plain message to the
  // session into the question-reply path. An unrelated Telegram message therefore
  // arrives labelled as the answer to a question it never saw -- and consumes the
  // pending row, so a later button press is refused as stale. The text survives;
  // the label is what lies, to a client that has been told to trust it.
  it("marks an answer that matches an option label as a button press", async () => {
    const s = newDb();
    s.pendingQuestions.store(
      {
        sessionId: "ses_lane",
        requestId: "req-7",
        questions: [
          {
            question: "Repin or wait?",
            header: "h",
            options: [
              { label: "repin", description: "" },
              { label: "wait", description: "" },
            ],
          },
        ],
        token: "t",
      },
      Date.now(),
    );
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    await adapter.deliverQuestionReply(
      session(s),
      { questionRequestId: "req-7", answers: [["wait"]] },
      { commandId: "cmd-b" },
    );
    expect(s.pullInbox.claim("ses_lane", 3_000)[0]!.answerKind).toBe("option");
  });

  it("marks text that matches no option as free text, not as a confirmed answer", async () => {
    const s = newDb();
    s.pendingQuestions.store(
      {
        sessionId: "ses_lane",
        requestId: "req-7",
        questions: [
          {
            question: "Repin or wait?",
            header: "h",
            options: [
              { label: "repin", description: "" },
              { label: "wait", description: "" },
            ],
          },
        ],
        token: "t",
      },
      Date.now(),
    );
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    await adapter.deliverQuestionReply(
      session(s),
      { questionRequestId: "req-7", answers: [["actually, look at #4360 first"]] },
      { commandId: "cmd-c" },
    );
    expect(s.pullInbox.claim("ses_lane", 3_000)[0]!.answerKind).toBe("free-text");
  });

  it("marks an answer as free text when there is no pending question at all", async () => {
    const s = newDb();
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    await adapter.deliverQuestionReply(
      session(s),
      { questionRequestId: "req-gone", answers: [["wait"]] },
      { commandId: "cmd-d" },
    );
    expect(s.pullInbox.claim("ses_lane", 3_000)[0]!.answerKind).toBe("free-text");
  });

  // The row that is pending is not necessarily the row being answered: questions
  // are keyed on session_id with INSERT OR REPLACE, so a second question destroys
  // the first while the first's card is still on screen. A late tap on that dead
  // card whose text happens to match the LIVE question's options must not be
  // certified as a button press for a question this row is not about. Mutation
  // testing found this: an earlier version checked only that SOME question was
  // pending, and every test still passed because none of them had a mismatched
  // pending row.
  it("does not certify an answer against a DIFFERENT pending question", async () => {
    const s = newDb();
    s.pendingQuestions.store(
      {
        sessionId: "ses_lane",
        requestId: "req-NEW",
        questions: [
          { question: "q", header: "h", options: [{ label: "wait", description: "" }] },
        ],
        token: "t",
      },
      Date.now(),
    );
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    await adapter.deliverQuestionReply(
      session(s),
      { questionRequestId: "req-OLD", answers: [["wait"]] },
      { commandId: "cmd-e" },
    );
    expect(s.pullInbox.claim("ses_lane", 3_000)[0]!.answerKind).toBe("free-text");
  });

  it("refuses to bank for a session that is not a pull backend", async () => {
    const s = newDb();
    s.sessions.upsert(
      { sessionId: "ses_oc", notify: true, backendKind: "opencode-plugin-direct" },
      1_000,
    );
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    const result = await adapter.deliverCommand(s.sessions.get("ses_oc")!, "hi", {
      commandId: "cmd-3",
    });
    expect(result.ok).toBe(false);
    expect(s.pullInbox.pendingCount("ses_oc", 3_000)).toBe(0);
  });

  it("refuses an empty payload rather than banking a blank message", async () => {
    const s = newDb();
    const adapter = new GoosePullAdapter({ storage: s, nowFn: () => 2_000 });
    const result = await adapter.deliverCommand(session(s), "   ", { commandId: "cmd-4" });
    expect(result.ok).toBe(false);
    expect(s.pullInbox.pendingCount("ses_lane", 3_000)).toBe(0);
  });
});

/**
 * Wiring. An adapter that works when constructed by hand but is never selected is
 * the shape that let the lane's merge gate sit dead for days while every test was
 * green: the tests called the gate directly and nothing asserted that anything
 * called it. So these drive the REAL entry point.
 */
describe("command-ingest selects the goose-pull adapter", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function makeMsg(overrides: Partial<ExecuteMessage> = {}): ExecuteMessage {
    return {
      commandId: "cmd-1",
      commandType: "execute",
      sessionId: "ses_lane",
      command: "please look at #4259",
      chatId: "42",
      ...overrides,
    };
  }

  it("banks a plain Telegram reply instead of dropping it as unreachable", async () => {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert(
      { sessionId: "ses_lane", notify: true, backendKind: PULL_BACKEND_KIND, label: "maven-renovate" },
      1_000,
    );

    const replies: string[] = [];
    await ingestWorkerCommand(s, makeMsg(), {
      sendTelegramReply: async (_chatId, text) => {
        replies.push(text);
      },
    });

    expect(s.pullInbox.pendingCount("ses_lane", 2_000)).toBe(1);
    // The old behaviour, which this replaces, told the human to "Restart the
    // session to re-register" -- visible, and wrong guidance for a oneshot lane.
    expect(replies.join("\n")).not.toContain("Restart the session");
    expect(replies.join("\n").toLowerCase()).toContain("banked");
    expect(s.inbox.listUnfinished()).toHaveLength(0);
  });

  it("names the session in the banked notice, so a reply in the wrong topic is obvious", async () => {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert(
      { sessionId: "ses_lane", notify: true, backendKind: PULL_BACKEND_KIND, label: "maven-renovate" },
      1_000,
    );
    const replies: string[] = [];
    await ingestWorkerCommand(s, makeMsg(), {
      sendTelegramReply: async (_c, text) => {
        replies.push(text);
      },
    });
    expect(replies.join("\n")).toContain("maven-renovate");
  });

  it("banks a question answer through the pending-question path", async () => {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert(
      { sessionId: "ses_lane", notify: true, backendKind: PULL_BACKEND_KIND, label: "maven-renovate" },
      1_000,
    );
    s.pendingQuestions.store(
      {
        sessionId: "ses_lane",
        requestId: "req-7",
        // Shape taken from QuestionInfoData/QuestionOptionData (storage/types.ts:48-59),
        // NOT invented: options are objects with `label`, and command-ingest
        // resolves an option token to `options[i].label`. A first draft of this
        // fixture used bare strings, which produced an undefined answer and a
        // refusal -- a fixture that tests the test rather than the code.
        questions: [
          {
            question: "Repin or wait?",
            header: "maven-renovate",
            options: [
              { label: "repin", description: "push a repin now" },
              { label: "wait", description: "leave it for CI" },
            ],
          },
        ],
        token: "tok",
      },
      // Real clock, not the 1_000 used elsewhere: ingestWorkerCommand reads
      // pending questions through getBySessionId, which filters on
      // `expires_at > now` against Date.now(). A fixture stored at t=1000 is
      // four hours expired before the test starts, and the command falls
      // through to the stale-option branch -- which is how the first run of
      // this test failed, silently testing the wrong path.
      Date.now(),
    );

    await ingestWorkerCommand(s, makeMsg({ commandId: "cmd-9", command: "q1" }), {
      sendTelegramReply: async () => {},
    });

    const [row] = s.pullInbox.claim("ses_lane", Date.now() + 1_000);
    expect(row?.source).toBe("question-answer");
    expect(row?.questionRequestId).toBe("req-7");
    expect(row?.payload).toContain("wait");
    // The pending row is cleared, exactly as it is for opencode: it has been
    // answered. The answer's own validity is re-checked by the lane at drain.
    expect(s.pendingQuestions.getBySessionId("ses_lane", Date.now())).toBeNull();
  });

  it("leaves an opencode session's behaviour completely unchanged", async () => {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert({ sessionId: "ses_oc", notify: true, backendKind: "opencode-plugin-direct" }, 1_000);
    const replies: string[] = [];
    await ingestWorkerCommand(s, makeMsg({ sessionId: "ses_oc", commandId: "cmd-oc" }), {
      sendTelegramReply: async (_c, text) => {
        replies.push(text);
      },
    });
    // No endpoint/token, so no adapter -- the pre-existing message, unchanged.
    expect(replies.join("\n")).toContain("Restart the session to re-register");
    expect(s.pullInbox.pendingCount("ses_oc", 2_000)).toBe(0);
  });
});

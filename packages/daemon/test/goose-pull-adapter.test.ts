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

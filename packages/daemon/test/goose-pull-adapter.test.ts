import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GoosePullAdapter, IN_REPLY_TO_MAX_CHARS, PULL_BACKEND_KIND } from "../src/adapters/goose-pull";
import { ingestWorkerCommand, selectAdapter } from "../src/worker/command-ingest";
import type { ExecuteMessage } from "../src/worker/poller";
import type { SessionRecord } from "../src/storage/types";

const OWNER = "1001";
const OWNERS: ReadonlySet<string> = new Set([OWNER]);

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

  function newDb(sessionId = "ses_pull"): StorageDb {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId, notify: true, backendKind: PULL_BACKEND_KIND, label: "worker" },
      1_000,
    );
    return storage;
  }

  function session(s: StorageDb, sessionId = "ses_pull"): SessionRecord {
    return s.sessions.get(sessionId)!;
  }

  function adapterFor(s: StorageDb, allowed: ReadonlySet<string> = OWNERS): GoosePullAdapter {
    return new GoosePullAdapter({ storage: s, allowedSenderIds: allowed, nowFn: () => 2_000 });
  }

  it("is a surface adapter with no question-reply path", () => {
    const s = newDb();
    const adapter = adapterFor(s);
    // Surface keeps its refusals away from the opencode revive/delete machinery,
    // and the interface forbids a surface adapter from implementing
    // deliverQuestionReply while that path still string-classifies.
    expect(adapter.failurePolicy).toBe("surface");
    expect((adapter as unknown as { deliverQuestionReply?: unknown }).deliverQuestionReply).toBeUndefined();
  });

  it("banks a command from the owner and reports it as banked, not as delivered", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "stop repinning", {
      commandId: "cmd-1",
      chatId: "42",
      senderId: OWNER,
    });

    expect(result.ok).toBe(true);
    // The flag is what makes command-ingest tell the human the truth about
    // latency. Without it the human sees Telegram's "Command sent" toast and
    // nothing else, which is false by hours for this backend.
    expect(result.meta?.banked).toBe(true);

    const [row] = s.pullInbox.claim("ses_pull", 3_000);
    expect(row!.payload).toBe("stop repinning");
    expect(row!.source).toBe("telegram-reply");
    expect(row!.chatId).toBe("42");
    expect(row!.senderId).toBe(OWNER);
    expect(row!.inReplyTo).toBeNull();
  });

  it("refuses a sender who is not on the allowlist, and banks nothing", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "merge everything", {
      commandId: "cmd-x",
      senderId: "2002",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("owner");
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });

  it("refuses a message with no sender id (fails closed: button taps, older workers)", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "hi", { commandId: "cmd-n" });
    expect(result.ok).toBe(false);
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });

  it("refuses a forwarded message even from the owner", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "someone else's words", {
      commandId: "cmd-f",
      senderId: OWNER,
      forwarded: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("forwarded");
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });

  it("refuses media, which the client cannot read", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "see screenshot", {
      commandId: "cmd-m",
      senderId: OWNER,
      media: { mime: "image/png", filename: "x.png", url: "data:image/png;base64,AA==" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("text only");
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });

  it("keeps the replied-to bot text, trimmed and bounded", async () => {
    const s = newDb();
    await adapterFor(s).deliverCommand(session(s), "yes", {
      commandId: "cmd-r",
      senderId: OWNER,
      inReplyTo: `  ${"q".repeat(IN_REPLY_TO_MAX_CHARS + 50)}  `,
    });
    const [row] = s.pullInbox.claim("ses_pull", 3_000);
    expect(row!.payload).toBe("yes");
    expect(row!.inReplyTo).toBe("q".repeat(IN_REPLY_TO_MAX_CHARS));
  });

  it("derives the bank id from the commandId, so an ingest retry banks once", async () => {
    const s = newDb();
    const adapter = adapterFor(s);
    await adapter.deliverCommand(session(s), "hello", { commandId: "cmd-1", senderId: OWNER });
    await adapter.deliverCommand(session(s), "hello", { commandId: "cmd-1", senderId: OWNER });
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(1);
  });

  it("refuses to bank for a session that is not a pull backend", async () => {
    const s = newDb();
    s.sessions.upsert(
      { sessionId: "ses_oc", notify: true, backendKind: "opencode-plugin-direct" },
      1_000,
    );
    const result = await adapterFor(s).deliverCommand(s.sessions.get("ses_oc")!, "hi", {
      commandId: "cmd-3",
      senderId: OWNER,
    });
    expect(result.ok).toBe(false);
    expect(s.pullInbox.pendingCount("ses_oc", 3_000)).toBe(0);
  });

  it("refuses an empty payload rather than banking a blank message", async () => {
    const s = newDb();
    const result = await adapterFor(s).deliverCommand(session(s), "   ", {
      commandId: "cmd-4",
      senderId: OWNER,
    });
    expect(result.ok).toBe(false);
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });
});

describe("selectAdapter for a pull session", () => {
  it("returns no adapter when the allowlist is empty or absent (fail closed)", () => {
    const s = openStorageDb(":memory:");
    s.sessions.upsert({ sessionId: "ses_pull", notify: true, backendKind: PULL_BACKEND_KIND }, 1);
    const rec = s.sessions.get("ses_pull")!;
    expect(selectAdapter(rec)).toBeNull();
    expect(selectAdapter(rec, undefined, undefined, { storage: s, allowedSenderIds: new Set() })).toBeNull();
    expect(selectAdapter(rec, undefined, undefined, { storage: s, allowedSenderIds: OWNERS })?.name).toBe("goose-pull");
    s.db.close();
  });

  it("never falls through to the nvim adapter, even for a row carrying nvim fields", () => {
    const s = openStorageDb(":memory:");
    s.sessions.upsert(
      { sessionId: "ses_pull", notify: true, backendKind: PULL_BACKEND_KIND, nvimSocket: "/tmp/n", ptyPath: "/dev/pts/1" },
      1,
    );
    const rec = s.sessions.get("ses_pull")!;
    expect(selectAdapter(rec)).toBeNull();
    s.db.close();
  });
});

/**
 * Wiring. An adapter that works when constructed by hand but is never selected is
 * the shape that let a merge gate sit dead for days while every test was green:
 * the tests called the gate directly and nothing asserted that anything called
 * it. So these drive the REAL entry point.
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
      sessionId: "ses_pull",
      command: "please look at the queue",
      chatId: "42",
      metadata: { senderId: OWNER },
      ...overrides,
    };
  }

  function pullDb(): StorageDb {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert(
      { sessionId: "ses_pull", notify: true, backendKind: PULL_BACKEND_KIND, label: "worker" },
      1_000,
    );
    return s;
  }

  async function ingest(s: StorageDb, msg: ExecuteMessage, allowed?: ReadonlySet<string>): Promise<string[]> {
    const replies: string[] = [];
    await ingestWorkerCommand(s, msg, {
      sendTelegramReply: async (_chatId, text) => {
        replies.push(text);
      },
      ...(allowed ? { pullAllowedSenderIds: allowed } : {}),
    });
    return replies;
  }

  it("banks a plain Telegram reply from the owner instead of dropping it as unreachable", async () => {
    const s = pullDb();
    const replies = await ingest(s, makeMsg(), OWNERS);

    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(1);
    expect(replies.join("\n")).not.toContain("Restart the session");
    expect(replies.join("\n").toLowerCase()).toContain("banked");
    // Names the session, so a reply in the wrong topic is obvious.
    expect(replies.join("\n")).toContain("worker");
    expect(s.inbox.listUnfinished()).toHaveLength(0);
  });

  it("carries the worker's forwarded flag and replied-to text into the bank", async () => {
    const s = pullDb();
    await ingest(s, makeMsg({ metadata: { senderId: OWNER, inReplyTo: "Rebase or wait?" } }), OWNERS);
    const [row] = s.pullInbox.claim("ses_pull", 2_000);
    expect(row!.inReplyTo).toBe("Rebase or wait?");

    const replies = await ingest(
      s,
      makeMsg({ commandId: "cmd-2", metadata: { senderId: OWNER, forwarded: true } }),
      OWNERS,
    );
    expect(replies.join("\n")).toContain("forwarded");
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(1);
  });

  it("coerces metadata closed: a numeric sender id is no sender, a truthy forward marker is a forward", async () => {
    const s = pullDb();
    const numeric = { senderId: 1001 } as unknown as ExecuteMessage["metadata"];
    await ingest(s, makeMsg({ metadata: numeric }), OWNERS);
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(0);

    const truthy = { senderId: OWNER, forwarded: "yes" } as unknown as ExecuteMessage["metadata"];
    const replies = await ingest(s, makeMsg({ commandId: "cmd-t", metadata: truthy }), OWNERS);
    expect(replies.join("\n")).toContain("forwarded");
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(0);
  });

  it("tells a non-owner the message was rejected and closes the command out", async () => {
    const s = pullDb();
    const replies = await ingest(s, makeMsg({ metadata: { senderId: "2002" } }), OWNERS);
    expect(replies.join("\n")).toContain("Command rejected");
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(0);
    expect(s.inbox.listUnfinished()).toHaveLength(0);
    // Surface: a refusal never deletes the session.
    expect(s.sessions.get("ses_pull")).not.toBeNull();
  });

  it("with no allowlist configured, a pull session is 'not reachable' exactly as before", async () => {
    const s = pullDb();
    const replies = await ingest(s, makeMsg());
    expect(replies.join("\n")).toContain("not reachable");
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(0);
    expect(s.sessions.get("ses_pull")).not.toBeNull();
  });

  it("leaves an opencode session's behaviour completely unchanged", async () => {
    const s = (storage = openStorageDb(":memory:"));
    s.sessions.upsert({ sessionId: "ses_oc", notify: true, backendKind: "opencode-plugin-direct" }, 1_000);
    const replies = await ingest(s, makeMsg({ sessionId: "ses_oc", commandId: "cmd-oc" }), OWNERS);
    // No endpoint/token, so no adapter -- the pre-existing message, unchanged.
    expect(replies.join("\n")).toContain("Restart the session to re-register");
    expect(s.pullInbox.pendingCount("ses_oc", 2_000)).toBe(0);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../src/app.js";
import { openStorageDb } from "../src/storage/database.js";
import { GooseSessionRunner } from "../src/goose/session-runner.js";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind.js";
import type { SessionRecord } from "../src/storage/types.js";

/**
 * Drives a finished goose turn through the REAL `/stop` route.
 *
 * This file exists because of a defect that unit tests and a 17-check live probe
 * both missed: every one of them supplied a fake `postStop`, so nothing
 * exercised the actual HTTP hop. The daemon runs with auth ENABLED (verified:
 * the live daemon answers 401 on an unauthenticated request) and `/stop` is not
 * on the anonymous allowlist, so the synthesised request needed a bearer token.
 * Without it every goose turn would have completed, been refused 401, and been
 * swallowed by the catch in `finishTurn` -- the human hearing nothing at all,
 * with a log line as the only evidence.
 *
 * The lesson generalises past this bug: a seam that every test stubs is a seam
 * no test covers.
 */
class StubClient {
  prompts: string[] = [];
  private resolve: ((v: unknown) => void) | undefined;
  private reject: ((e: Error) => void) | undefined;
  async connect(): Promise<void> {}
  isClosed(): boolean {
    return false;
  }
  prompt(_s: string, text: string): Promise<unknown> {
    this.prompts.push(text);
    return new Promise((r, j) => {
      this.resolve = r;
      this.reject = j;
    });
  }
  async steer(): Promise<unknown> {
    return { kind: "steered" };
  }
  activeRunId(): string | undefined {
    return undefined;
  }
  close(): void {}
  finish(stopReason = "end_turn"): void {
    this.resolve?.({ kind: "receipt", stopReason });
  }
  fail(err: Error): void {
    this.reject?.(err);
  }
}

function harness(authToken?: string, over: Record<string, unknown> = {}) {
  const storage = openStorageDb(":memory:");
  storage.sessions.upsert(
    {
      sessionId: "goose-1",
      notify: true,
      cwd: "/tmp/work",
      backendKind: GOOSE_BACKEND_KIND,
      backendProtocolVersion: 1,
      backendEndpoint: "ws://127.0.0.1:38910/acp",
      backendAuthToken: "tok",
    },
    1_000,
  );
  const app = createApp(storage, { ...(authToken ? { authToken } : {}), chatId: "42" });
  const client = new StubClient();
  const logs: string[] = [];

  const runner = new GooseSessionRunner({
    session: storage.sessions.get("goose-1") as SessionRecord,
    client: client as never,
    // The same construction index.ts uses, including the header under test.
    postStop: async (body) => {
      const res = await app(
        new Request("http://127.0.0.1:4731/stop", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`/stop returned ${res.status} ${detail.slice(0, 200)}`);
      }
    },
    touch: (id) => storage.sessions.touch(id, Date.now()),
    log: (m) => logs.push(m),
    ...over,
  });

  return { storage, client, runner, logs, app };
}

describe("goose turn reporting through the real /stop route", () => {
  it("enqueues a notification when auth is enabled", async () => {
    const { storage, client, runner, logs } = harness("secret-token");
    await runner.deliver("c1", "hello");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "the answer" } });
    client.finish();
    await runner.settled();

    expect(logs.join(" ")).not.toContain("could not report");
    const queued = storage.outbox.getReady(Date.now() + 1, 10);
    expect(queued.length).toBe(1);
    expect(JSON.stringify(queued[0])).toContain("the answer");
  });

  it("enqueues a notification when auth is disabled", async () => {
    const { storage, client, runner } = harness(undefined);
    await runner.deliver("c1", "hello");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } });
    client.finish();
    await runner.settled();

    expect(storage.outbox.getReady(Date.now() + 1, 10).length).toBe(1);
  });

  it("touches last_seen, so the reaper does not collect a live goose session", async () => {
    // Every writer of last_seen is otherwise plugin-driven, and a goose session
    // has no plugin.
    const { storage, client, runner } = harness("secret-token");
    const before = storage.sessions.get("goose-1")!.lastSeen;
    await runner.deliver("c1", "hello");
    client.finish();
    await runner.settled();
    expect(storage.sessions.get("goose-1")!.lastSeen).toBeGreaterThan(before);
  });

  it("reports a turn that stopped abnormally as an Error, rather than losing it", async () => {
    const { storage, client, runner } = harness("secret-token");
    await runner.deliver("c1", "hello");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "partial" } });
    client.finish("max_tokens");
    await runner.settled();

    const queued = storage.outbox.getReady(Date.now() + 1, 10);
    expect(queued.length).toBe(1);
    // The session itself must survive an abnormal stop.
    expect(storage.sessions.get("goose-1")).not.toBeNull();
  });
});

/**
 * The stalled-turn notice, through the same real route.
 *
 * The interesting part is not that the notice is sent -- it is that `/stop`
 * dedups on `notification_id`, so a stall notice posted under the turn's normal
 * id would CLAIM that id, and a late real answer would then be discarded as
 * "already queued". That turns a false positive from a spurious warning into a
 * silently lost answer, which is exactly the failure this project keeps finding.
 * Only the real route can show it, because the idempotency lives there.
 */
describe("a stalled goose turn, through the real /stop route", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies the human, and still delivers an answer that arrives afterwards", async () => {
    vi.useFakeTimers();
    const { storage, client, runner } = harness("secret-token", { turnIdleTimeoutMs: 60_000 });

    await runner.deliver("c1", "build everything");
    await vi.advanceTimersByTimeAsync(61_000);

    const afterStall = storage.outbox.getReady(Date.now() + 1, 10);
    expect(afterStall.length).toBe(1);
    expect(JSON.stringify(afterStall[0])).toMatch(/stopped sending updates/);

    // goose was alive the whole time and answers late.
    client.finish();
    await runner.settled();

    const afterAnswer = storage.outbox.getReady(Date.now() + 1, 10);
    expect(afterAnswer.length).toBe(2);
    // The real answer was NOT eaten by the stall notice's idempotency.
    expect(JSON.stringify(afterAnswer)).toContain("end_turn");
  });

  it("does not double-notify when the abandoned turn errors out later", async () => {
    vi.useFakeTimers();
    const { storage, client, runner } = harness("secret-token", { turnIdleTimeoutMs: 60_000 });

    await runner.deliver("c1", "doomed");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(storage.outbox.getReady(Date.now() + 1, 10).length).toBe(1);

    // The rejection our own close() caused. One failure, one notice.
    client.fail(new Error("goose connection closed (code 1006) while a turn was outstanding"));
    await runner.settled();
    expect(storage.outbox.getReady(Date.now() + 1, 10).length).toBe(1);
  });
});

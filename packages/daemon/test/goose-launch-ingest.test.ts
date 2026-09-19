import { describe, expect, it } from "vitest";
import { ingestGooseLaunchCommand, type GooseLaunchInput } from "../src/goose/launch-ingest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import type { Reachability } from "../src/goose/preflight";

/**
 * The goose launch path.
 *
 * The property that shapes everything here: **nothing may throw once the goose
 * session has been minted.** A throw propagates to the poller, which then skips
 * the ack, so the command is redelivered -- and a redelivered launch mints a
 * SECOND goose session. Losing the confirmation message is recoverable; silently
 * doubling the session is not. Before the mint the opposite holds: a throw is
 * the correct retry, because nothing exists yet to duplicate.
 */
function harness(over: Partial<GooseLaunchInput> = {}) {
  const storage = openStorageDb(":memory:");
  const replies: string[] = [];
  const prompted: Array<{ sessionId: string; text: string }> = [];
  const started: Array<{ sessionId: string; notify: boolean }> = [];
  const closed: string[] = [];
  let minted = 0;

  const input: GooseLaunchInput = {
    commandId: "cmd-1",
    directory: "/tmp/proj",
    prompt: "do the thing",
    chatId: "chat-1",
    machineId: "devbox",
    acpUrl: "ws://127.0.0.1:1/acp",
    acpToken: "tok",
    sessions: storage.sessions,
    now: () => 1_000,
    reachability: async (): Promise<Reachability> => ({ kind: "ok" }),
    createMintClient: () => ({
      connect: async () => {},
      newSession: async () => { minted++; return `20260920_${minted}`; },
      close: () => { closed.push("mint-client"); },
    }),
    runnerFor: (session) => ({
      deliver: async (_commandId: string, text: string) => {
        prompted.push({ sessionId: session.sessionId, text });
        return { ok: true as const };
      },
    }),
    onSessionStart: async (sessionId, notify) => { started.push({ sessionId, notify }); },
    sendTelegramReply: async (_chat, text) => { replies.push(text); },
    mintPigeonId: () => "gse_fixed",
    mintTimeoutMs: 5_000,
    ...over,
  };

  return { input, storage, replies, prompted, started, closed, mintedCount: () => minted };
}

describe("ingestGooseLaunchCommand", () => {
  it("mints a goose session, registers it under a pigeon id, and prompts it", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);

    const row = h.storage.sessions.get("gse_fixed");
    expect(row?.backendKind).toBe(GOOSE_BACKEND_KIND);
    expect(row?.backendSessionId).toBe("20260920_1");
    expect(row?.cwd).toBe("/tmp/proj");
    // The prompt goes through the RUNNER, not the minting client: the runner is
    // what owns the turn, routes updates, and reports the stop.
    expect(h.prompted).toEqual([{ sessionId: "gse_fixed", text: "do the thing" }]);
    h.storage.db.close();
  });

  it("closes the throwaway minting client rather than leaking its socket", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);
    expect(h.closed).toEqual(["mint-client"]);
    h.storage.db.close();
  });

  it("announces the session so the worker can route to it", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);
    expect(h.started).toEqual([{ sessionId: "gse_fixed", notify: true }]);
    h.storage.db.close();
  });

  it("expands a bare project name and resolves ~, as the opencode path does", async () => {
    const h = harness({ directory: "~/somewhere" });
    await ingestGooseLaunchCommand(h.input);
    expect(h.storage.sessions.get("gse_fixed")?.cwd).toBe(`${process.env.HOME}/somewhere`);
    h.storage.db.close();
  });

  it("tells the human the session id and directory", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain("gse_fixed");
    expect(h.replies[0]).toContain("/tmp/proj");
  });

  /**
   * launch-ingest.ts ends its opencode confirmation with "The pigeon plugin will
   * notify you...". goose has no plugin -- that is the entire reason this path
   * exists -- so repeating it would promise a mechanism that is not there.
   */
  it("does not promise the pigeon plugin, which a goose session does not have", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);
    expect(h.replies[0]).not.toContain("plugin");
    h.storage.db.close();
  });

  it("names goose's own id too, so the session is findable in goose's own CLI", async () => {
    const h = harness();
    await ingestGooseLaunchCommand(h.input);
    expect(h.replies[0]).toContain("20260920_1");
    h.storage.db.close();
  });

  /**
   * A LAUNCH never throws, and that is a different answer from the one the
   * delivery adapter gives for the same failures.
   *
   * The adapter throws on an unreachable serve so the command is redelivered,
   * because there the command is the human's message to a live session and
   * losing it is expensive. Two things make that wrong here.
   *
   * First, the retry is neither bounded nor visible on this path.
   * MAX_REDELIVERIES lives in ingestWorkerCommand, which only the `execute`
   * path enters; onLaunch calls this module directly. So a throw buys a retry
   * every 60s for up to 24h, with NOTHING said to the human -- and the most
   * common failure of all is "goose serve was not running".
   *
   * Second, a lost launch costs the human one retyped line, where a lost
   * message costs them what they wrote. The opencode launch path already
   * answers this way: unhealthy serve, say so, ack.
   */
  describe("before the mint: report and ack, never throw", () => {
    it("reports an unreachable serve rather than retrying silently for 24h", async () => {
      const h = harness({
        reachability: async (): Promise<Reachability> => ({ kind: "unreachable", cause: "ECONNREFUSED" }),
      });
      await expect(ingestGooseLaunchCommand(h.input)).resolves.toBeUndefined();
      expect(h.replies.join("\n")).toMatch(/ECONNREFUSED/);
      expect(h.mintedCount()).toBe(0);
      h.storage.db.close();
    });

    it("reports a client that cannot connect, rather than throwing", async () => {
      const h = harness({
        createMintClient: () => ({
          connect: async () => { throw new Error("handshake refused"); },
          newSession: async () => "unused",
          close: () => {},
        }),
      });
      await expect(ingestGooseLaunchCommand(h.input)).resolves.toBeUndefined();
      expect(h.replies.join("\n")).toMatch(/handshake refused/);
      h.storage.db.close();
    });

    /**
     * goose has no per-request timeout by design, and a socket that opens and
     * then never answers emits no close event. The poller dispatches SERIALLY,
     * so an unbounded await here freezes command delivery for EVERY session on
     * the machine -- including another session's /interrupt -- until the daemon
     * is restarted. The runner bounds exactly these calls for exactly this
     * reason; so must this path.
     */
    it("bounds a mint that never answers, instead of freezing the poller", async () => {
      const h = harness({
        mintTimeoutMs: 40,
        createMintClient: () => ({
          connect: async () => {},
          newSession: () => new Promise<string>(() => { /* never settles */ }),
          close: () => {},
        }),
      });
      await expect(ingestGooseLaunchCommand(h.input)).resolves.toBeUndefined();
      expect(h.replies.join("\n")).toMatch(/did not answer/i);
      h.storage.db.close();
    });

    it("closes the client even when the mint fails, so the socket is not leaked", async () => {
      const h = harness({
        createMintClient: () => ({
          connect: async () => {},
          newSession: async () => { throw new Error("nope"); },
          close: () => { h.closed.push("mint-client"); },
        }),
      });
      await ingestGooseLaunchCommand(h.input);
      expect(h.closed).toEqual(["mint-client"]);
      h.storage.db.close();
    });

    it("reports and does NOT throw for a permanently wrong credential", async () => {
      const h = harness({
        reachability: async (): Promise<Reachability> => ({ kind: "auth-failed" }),
      });
      // Retrying a rejected token every 60s for a day fixes nothing.
      await ingestGooseLaunchCommand(h.input);
      expect(h.replies[0]).toMatch(/token/i);
      expect(h.mintedCount()).toBe(0);
      h.storage.db.close();
    });

    it("reports and does NOT throw when the port is not goose at all", async () => {
      const h = harness({
        reachability: async (): Promise<Reachability> => ({ kind: "not-goose", status: 200 }),
      });
      await ingestGooseLaunchCommand(h.input);
      expect(h.replies[0]).toMatch(/port/i);
      expect(h.mintedCount()).toBe(0);
      h.storage.db.close();
    });
  });

  describe("after the mint, a throw would duplicate the session", () => {
    /**
     * THE case this module is shaped around. If sending the first prompt throws
     * and that escapes, the poller skips the ack and redelivers -- and the
     * redelivered launch mints a second goose session, leaving the human with
     * two, one of which nobody is watching.
     */
    it("reports a failed first prompt instead of throwing", async () => {
      const h = harness({
        runnerFor: () => ({
          deliver: async () => { throw new Error("socket died"); },
        }),
      });

      await expect(ingestGooseLaunchCommand(h.input)).resolves.toBeUndefined();

      // The session still exists and is still registered -- it was really
      // created, and pretending otherwise would orphan it.
      expect(h.storage.sessions.get("gse_fixed")?.backendSessionId).toBe("20260920_1");
      // And the human is told, naming the session so it can be driven by hand.
      expect(h.replies.join("\n")).toMatch(/socket died/);
      expect(h.replies.join("\n")).toContain("gse_fixed");
      h.storage.db.close();
    });

    it("reports a failed announcement instead of throwing", async () => {
      const h = harness({
        onSessionStart: async () => { throw new Error("worker 503"); },
      });
      await expect(ingestGooseLaunchCommand(h.input)).resolves.toBeUndefined();
      expect(h.replies.join("\n")).toMatch(/worker 503/);
      h.storage.db.close();
    });

    /**
     * Documents an exposure rather than a guarantee, so nobody reads the
     * not-throwing above as full idempotence.
     *
     * A redelivery DOES mint a second session. Never throwing after the mint is
     * what makes redelivery unlikely -- the handler returns, so the poller acks
     * -- but an ack that fails on the wire, or a daemon killed mid-handler,
     * still redelivers. The opencode launch path has exactly the same exposure.
     *
     * Deliberately not closed with an `inbox.persist` claim gate: that turns
     * this LOUD failure (two sessions, both visible) into a SILENT one (a
     * daemon that dies between the claim and the mint drops the launch with
     * nobody told), which is the worse trade for this system.
     */
    it("does mint twice on redelivery -- known, and loud rather than silent", async () => {
      const h = harness();
      await ingestGooseLaunchCommand(h.input);
      await ingestGooseLaunchCommand(h.input);
      expect(h.mintedCount()).toBe(2);
      h.storage.db.close();
    });
  });
});

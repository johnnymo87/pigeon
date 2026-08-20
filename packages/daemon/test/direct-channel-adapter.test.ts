import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { startDirectChannelServer } from "../../opencode-plugin/src/direct-channel";
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  AckRejectReason,
  ResultErrorCode,
} from "../src/opencode-direct/contracts";
import { DirectChannelAdapter } from "../src/adapters/direct-channel";
import type { SessionRecord } from "../src/storage/types";
import { openStorageDb } from "../src/storage/database";
import { hashPrompt } from "../src/hash-prompt";

function makeSession(): SessionRecord {
  return {
    sessionId: "s1",
    backendKind: "opencode-plugin-direct",
    backendProtocolVersion: 1,
    backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
    backendAuthToken: "tok",
  } as unknown as SessionRecord;
}

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      ack: {
        type: OpencodeDirectMessageType.Ack,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: "c1",
        commandId: "c1",
        sessionId: "s1",
        accepted: true,
        acceptedAt: Date.now(),
      },
      result: {
        type: OpencodeDirectMessageType.Result,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: "c1",
        commandId: "c1",
        sessionId: "s1",
        success: true,
        finishedAt: Date.now(),
        output: "queued",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("DirectChannelAdapter execute (Phase 2)", () => {
  // The execute path makes a SINGLE attempt per call. Retrying a non-idempotent
  // injection is the responsibility of command-ingest's deadline-aware budget
  // loop (which retries ambiguous timeouts through the now-idempotent plugin),
  // so the retry lives in exactly one layer. Here we lock that the adapter does
  // NOT retry on its own (an ambiguous timeout returns a single-attempt failure).
  // See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2b).
  it("makes a single attempt and does not retry on an ambiguous timeout", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("The operation was aborted");
    });

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((result.meta as { attempts?: number } | undefined)?.attempts).toBe(1);
  });

  it("succeeds on a single attempt when the plugin responds ok", async () => {
    const fetchFn = vi.fn(async () => successResponse());

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("records the prompt in injectedPrompts repository before issuing execute request", async () => {
    const db = openStorageDb(":memory:");
    let recordedAtCallTime = false;
    const fetchFn = vi.fn(async () => {
      recordedAtCallTime = db.injectedPrompts.has("s1", hashPrompt("fix the bug"));
      throw new Error("network error");
    });

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
      injectedPrompts: db.injectedPrompts,
    });

    await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(recordedAtCallTime).toBe(true);
    expect(db.injectedPrompts.has("s1", hashPrompt("fix the bug"))).toBe(true);
  });

  describe("diagnostic metadata enrichment and security (pigeon-m426.1)", () => {
    it("surfaces endpoint, status, rejectReason, and tokenFp on 401 UNAUTHORIZED deliverCommand failure without leaking raw token", async () => {
      const rawSecretToken = "super-secret-auth-token-12345-uuid-67890";
      const session: SessionRecord = {
        sessionId: "s1",
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        backendAuthToken: rawSecretToken,
      } as unknown as SessionRecord;

      const fetchFn = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ack: {
              type: OpencodeDirectMessageType.Ack,
              version: OPENCODE_DIRECT_PROTOCOL_VERSION,
              requestId: "c1",
              commandId: "c1",
              sessionId: "s1",
              accepted: false,
              acceptedAt: Date.now(),
              rejectReason: AckRejectReason.Unauthorized,
              message: "Invalid auth token",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      });

      const adapter = new DirectChannelAdapter({
        fetchFn: fetchFn as unknown as typeof fetch,
        sleep: async () => {},
      });

      const result = await adapter.deliverCommand(session, "run something", {
        commandId: "c1",
        chatId: "5",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe(AckRejectReason.Unauthorized);

      const expectedTokenFp = createHash("sha256").update(rawSecretToken).digest("hex").slice(0, 8);
      expect(result.meta).toEqual({
        endpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        status: 401,
        attempts: 1,
        rejectReason: "UNAUTHORIZED",
        tokenFp: expectedTokenFp,
      });

      // Security assertion: raw secret auth token must appear NOWHERE in meta or error
      const metaString = JSON.stringify(result.meta);
      expect(metaString).not.toContain(rawSecretToken);
      expect(result.error).not.toContain(rawSecretToken);
      // Ensure tokenFp is NOT a prefix of the raw token itself
      expect(rawSecretToken.startsWith(result.meta!.tokenFp as string)).toBe(false);
    });

    it("generates stable tokenFp for the same token across multiple calls", async () => {
      const token = "consistent-token-value";
      const session1: SessionRecord = {
        sessionId: "s1",
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        backendAuthToken: token,
      } as unknown as SessionRecord;
      const session2: SessionRecord = {
        sessionId: "s2",
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:4097/pigeon/direct/execute",
        backendAuthToken: token,
      } as unknown as SessionRecord;

      const fetchFn = vi.fn(async () => {
        return new Response(JSON.stringify({ error: "fail" }), { status: 500 });
      });

      const adapter = new DirectChannelAdapter({
        fetchFn: fetchFn as unknown as typeof fetch,
        sleep: async () => {},
      });

      const result1 = await adapter.deliverCommand(session1, "cmd1", { commandId: "c1" });
      const result2 = await adapter.deliverCommand(session2, "cmd2", { commandId: "c2" });

      const fp1 = result1.meta?.tokenFp;
      const fp2 = result2.meta?.tokenFp;

      expect(fp1).toBeDefined();
      expect(typeof fp1).toBe("string");
      expect(fp1).toHaveLength(8);
      expect(fp1).toBe(fp2);
      expect(fp1).toBe(createHash("sha256").update(token).digest("hex").slice(0, 8));
    });

    it("surfaces endpoint and tokenFp on early return when missing backendEndpoint or backendAuthToken", async () => {
      const rawSecretToken = "token-for-missing-endpoint";
      const adapter = new DirectChannelAdapter();

      // Case 1: has endpoint, missing token
      const sessionWithOnlyEndpoint: SessionRecord = {
        sessionId: "s1",
        backendEndpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        backendAuthToken: "",
      } as unknown as SessionRecord;

      const result1 = await adapter.deliverCommand(sessionWithOnlyEndpoint, "cmd", { commandId: "c1" });
      expect(result1.ok).toBe(false);
      expect(result1.error).toBe("Session missing backendEndpoint or backendAuthToken");
      expect(result1.meta).toEqual({
        endpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
      });

      // Case 2: has token, missing endpoint
      const sessionWithOnlyToken: SessionRecord = {
        sessionId: "s2",
        backendEndpoint: "",
        backendAuthToken: rawSecretToken,
      } as unknown as SessionRecord;

      const result2 = await adapter.deliverCommand(sessionWithOnlyToken, "cmd", { commandId: "c2" });
      expect(result2.ok).toBe(false);
      expect(result2.error).toBe("Session missing backendEndpoint or backendAuthToken");
      const expectedTokenFp = createHash("sha256").update(rawSecretToken).digest("hex").slice(0, 8);
      expect(result2.meta).toEqual({
        tokenFp: expectedTokenFp,
      });
      expect(JSON.stringify(result2.meta)).not.toContain(rawSecretToken);

      // Case 3: both missing
      const sessionWithNeither: SessionRecord = {
        sessionId: "s3",
        backendEndpoint: "",
        backendAuthToken: "",
      } as unknown as SessionRecord;

      const result3 = await adapter.deliverCommand(sessionWithNeither, "cmd", { commandId: "c3" });
      expect(result3.ok).toBe(false);
      expect(result3.error).toBe("Session missing backendEndpoint or backendAuthToken");
      expect(result3.meta?.endpoint).toBeUndefined();
      expect(result3.meta?.tokenFp).toBeUndefined();
    });

    it("does not include endpoint, tokenFp, or rejectReason in meta on deliverCommand success", async () => {
      const fetchFn = vi.fn(async () => successResponse());
      const adapter = new DirectChannelAdapter({
        fetchFn: fetchFn as unknown as typeof fetch,
        sleep: async () => {},
      });

      const result = await adapter.deliverCommand(makeSession(), "cmd", { commandId: "c1" });
      expect(result.ok).toBe(true);
      expect(result.meta).toEqual({
        attempts: 1,
        status: 200,
      });
      expect(result.meta?.endpoint).toBeUndefined();
      expect(result.meta?.tokenFp).toBeUndefined();
      expect(result.meta?.rejectReason).toBeUndefined();
    });

    it("surfaces endpoint, status, and tokenFp without leaking raw token when deliverQuestionReply fails on 401; a stale-token 401 on question-reply yields status and endpoint but no rejectReason (see pigeon-m426.4)", async () => {
      const rawSecretToken = "secret-question-reply-token";
      const session: SessionRecord = {
        sessionId: "s1",
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        backendAuthToken: rawSecretToken,
      } as unknown as SessionRecord;

      const fetchFn = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ack: {
              type: OpencodeDirectMessageType.Ack,
              version: OPENCODE_DIRECT_PROTOCOL_VERSION,
              requestId: "c1",
              commandId: "c1",
              sessionId: "s1",
              accepted: false,
              acceptedAt: Date.now(),
              rejectReason: AckRejectReason.Unauthorized,
              message: "Unauthorized",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      });

      const adapter = new DirectChannelAdapter({
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      const result = await adapter.deliverQuestionReply!(
        session,
        { questionRequestId: "q1", answers: [["A"]] },
        { commandId: "c1" },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Invalid question reply result");
      const expectedTokenFp = createHash("sha256").update(rawSecretToken).digest("hex").slice(0, 8);
      expect(result.meta).toEqual({
        endpoint: "http://127.0.0.1:4096/pigeon/direct/execute",
        status: 401,
        tokenFp: expectedTokenFp,
      });
      expect(result.meta?.rejectReason).toBeUndefined();

      // Security assertion
      expect(JSON.stringify(result.meta)).not.toContain(rawSecretToken);
      expect(result.error).not.toContain(rawSecretToken);

      // Question reply early return on missing endpoint/token
      const sessionMissingEndpoint: SessionRecord = {
        sessionId: "s1",
        backendEndpoint: "",
        backendAuthToken: rawSecretToken,
      } as unknown as SessionRecord;
      const earlyResult = await adapter.deliverQuestionReply!(
        sessionMissingEndpoint,
        { questionRequestId: "q1", answers: [["A"]] },
        { commandId: "c2" },
      );
      expect(earlyResult.ok).toBe(false);
      expect(earlyResult.meta).toEqual({
        tokenFp: expectedTokenFp,
      });

      // Question reply success path: meta only has status
      const successFetchFn = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            result: {
              type: OpencodeDirectMessageType.QuestionReplyResult,
              version: OPENCODE_DIRECT_PROTOCOL_VERSION,
              requestId: "c3",
              sessionId: "s1",
              questionRequestId: "q1",
              success: true,
              finishedAt: Date.now(),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const successAdapter = new DirectChannelAdapter({ fetchFn: successFetchFn as unknown as typeof fetch });
      const successResult = await successAdapter.deliverQuestionReply!(
        session,
        { questionRequestId: "q1", answers: [["A"]] },
        { commandId: "c3" },
      );
      expect(successResult.ok).toBe(true);
      expect(successResult.meta).toEqual({ status: 200 });
      expect(successResult.meta?.endpoint).toBeUndefined();
      expect(successResult.meta?.tokenFp).toBeUndefined();
    });

    it("contract test: real startDirectChannelServer with mismatched auth token returns meta.rejectReason === AckRejectReason.Unauthorized", async () => {
      const server = await startDirectChannelServer({
        authToken: "valid-server-token-123",
        onExecute: async () => ({ success: true }),
      });

      try {
        const adapter = new DirectChannelAdapter();
        const sessionWithWrongToken: SessionRecord = {
          sessionId: "sess-contract-401",
          backendKind: "opencode-plugin-direct",
          backendProtocolVersion: 1,
          backendEndpoint: server.endpoint,
          backendAuthToken: "wrong-client-token-456",
        } as unknown as SessionRecord;

        const result = await adapter.deliverCommand(sessionWithWrongToken, "echo test", {
          commandId: "cmd-contract-1",
          chatId: "42",
        });

        expect(result.ok).toBe(false);
        expect(result.error).toBe(AckRejectReason.Unauthorized);
        expect(result.meta).toBeDefined();
        expect(result.meta?.status).toBe(401);
        expect(result.meta?.rejectReason).toBe(AckRejectReason.Unauthorized);
        expect(result.meta?.endpoint).toBe(server.endpoint);
        expect(result.meta?.attempts).toBe(1);
        const expectedTokenFp = createHash("sha256").update("wrong-client-token-456").digest("hex").slice(0, 8);
        expect(result.meta?.tokenFp).toBe(expectedTokenFp);
      } finally {
        await server.close();
      }
    });

    it("contract test: real startDirectChannelServer question-reply with mismatched auth token returns status 401 with NO meta.rejectReason", async () => {
      const server = await startDirectChannelServer({
        authToken: "valid-server-token-123",
        onExecute: async () => ({ success: true }),
        onQuestionReply: async () => ({ success: true }),
      });

      try {
        const adapter = new DirectChannelAdapter();
        const sessionWithWrongToken: SessionRecord = {
          sessionId: "sess-contract-qr-401",
          backendKind: "opencode-plugin-direct",
          backendProtocolVersion: 1,
          backendEndpoint: server.endpoint,
          backendAuthToken: "wrong-client-token-456",
        } as unknown as SessionRecord;

        const result = await adapter.deliverQuestionReply!(
          sessionWithWrongToken,
          { questionRequestId: "qreq-1", answers: [["yes"]] },
          { commandId: "cmd-contract-2", chatId: "42" },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toBe("Invalid question reply result");
        expect(result.meta).toBeDefined();
        expect(result.meta?.status).toBe(401);
        expect(result.meta?.rejectReason).toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });
});

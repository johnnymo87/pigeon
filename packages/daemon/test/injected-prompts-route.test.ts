import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("POST /injected-prompts route", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, authToken?: string) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now, authToken });
  }

  it("suppresses /mirror and enqueues no outbox row when recorded via POST /injected-prompts", async () => {
    const app = newApp();
    const sessionId = "ses_test1";
    const text = "Run tests on auth.ts";

    // Record via the route
    const recordRes = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      }),
    );
    expect(recordRes.status).toBe(200);
    expect(await recordRes.json()).toEqual({ recorded: true });

    // Now POST to /mirror with same (sessionId, text)
    const mirrorRes = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "msg_1", text }),
      }),
    );
    expect(mirrorRes.status).toBe(200);
    expect(await mirrorRes.json()).toEqual({ mirrored: false });

    // Assert outbox has no rows of kind mirror
    const outboxRows = storage!.outbox.getReady().filter((r) => r.kind === "mirror");
    expect(outboxRows.length).toBe(0);
  });

  it("mirrors and creates outbox row when prompt was NOT recorded (control test)", async () => {
    const app = newApp();
    const sessionId = "ses_control";
    const text = "Run tests on auth.ts";

    const mirrorRes = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "msg_ctrl", text }),
      }),
    );
    expect(mirrorRes.status).toBe(200);
    expect(await mirrorRes.json()).toEqual({ mirrored: true });

    const outboxRows = storage!.outbox.getReady().filter((r) => r.kind === "mirror");
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.notificationId).toBe("m:ses_control:msg_ctrl");
  });

  it("supports counted semantics (recording twice suppresses two mirrors, third mirrors)", async () => {
    const app = newApp();
    const sessionId = "ses_count";
    const text = "continue";

    // Record twice
    for (let i = 0; i < 2; i++) {
      const res = await app(
        new Request("http://localhost/injected-prompts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, text }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true });
    }

    // First mirror call suppressed
    const m1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "msg_1", text }),
      }),
    );
    expect(await m1.json()).toEqual({ mirrored: false });

    // Second mirror call suppressed
    const m2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "msg_2", text }),
      }),
    );
    expect(await m2.json()).toEqual({ mirrored: false });

    // Third mirror call mirrors
    const m3 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "msg_3", text }),
      }),
    );
    expect(await m3.json()).toEqual({ mirrored: true });
  });

  it("enforces session scoping (record for session A does not suppress session B)", async () => {
    const app = newApp();
    const text = "Shared prompt text";

    // Record for session A
    await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_A", text }),
      }),
    );

    // Mirror for session B -> mirrors!
    const resB = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_B", messageId: "msg_B", text }),
      }),
    );
    expect(await resB.json()).toEqual({ mirrored: true });
  });

  it("enforces exact-byte matching (no text normalization)", async () => {
    const app = newApp();
    const sessionId = "ses_exact";

    // Record "hello"
    await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text: "hello" }),
      }),
    );

    // Variations must not be suppressed
    for (const [msgId, varText] of [
      ["m1", " hello"],
      ["m2", "hello\n"],
      ["m3", "Hello"],
    ]) {
      const res = await app(
        new Request("http://localhost/mirror", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, messageId: msgId, text: varText }),
        }),
      );
      expect(await res.json(), `Failed for variation '${varText}'`).toEqual({ mirrored: true });
    }
  });

  it("records the raw untrimmed text, so a trailing newline is suppressed and its trimmed form is not", async () => {
    // Guards the record side specifically. Every other text in this file is
    // trim-stable, so a `hashPrompt(text.trim())` in the route would pass them
    // all while silently breaking every heredoc-built launch prompt: the
    // recorded hash would be of the trimmed text and the mirror, which hashes
    // the raw text, would never match it. The trim in the route is only the
    // emptiness test, never applied to the hashed string.
    const app = newApp();
    const sessionId = "ses_raw";
    const raw = "deploy the thing\n";

    const recorded = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text: raw }),
      }),
    );
    expect(await recorded.json()).toEqual({ recorded: true });

    // The trimmed form is a DIFFERENT prompt and must still mirror.
    const trimmed = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "m-trimmed", text: raw.trim() }),
      }),
    );
    expect(await trimmed.json()).toEqual({ mirrored: true });

    // The exact raw text is the one that was recorded, so it is suppressed.
    const exact = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, messageId: "m-raw", text: raw }),
      }),
    );
    expect(await exact.json()).toEqual({ mirrored: false });
  });

  it("returns 400 for missing/invalid sessionId, text, and whitespace-only text", async () => {
    const app = newApp();

    // 1. Missing sessionId
    const res1 = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(res1.status).toBe(400);
    expect(await res1.json()).toEqual({ error: "sessionId is required" });

    // 2. Non-string sessionId
    const res1b = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: 123, text: "hello" }),
      }),
    );
    expect(res1b.status).toBe(400);
    expect(await res1b.json()).toEqual({ error: "sessionId is required" });

    // 3. session_id alias works when sessionId missing
    const res1c = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "ses_alias", text: "hello" }),
      }),
    );
    expect(res1c.status).toBe(200);

    // 4. Missing text
    const res2 = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1" }),
      }),
    );
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: "text is required" });

    // 5. Non-string text
    const res3 = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: 12345 }),
      }),
    );
    expect(res3.status).toBe(400);
    expect(await res3.json()).toEqual({ error: "text is required" });

    // 6. Empty text
    const res4 = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: "" }),
      }),
    );
    expect(res4.status).toBe(400);
    expect(await res4.json()).toEqual({ error: "text is required" });

    // 7. Whitespace-only text
    const res5 = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: "   \n\t " }),
      }),
    );
    expect(res5.status).toBe(400);
    expect(await res5.json()).toEqual({ error: "text is required" });
  });

  it("requires bearer token when auth is enabled (401 without, 200 with)", async () => {
    const app = newApp(1_000, "secret123");

    // Without token -> 401
    const resUnauth = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_auth", text: "hello" }),
      }),
    );
    expect(resUnauth.status).toBe(401);

    // With wrong token -> 401
    const resWrong = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": "Bearer wrong",
        },
        body: JSON.stringify({ sessionId: "ses_auth", text: "hello" }),
      }),
    );
    expect(resWrong.status).toBe(401);

    // With correct token -> 200
    const resAuth = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": "Bearer secret123",
        },
        body: JSON.stringify({ sessionId: "ses_auth", text: "hello" }),
      }),
    );
    expect(resAuth.status).toBe(200);
    expect(await resAuth.json()).toEqual({ recorded: true });
  });

  it("does not require session registration before recording", async () => {
    const app = newApp();
    const unknownSessionId = "ses_unregistered_999";
    const text = "some prompt for unregistered session";

    // Confirm session does not exist in db
    expect(storage!.sessions.get(unknownSessionId)).toBeNull();

    // Record via route
    const recRes = await app(
      new Request("http://localhost/injected-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: unknownSessionId, text }),
      }),
    );
    expect(recRes.status).toBe(200);
    expect(await recRes.json()).toEqual({ recorded: true });

    // Session is still not created/registered in sessions table
    expect(storage!.sessions.get(unknownSessionId)).toBeNull();

    // Mirror call for unknownSessionId is still suppressed
    const mirrorRes = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: unknownSessionId, messageId: "msg_unreg", text }),
      }),
    );
    expect(await mirrorRes.json()).toEqual({ mirrored: false });
  });
});

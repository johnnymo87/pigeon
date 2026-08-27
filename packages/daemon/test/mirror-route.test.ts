import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPrompt } from "../src/hash-prompt";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { DEFAULT_DECLARED_QUIET_TTL_MS } from "../src/notify-policy";

describe("POST /mirror route", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000) {
    storage = openStorageDb(":memory:");
    return createApp(storage, { nowFn: () => now });
  }

  it("returns 400 when sessionId is missing", async () => {
    const app = newApp();
    const res = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "msg_1", text: "hello" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/i);
  });

  it("returns 400 when messageId is missing", async () => {
    const app = newApp();
    const res = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: "hello" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/messageId/i);
  });

  it("returns { mirrored: false } and enqueues no row for empty or whitespace-only text", async () => {
    const app = newApp();
    const res1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_1", text: "" }),
      }),
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ mirrored: false });

    const res2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_2", text: "   \n\t " }),
      }),
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ mirrored: false });

    expect(storage!.outbox.getReady().length).toBe(0);
  });

  it("enqueues exactly one outbox row for an un-recorded prompt", async () => {
    const app = newApp();
    // Seed session so title/cwd exist
    storage!.sessions.upsert(
      {
        sessionId: "ses_abc",
        title: "My Feature Session",
        cwd: "/home/dev/projects/pigeon",
      },
      1_000,
    );

    const res = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "ses_abc",
          messageId: "msg_123",
          text: "Fix the failing test in auth.ts",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mirrored: true });

    const ready = storage!.outbox.getReady();
    expect(ready.length).toBe(1);

    const row = ready[0]!;
    expect(row.kind).toBe("mirror");
    expect(row.notificationId).toBe("m:ses_abc:msg_123");
    expect(row.sessionId).toBe("ses_abc");

    const payload = JSON.parse(row.payload);
    expect(payload.notificationId).toBe("m:ses_abc:msg_123");
    expect(payload.title).toBe("My Feature Session");
    expect(payload.dir).toBe("/home/dev/projects/pigeon");
    expect(payload.threaded).toBe(true);
    expect(payload.replyMarkup).toBeUndefined();
    expect(row.token).toBe("");

    // Message header includes session display name (title)
    expect(payload.messages).toBeDefined();
    expect(payload.messages[0].text).toContain("🧑 My Feature Session");
    expect(payload.messages[0].text).toContain("Fix the failing test in auth.ts");
  });

  it("suppresses mirror when prompt was recorded via opencode-client sendPrompt path", async () => {
    const app = newApp();
    const promptText = "Injected swarm prompt";
    const hash = hashPrompt(promptText);

    // Simulate pre-recording an injected prompt (as sendPrompt does)
    storage!.injectedPrompts.record("ses_1", hash, 1_000);

    const res = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "ses_1",
          messageId: "msg_inv1",
          text: promptText,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mirrored: false });
    expect(storage!.outbox.getReady().length).toBe(0);
  });

  it("suppresses mirror when prompt was recorded via direct channel path", async () => {
    const app = newApp();
    const promptText = "Injected direct channel command";
    const hash = hashPrompt(promptText);

    // Simulate pre-recording an injected prompt (as direct-channel dispatch does)
    storage!.injectedPrompts.record("ses_2", hash, 1_000);

    const res = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "ses_2",
          messageId: "msg_inv2",
          text: promptText,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mirrored: false });
    expect(storage!.outbox.getReady().length).toBe(0);
  });

  it("suppresses both mirrors when duplicate identical command is recorded twice", async () => {
    const app = newApp();
    const promptText = "continue";
    const hash = hashPrompt(promptText);

    // Recorded twice (e.g. two "continue" commands within 15 min)
    storage!.injectedPrompts.record("ses_1", hash, 1_000);
    storage!.injectedPrompts.record("ses_1", hash, 1_000);

    const res1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_c1", text: promptText }),
      }),
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ mirrored: false });

    const res2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_c2", text: promptText }),
      }),
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ mirrored: false });

    expect(storage!.outbox.getReady().length).toBe(0);
  });

  it("suppresses both mirrors on retry-after-timeout (same text recorded twice, mirrored twice)", async () => {
    const app = newApp();
    const promptText = "heavy command that timed out";
    const hash = hashPrompt(promptText);

    // Initial attempt records
    storage!.injectedPrompts.record("ses_1", hash, 1_000);
    // Retry attempt records again
    storage!.injectedPrompts.record("ses_1", hash, 1_005);

    const res1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_t1", text: promptText }),
      }),
    );
    expect(await res1.json()).toEqual({ mirrored: false });

    const res2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_t2", text: promptText }),
      }),
    );
    expect(await res2.json()).toEqual({ mirrored: false });

    expect(storage!.outbox.getReady().length).toBe(0);
  });

  it("mirrors when the recorded count drains and the SAME text is typed in the TUI", async () => {
    const app = newApp();
    const promptText = "continue";
    const hash = hashPrompt(promptText);

    // Recorded once
    storage!.injectedPrompts.record("ses_1", hash, 1_000);

    // 1st mirror call consumes the recorded injection
    const res1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_1", text: promptText }),
      }),
    );
    expect(await res1.json()).toEqual({ mirrored: false });

    // 2nd mirror call for same text (now typed in TUI) is a MISS -> mirrors!
    const res2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", messageId: "msg_2", text: promptText }),
      }),
    );
    expect(await res2.json()).toEqual({ mirrored: true });

    const ready = storage!.outbox.getReady();
    expect(ready.length).toBe(1);
    expect(ready[0]!.notificationId).toBe("m:ses_1:msg_2");
  });

  it("deduplicates when posting the same sessionId + messageId twice", async () => {
    const app = newApp();
    const reqBody = {
      sessionId: "ses_dup",
      messageId: "msg_dup",
      text: "TUI typed prompt",
    };

    const res1 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      }),
    );
    expect(await res1.json()).toEqual({ mirrored: true });

    const res2 = await app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      }),
    );
    expect(res2.status).toBe(200);

    // Outbox should still have exactly one row due to notificationId deduplication
    expect(storage!.outbox.getReady().length).toBe(1);
  });

  describe("declared-quiet sessions do not mirror", () => {
    // REGRESSION. Production, 2026-08-11: lgtm's automated reviews had their Stop
    // correctly suppressed by session_origin, but still mirrored their own launch
    // prompt -- 16 mirror rows against 1 stop row for the quiet population. Because a
    // Telegram topic is created by a session's FIRST notification, each of those also
    // created a topic, so the user saw a new forum topic per automated PR review.
    //
    // The mirror fires for a HEADLESS session because /mirror's real predicate is
    // "user-role message not found in injected_prompts", not "a human typed this".
    // lgtm launches via the opencode-launch CLI, so its launch prompt is a user
    // message the daemon never injected and therefore never suppressed.
    const LGTM_LAUNCH_PROMPT =
      "Read the file .lgtm-review-prompt.md in this directory and follow its instructions to review the PR.";

    function mirror(app: ReturnType<typeof createApp>, sessionId: string) {
      return app(
        new Request("http://localhost/mirror", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, messageId: "msg_1", text: LGTM_LAUNCH_PROMPT }),
        }),
      );
    }

    it("suppresses the mirror and enqueues nothing for a declared quiet session", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_lgtm", notify: true }, 1_000);
      storage!.sessionOrigins.record(
        {
          sessionId: "ses_lgtm",
          origin: "lgtm",
          notifyPolicy: "errors-only",
          source: "declared",
        },
        1_000,
      );

      const res = await mirror(app, "ses_lgtm");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mirrored: false, reason: "quiet_origin" });
      // The topic-creating side effect is the whole point: no row, no topic.
      expect(storage!.outbox.getReady().length).toBe(0);
    });

    it("still mirrors an identical prompt for a session with no origin row", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_human", notify: true }, 1_000);

      const res = await mirror(app, "ses_human");

      expect(await res.json()).toEqual({ mirrored: true });
      expect(storage!.outbox.getReady().length).toBe(1);
    });

    it("mirrors again once the declared quiet TTL has expired", async () => {
      const app = newApp(1_000);
      storage!.sessions.upsert({ sessionId: "ses_lgtm", notify: true }, 1_000);
      storage!.sessionOrigins.record(
        {
          sessionId: "ses_lgtm",
          origin: "lgtm",
          notifyPolicy: "errors-only",
          source: "declared",
        },
        1_000,
      );
      storage!.db.close();
      storage = null;

      // Same row, but read far enough in the future that the 2h TTL has lapsed.
      const later = 1_000 + DEFAULT_DECLARED_QUIET_TTL_MS + 1;
      storage = openStorageDb(":memory:");
      const app2 = createApp(storage, { nowFn: () => later });
      storage.sessions.upsert({ sessionId: "ses_lgtm", notify: true }, 1_000);
      storage.sessionOrigins.record(
        {
          sessionId: "ses_lgtm",
          origin: "lgtm",
          notifyPolicy: "errors-only",
          source: "declared",
        },
        1_000,
      );

      const res = await mirror(app2, "ses_lgtm");
      expect(await res.json()).toEqual({ mirrored: true });
    });
  });

  describe("clearing the unread watermark on a human-authored turn", () => {
    function post(app: ReturnType<typeof createApp>, sessionId: string, text: string) {
      return app(
        new Request("http://localhost/mirror", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, messageId: "msg_1", text }),
        }),
      );
    }

    it("clears the watermark when a human types in the TUI", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);
      storage!.sessionEvents.append({
        sessionId: "ses_1",
        notificationId: "n1",
        kind: "stop",
        sentAt: 1_000,
      });
      expect(storage!.sessionEvents.lastReadId("ses_1")).toBe(0);

      await post(app, "ses_1", "what about the retry path?");

      expect(storage!.sessionEvents.lastReadId("ses_1")).toBe(
        storage!.sessionEvents.maxEventIdForSession("ses_1"),
      );
    });

    it("does NOT clear when the turn was an injected prompt", async () => {
      // Placement guard: fails if markAllRead drifts ABOVE the early-return.
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);
      storage!.sessionEvents.append({
        sessionId: "ses_1",
        notificationId: "n1",
        kind: "stop",
        sentAt: 1_000,
      });
      const text = "injected by a peer";
      storage!.injectedPrompts.record("ses_1", hashPrompt(text), 1_000);

      await post(app, "ses_1", text);

      expect(storage!.sessionEvents.lastReadId("ses_1")).toBe(0);
    });

    it("neither clears nor mirrors an enveloped turn whose injected record expired", async () => {
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_1", notify: true }, 1_000);
      storage!.sessionEvents.append({
        sessionId: "ses_1",
        notificationId: "n1",
        kind: "stop",
        sentAt: 1_000,
      });
      // No injected_prompts row at all: the TTL-expiry / hash-miss case.
      const text = '<swarm_message from="ses_x" kind="chat">do the thing</swarm_message>';

      const res = await post(app, "ses_1", text);

      // Asserting BOTH pins the latent mirror-leak fix, not just the clearing.
      expect(await res.json()).toEqual({ mirrored: false });
      expect(storage!.sessionEvents.lastReadId("ses_1")).toBe(0);
    });

    it("clears for a quiet-origin session even though it does not mirror", async () => {
      // PLACEMENT GUARD. Fails if markAllRead drifts BELOW shouldEmitAncillaryFor.
      // Badge state and Telegram delivery policy are unrelated concerns.
      const app = newApp();
      storage!.sessions.upsert({ sessionId: "ses_lgtm", notify: true }, 1_000);
      storage!.sessionOrigins.record(
        {
          sessionId: "ses_lgtm",
          origin: "lgtm",
          notifyPolicy: "errors-only",
          source: "declared",
        },
        1_000,
      );
      storage!.sessionEvents.append({
        sessionId: "ses_lgtm",
        notificationId: "n1",
        kind: "stop",
        sentAt: 1_000,
      });

      const res = await post(app, "ses_lgtm", "hello");

      expect(await res.json()).toEqual({ mirrored: false, reason: "quiet_origin" });
      expect(storage!.sessionEvents.lastReadId("ses_lgtm")).toBeGreaterThan(0);
    });
  });
});

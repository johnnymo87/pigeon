import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";

describe("POST /goose/turn-event", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return createApp(storage, {
      nowFn: () => now,
      chatId: "chat-1",
      machineId: "devbox",
      ...opts,
    });
  }

  async function registerGoose(
    app: ReturnType<typeof createApp>,
    backendSessionId = "goose-sess-1",
    headers: Record<string, string> = {},
  ): Promise<string> {
    const res = await app(
      new Request("http://localhost/goose/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          session_id: backendSessionId,
          endpoint: "ws://127.0.0.1:1/acp",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session_id: string };
    return json.session_id;
  }

  function postTurnEvent(
    app: ReturnType<typeof createApp>,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return app(
      new Request("http://localhost/goose/turn-event", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it("unregistered goose id -> 200 ignored, no outbox rows", async () => {
    const app = newApp();
    const res = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "unregistered-goose-id",
      upstream_id: "hk3_7-12",
      prompt_text: "hello",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, ignored: "unregistered" });
    expect(storage!.outbox.getReady()).toHaveLength(0);

    // Non-goose session kind in storage should also be ignored
    storage!.sessions.upsert({ sessionId: "ses_opencode", backendKind: null }, 1_000);
    const res2 = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "ses_opencode",
      upstream_id: "hk3_7-12",
      prompt_text: "hello",
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2).toEqual({ ok: true, ignored: "unregistered" });
    expect(storage!.outbox.getReady()).toHaveLength(0);
  });

  it("turn.started -> one mirror row m:<gse>:h-<id> whose text contains the prompt; lastHumanMsgId set", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    const res = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-12",
      prompt_text: "Please fix the failing tests.",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ mirrored: true });

    const expectedNotificationId = `m:${gseId}:h-hk3_7-12`;
    const mirrorRow = storage!.outbox.getByNotificationId(expectedNotificationId);
    expect(mirrorRow).not.toBeNull();
    expect(mirrorRow!.kind).toBe("mirror");
    expect(mirrorRow!.sessionId).toBe(gseId);
    expect(mirrorRow!.anchorMsgId).toBe("h-hk3_7-12");

    const payload = JSON.parse(mirrorRow!.payload);
    expect(payload.messages[0].text).toContain("Please fix the failing tests.");

    const sessionRow = storage!.sessions.get(gseId);
    expect(sessionRow?.lastHumanMsgId).toBe("h-hk3_7-12");
  });

  it("turn.ended -> one stop row s:<gse>:h-<id>, payload text contains final; repeat with same body -> idempotent", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    const eventBody = {
      v: 1,
      type: "turn.ended",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-12",
      stop_reason: "end_turn",
      final_text: "Tests are now passing.",
    };

    const res = await postTurnEvent(app, eventBody);
    expect(res.status).toBe(202);
    const json = await res.json();
    const expectedNotificationId = `s:${gseId}:h-hk3_7-12`;
    expect(json).toEqual({
      ok: true,
      deliveryState: "queued",
      notificationId: expectedNotificationId,
    });

    const stopRow = storage!.outbox.getByNotificationId(expectedNotificationId);
    expect(stopRow).not.toBeNull();
    expect(stopRow!.kind).toBe("stop");
    expect(stopRow!.sessionId).toBe(gseId);

    const payload = JSON.parse(stopRow!.payload);
    expect(payload.messages[0].text).toContain("Tests are now passing.");

    // Repeat with the same body: idempotent, still only one outbox row
    const resRepeat = await postTurnEvent(app, eventBody);
    expect(resRepeat.status).toBe(202);
    const count = (
      storage!.db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE notification_id = ?")
        .get(expectedNotificationId) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("cancelled -> Stop with '(cancelled)'; upstream_restart -> Error", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    // Cancelled turn
    const resCancel = await postTurnEvent(app, {
      v: 1,
      type: "turn.ended",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-13",
      honk_reason: "cancelled",
      final_text: "I was working on it",
    });
    expect(resCancel.status).toBe(202);
    const cancelRow = storage!.outbox.getByNotificationId(`s:${gseId}:h-hk3_7-13`);
    expect(cancelRow).not.toBeNull();
    const cancelPayload = JSON.parse(cancelRow!.payload);
    expect(cancelPayload.messages[0].text).toContain("(cancelled)");

    // Upstream restart
    const resRestart = await postTurnEvent(app, {
      v: 1,
      type: "turn.ended",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-14",
      honk_reason: "upstream_restart",
      final_text: null,
    });
    expect(resRestart.status).toBe(202);
    const restartRow = storage!.outbox.getByNotificationId(`s:${gseId}:h-hk3_7-14`);
    expect(restartRow).not.toBeNull();
    const restartPayload = JSON.parse(restartRow!.payload);
    expect(restartPayload.messages[0].text).toContain("goose restarted and the turn was cancelled.");
  });

  it("own-turn skip via an in-flight row for the crid; and via an existing outbox row s:<gse>:<crid>; foreign crid not skipped", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    // 1. In-flight store skip
    storage!.gooseInflight.insert({
      commandId: "crid-pigeon-1",
      sessionId: gseId,
      backendSessionId: "goose-sess-1",
      isHonk: true,
      promptText: "cmd 1",
    });

    const resInflight = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-15",
      client_req_ids: ["crid-pigeon-1"],
      prompt_text: "cmd 1",
    });
    expect(resInflight.status).toBe(200);
    const jsonInflight = await resInflight.json();
    expect(jsonInflight).toEqual({ ok: true, ignored: "own_turn" });
    expect(storage!.outbox.getByNotificationId(`m:${gseId}:h-hk3_7-15`)).toBeNull();

    // 2. Outbox row skip: existing outbox row for crid
    storage!.outbox.upsert(
      {
        notificationId: `s:${gseId}:crid-pigeon-2`,
        sessionId: gseId,
        requestId: "req-crid-2",
        kind: "stop",
        payload: JSON.stringify({ messages: [{ text: "Done" }] }),
        token: "",
      },
      1_000,
    );

    const resOutbox = await postTurnEvent(app, {
      v: 1,
      type: "turn.ended",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-16",
      client_req_ids: ["crid-pigeon-2"],
      stop_reason: "end_turn",
      final_text: "Done",
    });
    expect(resOutbox.status).toBe(200);
    const jsonOutbox = await resOutbox.json();
    expect(jsonOutbox).toEqual({ ok: true, ignored: "own_turn" });
    expect(storage!.outbox.getByNotificationId(`s:${gseId}:h-hk3_7-16`)).toBeNull();

    // 3. Foreign crid: neither in-flight nor outbox row exists -> NOT skipped
    const resForeign = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-17",
      client_req_ids: ["foreign-client-crid"],
      prompt_text: "hello foreign turn",
    });
    expect(resForeign.status).toBe(200);
    const jsonForeign = await resForeign.json();
    expect(jsonForeign).toEqual({ mirrored: true });
    expect(storage!.outbox.getByNotificationId(`m:${gseId}:h-hk3_7-17`)).not.toBeNull();
  });

  it("validates request payload (400)", async () => {
    const app = newApp();

    // Malformed JSON (syntax error)
    const resMalformed = await app(
      new Request("http://localhost/goose/turn-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      }),
    );
    expect(resMalformed.status).toBe(400);
    expect(await resMalformed.json()).toEqual({ error: "invalid JSON body" });

    // Null body
    const resNull = await postTurnEvent(app, null);
    expect(resNull.status).toBe(400);
    expect(await resNull.json()).toEqual({ error: "body must be an object" });

    // Array body
    const resArray = await postTurnEvent(app, [1, 2]);
    expect(resArray.status).toBe(400);
    expect(await resArray.json()).toEqual({ error: "body must be an object" });

    // Missing/invalid v
    const resBadV = await postTurnEvent(app, {
      v: 2,
      type: "turn.started",
      session_id: "goose-1",
      upstream_id: "hk3_1",
    });
    expect(resBadV.status).toBe(400);

    // Invalid type
    const resBadType = await postTurnEvent(app, {
      v: 1,
      type: "turn.unknown",
      session_id: "goose-1",
      upstream_id: "hk3_1",
    });
    expect(resBadType.status).toBe(400);

    // Missing session_id
    const resMissingSession = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      upstream_id: "hk3_1",
    });
    expect(resMissingSession.status).toBe(400);

    // Empty session_id
    const resEmptySession = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "",
      upstream_id: "hk3_1",
    });
    expect(resEmptySession.status).toBe(400);

    // Missing upstream_id
    const resMissingUpstream = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-1",
    });
    expect(resMissingUpstream.status).toBe(400);

    // Empty upstream_id
    const resEmptyUpstream = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-1",
      upstream_id: "",
    });
    expect(resEmptyUpstream.status).toBe(400);
  });

  it("non-array client_req_ids and non-string elements are tolerated", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    // Non-array client_req_ids (e.g. string, number, null) is tolerated
    const resNonArray = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-nonarray",
      client_req_ids: "not-an-array",
      prompt_text: "hello non-array",
    });
    expect(resNonArray.status).toBe(200);
    expect(await resNonArray.json()).toEqual({ mirrored: true });

    // Non-string elements in client_req_ids are tolerated
    const resNonString = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-nonstring",
      client_req_ids: [123, null, {}, "crid-foreign"],
      prompt_text: "hello non-string",
    });
    expect(resNonString.status).toBe(200);
    expect(await resNonString.json()).toEqual({ mirrored: true });
  });

  it("whitespace-only prompt_text -> not mirrored", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    const res = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-ws",
      prompt_text: "   \n\t  ",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ mirrored: false });
    expect(storage!.outbox.getByNotificationId(`m:${gseId}:h-hk3_7-ws`)).toBeNull();
  });

  it("duplicate turn.started -> one mirror row", async () => {
    const app = newApp();
    const gseId = await registerGoose(app, "goose-sess-1");

    const body = {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-dup",
      prompt_text: "duplicate prompt",
    };

    const res1 = await postTurnEvent(app, body);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ mirrored: true });

    const res2 = await postTurnEvent(app, body);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ mirrored: true });

    const count = (
      storage!.db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE notification_id = ?")
        .get(`m:${gseId}:h-hk3_7-dup`) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("auth: with authToken set, no bearer -> 401; with bearer -> ok", async () => {
    const app = newApp(1_000, { authToken: "secret-token" });
    const gseId = await registerGoose(app, "goose-sess-1", {
      authorization: "Bearer secret-token",
    });

    // No bearer
    const resNoAuth = await postTurnEvent(app, {
      v: 1,
      type: "turn.started",
      session_id: "goose-sess-1",
      upstream_id: "hk3_7-12",
      prompt_text: "hello",
    });
    expect(resNoAuth.status).toBe(401);

    // With bearer
    const resAuth = await postTurnEvent(
      app,
      {
        v: 1,
        type: "turn.started",
        session_id: "goose-sess-1",
        upstream_id: "hk3_7-12",
        prompt_text: "hello",
      },
      { authorization: "Bearer secret-token" },
    );
    expect(resAuth.status).toBe(200);
  });
});

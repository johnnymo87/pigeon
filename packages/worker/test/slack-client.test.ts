/**
 * Slack API client (bead pigeon-4ogz.3, task 1): the wire format, the timing log, and the
 * mapping of Slack's errors onto the Telegram-shaped ChatResult. The table under test is
 * "Result mapping" in docs/plans/2026-11-20-slack-outbound-plan.md, plus delta 4.
 */
import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callSlack, errorClassOf, slackArchiveUrl, slackErrorClass, uploadToSlack } from "../src/slack";
import { failureDetails, isPermanentTopicFailure } from "../src/chat/failures";

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  fetchMock.deactivate();
});

function slack(method: string) {
  return fetchMock.get("https://slack.com").intercept({ method: "POST", path: `/api/${method}` });
}

describe("callSlack wire format", () => {
  it("POSTs form-encoded with a bearer token, JSON-stringifying objects and arrays", async () => {
    let seen: { body?: unknown; headers?: unknown } = {};
    slack("chat.postMessage").reply(200, (opts: { body?: unknown; headers?: unknown }) => {
      seen = opts;
      return { ok: true, ts: "1.2", channel: "C1" };
    });
    const res = await callSlack("xoxb-secret", "chat.postMessage", {
      channel: "C1",
      text: "hi & bye",
      blocks: [{ type: "section" }],
      meta: { a: 1 },
      unfurl_links: false,
      skipped: undefined,
      nothing: null,
    });
    expect(res).toEqual({ ok: true, result: { ok: true, ts: "1.2", channel: "C1" } });
    const params = new URLSearchParams(String(seen.body));
    expect(params.get("channel")).toBe("C1");
    expect(params.get("text")).toBe("hi & bye");
    expect(params.get("blocks")).toBe('[{"type":"section"}]');
    expect(params.get("meta")).toBe('{"a":1}');
    expect(params.get("unfurl_links")).toBe("false");
    expect(params.has("skipped")).toBe(false);
    expect(params.has("nothing")).toBe(false);
    const headers = Object.fromEntries(
      Object.entries(seen.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers.authorization).toBe("Bearer xoxb-secret");
    expect(headers["content-type"]).toContain("application/x-www-form-urlencoded");
  });

  it("uses an injected fetch instead of the global one, and passes the signal", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ac = new AbortController();
    const res = await callSlack(
      "tok",
      "auth.test",
      {},
      {
        signal: ac.signal,
        fetchFn: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          return Response.json({ ok: true, user_id: "U1" });
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://slack.com/api/auth.test");
    expect(calls[0]!.init.signal).toBe(ac.signal);
  });

  it("lets a thrown fetch propagate", async () => {
    await expect(
      callSlack("tok", "auth.test", {}, { fetchFn: async () => { throw new Error("boom"); } }),
    ).rejects.toThrow("boom");
  });
});

describe("callSlack logging", () => {
  it("logs method, elapsed and outcome, never the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    slack("auth.test").reply(200, { ok: true });
    await callSlack("xoxb-very-secret", "auth.test", {});
    const line = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(line).toContain("[worker] slack call");
    expect(line).toContain("auth.test");
    expect(line).toContain('"outcome":"ok"');
    expect(line).not.toContain("xoxb-very-secret");
  });

  it("logs a failure's kind as its outcome", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    slack("chat.postMessage").reply(200, { ok: false, error: "channel_not_found" });
    await callSlack("t", "chat.postMessage", {});
    const line = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(line).toContain('"outcome":"thread_not_found"');
  });

  it("warns instead of logging at 5 s or more, and times a throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(7_000);
    await expect(
      callSlack("t", "auth.test", {}, { fetchFn: async () => { throw new Error("stall"); } }),
    ).rejects.toThrow("stall");
    now.mockRestore();
    const line = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(line).toContain("[worker] slow slack call");
    expect(line).toContain('"outcome":"threw"');
    expect(line).toContain('"elapsedMs":6000');
  });
});

describe("callSlack result mapping", () => {
  async function failure(method: string, status: number, body: unknown, headers?: Record<string, string>) {
    slack(method).reply(status, body as never, headers ? { headers } : undefined);
    return callSlack("t", method, {});
  }

  it.each(["channel_not_found", "is_archived"])("%s → thread_not_found / conversation_gone", async (error) => {
    const res = await failure("chat.postMessage", 200, { ok: false, error });
    expect(res).toMatchObject({
      ok: false,
      kind: "thread_not_found",
      response: {
        ok: false,
        error,
        errorClass: "conversation_gone",
        error_code: 400,
        description: `thread not found: ${error}`,
      },
    });
    expect(isPermanentTopicFailure(res)).toBe(true);
  });

  it.each([
    "invalid_blocks",
    "invalid_blocks_format",
    "msg_too_long",
    "msg_blocks_too_long",
    "invalid_attachments",
    "no_text",
    "too_many_attachments",
    "markdown_text_conflict",
  ])("%s → error 400 rejected_format", async (error) => {
    const res = await failure("chat.postMessage", 200, { ok: false, error });
    expect(res).toMatchObject({
      ok: false,
      kind: "error",
      errorCode: 400,
      response: { ok: false, error, errorClass: "rejected_format", error_code: 400 },
    });
    expect(isPermanentTopicFailure(res)).toBe(true);
  });

  it.each([
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "missing_scope",
    "fatal_error",
    "internal_error",
    "service_unavailable",
    "request_timeout",
    "some_error_we_never_heard_of",
  ])("%s → error 502 upstream (transient)", async (error) => {
    const res = await failure("chat.postMessage", 200, { ok: false, error });
    expect(res).toMatchObject({
      ok: false,
      kind: "error",
      errorCode: 502,
      response: { ok: false, error, errorClass: "upstream", error_code: 502 },
    });
    expect(isPermanentTopicFailure(res)).toBe(false);
  });

  it("any HTTP 5xx is upstream, with or without a parseable body", async () => {
    const withBody = await failure("chat.postMessage", 503, { ok: false, error: "service_unavailable" });
    expect(withBody).toMatchObject({ ok: false, kind: "error", errorCode: 502 });
    const noBody = await failure("chat.update", 500, "<html>oops</html>");
    expect(noBody).toMatchObject({
      ok: false,
      kind: "error",
      errorCode: 502,
      response: { ok: false, errorClass: "upstream", error_code: 502 },
    });
  });

  it("an unparseable 200 is upstream, never ok", async () => {
    const res = await failure("chat.postMessage", 200, "not json at all");
    expect(res).toMatchObject({ ok: false, kind: "error", errorCode: 502, response: { errorClass: "upstream" } });
  });

  it("a 200 with ok:true but no body object is not ok either", async () => {
    const res = await failure("chat.postMessage", 200, "null");
    expect(res.ok).toBe(false);
  });

  it("an unlisted 4xx is upstream", async () => {
    const res = await failure("chat.postMessage", 403, { ok: false, error: "forbidden_thing" });
    expect(res).toMatchObject({ ok: false, kind: "error", errorCode: 502, response: { errorClass: "upstream" } });
  });

  it("HTTP 429 is rate_limited with Retry-After seconds", async () => {
    const res = await failure("chat.postMessage", 429, { ok: false, error: "ratelimited" }, { "retry-after": "7" });
    expect(res).toMatchObject({
      ok: false,
      kind: "rate_limited",
      retryAfter: 7,
      response: { ok: false, error: "ratelimited", errorClass: "rate_limited", error_code: 429 },
    });
  });

  it("a 429 with no or garbage Retry-After defaults to 1 second", async () => {
    const none = await failure("chat.update", 429, { ok: false, error: "ratelimited" });
    expect(none).toMatchObject({ kind: "rate_limited", retryAfter: 1 });
    const junk = await failure("chat.update", 429, { ok: false, error: "ratelimited" }, { "retry-after": "soon" });
    expect(junk).toMatchObject({ kind: "rate_limited", retryAfter: 1 });
    const zero = await failure("chat.update", 429, { ok: false, error: "ratelimited" }, { "retry-after": "0" });
    expect(zero).toMatchObject({ kind: "rate_limited", retryAfter: 1 });
  });

  it("a 200 body saying ratelimited is rate_limited too", async () => {
    const res = await failure("chat.postMessage", 200, { ok: false, error: "ratelimited" });
    expect(res).toMatchObject({ ok: false, kind: "rate_limited", retryAfter: 1 });
  });

  it.each(["conversations.create", "conversations.rename", "conversations.unarchive"])(
    "429 on %s is a transient topic failure: error 503 upstream, never rate_limited",
    async (method) => {
      const res = await failure(method, 429, { ok: false, error: "ratelimited" }, { "retry-after": "30" });
      expect(res).toMatchObject({
        ok: false,
        kind: "error",
        errorCode: 503,
        response: { ok: false, error: "ratelimited", errorClass: "upstream", error_code: 503 },
      });
      expect(isPermanentTopicFailure(res)).toBe(false);
    },
  );

  it("rateLimitIsTransient overrides the method set in both directions", async () => {
    slack("chat.postMessage").reply(429, { ok: false, error: "ratelimited" });
    const forced = await callSlack("t", "chat.postMessage", {}, { rateLimitIsTransient: true });
    expect(forced).toMatchObject({ kind: "error", errorCode: 503 });
    slack("conversations.create").reply(429, { ok: false, error: "ratelimited" });
    const off = await callSlack("t", "conversations.create", {}, { rateLimitIsTransient: false });
    expect(off).toMatchObject({ kind: "rate_limited" });
  });

  it("feeds failureDetails the Slack body, so legacy daemons read error_code", async () => {
    const res = await failure("chat.postMessage", 200, { ok: false, error: "msg_too_long" });
    const details = failureDetails(res) as { error_code: number; error: string };
    expect(details.error_code).toBe(400);
    expect(details.error).toBe("msg_too_long");
    expect(errorClassOf(details)).toBe("rejected_format");
    expect(slackErrorClass(res)).toBe("rejected_format");
  });

  it("keeps the parsed Slack body on success (callers read ts, channel, ids)", async () => {
    slack("conversations.create").reply(200, { ok: true, channel: { id: "C9", name: "x" } });
    const res = await callSlack<{ channel: { id: string } }>("t", "conversations.create", { name: "x" });
    expect(res).toEqual({ ok: true, result: { ok: true, channel: { id: "C9", name: "x" } } });
  });

  it("surfaces the benign answers as plain errors for the transport to map", async () => {
    const res = await failure("conversations.create", 200, { ok: false, error: "name_taken" });
    expect(res).toMatchObject({ ok: false, kind: "error", response: { error: "name_taken" } });
  });
});

describe("helpers", () => {
  it("errorClassOf reads only a string errorClass off an object", () => {
    expect(errorClassOf({ errorClass: "upstream" })).toBe("upstream");
    expect(errorClassOf({ errorClass: 5 })).toBeUndefined();
    expect(errorClassOf({})).toBeUndefined();
    expect(errorClassOf(null)).toBeUndefined();
    expect(errorClassOf("x")).toBeUndefined();
    expect(errorClassOf(undefined)).toBeUndefined();
  });

  it("slackErrorClass is undefined for a success and for a Telegram-shaped failure", () => {
    expect(slackErrorClass({ ok: true, result: 1 })).toBeUndefined();
    expect(slackErrorClass({ ok: false, kind: "error", errorCode: 400, response: { error_code: 400 } })).toBeUndefined();
    expect(slackErrorClass({ ok: false, kind: "error" })).toBeUndefined();
  });

  it("slackArchiveUrl builds the workspace permalink", () => {
    expect(slackArchiveUrl("acme", "C0123")).toBe("https://acme.slack.com/archives/C0123");
  });
});

describe("uploadToSlack", () => {
  it("POSTs the bytes to the upload url and reports ok", async () => {
    let seen: { body?: unknown; method?: string } = {};
    fetchMock
      .get("https://files.example-upload.test")
      .intercept({ method: "POST", path: "/upload/v1/ABC" })
      .reply(200, (opts: { body?: unknown; method?: string }) => {
        seen = opts;
        return "OK - 5";
      });
    const res = await uploadToSlack("https://files.example-upload.test/upload/v1/ABC", new Blob(["hello"]));
    expect(res).toEqual({ ok: true, result: true });
    expect(seen.method).toBe("POST");
  });

  it("maps a 5xx to upstream and a 429 to rate_limited, and logs no url", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.get("https://files.example-upload.test").intercept({ method: "POST", path: "/up/secret-token" }).reply(500, "bad");
    const bad = await uploadToSlack("https://files.example-upload.test/up/secret-token", new Blob(["x"]));
    expect(bad).toMatchObject({ ok: false, kind: "error", errorCode: 502, response: { errorClass: "upstream" } });
    fetchMock
      .get("https://files.example-upload.test")
      .intercept({ method: "POST", path: "/up/secret-token" })
      .reply(429, "slow", { headers: { "retry-after": "4" } });
    const slow = await uploadToSlack("https://files.example-upload.test/up/secret-token", new Blob(["x"]));
    expect(slow).toMatchObject({ ok: false, kind: "rate_limited", retryAfter: 4 });
    const line = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(line).toContain("upload");
    expect(line).not.toContain("secret-token");
  });

  it("lets a thrown fetch propagate and honours an injected fetch", async () => {
    await expect(
      uploadToSlack("https://u.test/x", new Blob(["x"]), { fetchFn: async () => { throw new Error("net"); } }),
    ).rejects.toThrow("net");
    const ok = await uploadToSlack("https://u.test/x", new Blob(["x"]), { fetchFn: async () => new Response("OK") });
    expect(ok.ok).toBe(true);
  });
});

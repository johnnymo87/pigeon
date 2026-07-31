import { describe, expect, it } from "vitest";
import {
  classifyDeliveryFailure,
  type DeliveryAction,
  type DeliveryPolicyContext,
} from "../src/worker/delivery-policy";
import type { WorkerResult } from "../src/worker/poller";

describe("classifyDeliveryFailure", () => {
  const defaultCtx: DeliveryPolicyContext = {
    hasLocalSession: true,
    alreadyReregistered: false,
    payloadHasEntities: false,
    attempts: 0,
  };

  type TestCase = {
    name: string;
    result: WorkerResult;
    ctx?: Partial<DeliveryPolicyContext>;
    expected: DeliveryAction;
  };

  const testCases: TestCase[] = [
    // --- Rule 1: transport_error ---
    {
      name: "transport_error returns retry",
      result: { ok: false, kind: "transport_error", error: "fetch failed" },
      expected: { action: "retry" },
    },

    // --- Rule 2: 404 ---
    {
      name: "404 + hasLocalSession + !alreadyReregistered returns reregister",
      result: { ok: false, kind: "http_error", status: 404, body: { error: "Session not found" } },
      ctx: { hasLocalSession: true, alreadyReregistered: false },
      expected: { action: "reregister" },
    },
    {
      name: "404 + hasLocalSession + alreadyReregistered returns terminal",
      result: { ok: false, kind: "http_error", status: 404, body: { error: "Session not found" } },
      ctx: { hasLocalSession: true, alreadyReregistered: true },
      expected: { action: "terminal", reason: "Re-registration already attempted for this outbox entry" },
    },
    {
      name: "404 + !hasLocalSession returns terminal (reaper case)",
      result: { ok: false, kind: "http_error", status: 404, body: { error: "Session not found" } },
      ctx: { hasLocalSession: false, alreadyReregistered: false },
      expected: { action: "terminal", reason: "Session not locally known (reaped or never existed)" },
    },

    // --- Rule 3: 403 ---
    {
      name: "403 at attempts 0 returns retry",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" } },
      ctx: { attempts: 0 },
      expected: { action: "retry" },
    },
    {
      name: "403 at attempts 1 returns retry",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" } },
      ctx: { attempts: 1 },
      expected: { action: "retry" },
    },
    {
      name: "403 at attempts 2 returns retry (403 is never terminal)",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" } },
      ctx: { attempts: 2 },
      expected: { action: "retry" },
    },
    {
      name: "403 at attempts 3 returns retry (403 is never terminal)",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" } },
      ctx: { attempts: 3 },
      expected: { action: "retry" },
    },
    {
      // Regression guard for the mixed-cause defect found by adversarial review.
      // ctx.attempts counts failures of EVERY kind, so an entry that accrued unrelated
      // transport failures used to hit its FIRST 403 already "over budget" and die instantly:
      // two individually-recoverable transients combining into permanent loss.
      name: "403 at high attempts from UNRELATED earlier failures still returns retry",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Chat ID not allowed" } },
      ctx: { attempts: 9 },
      expected: { action: "retry" },
    },

    // --- Rule 4: 400 ---
    {
      name: "400 returns terminal",
      result: { ok: false, kind: "http_error", status: 400, body: { error: "sessionId, chatId, and text required" } },
      expected: { action: "terminal", reason: "Worker field validation failed (HTTP 400)" },
    },

    // --- Rule 5: positive finite retryAfter ---
    {
      name: "429 with retryAfter returns pause",
      result: { ok: false, kind: "http_error", status: 429, body: { error: "rate_limited" }, retryAfter: 15 },
      expected: { action: "pause", retryAfterSec: 15 },
    },
    {
      name: "500 with retryAfter returns pause",
      result: { ok: false, kind: "http_error", status: 500, body: { error: "internal error" }, retryAfter: 30 },
      expected: { action: "pause", retryAfterSec: 30 },
    },
    {
      name: "app_rejection with retryAfter returns pause",
      result: { ok: false, kind: "app_rejection", status: 200, body: { error: "busy" }, retryAfter: 5 },
      expected: { action: "pause", retryAfterSec: 5 },
    },

    // --- Rule 6: 502 + details.error_code 400 + entities ---
    {
      name: "502 with details.error_code 400 AND payloadHasEntities returns strip_entities",
      result: {
        ok: false,
        kind: "http_error",
        status: 502,
        body: { error: "Telegram API error", details: { error_code: 400, description: "Bad Request: can't parse entities" } },
      },
      ctx: { payloadHasEntities: true },
      expected: { action: "strip_entities" },
    },
    {
      name: "502 with details.error_code 400 but NO entities returns retry",
      result: {
        ok: false,
        kind: "http_error",
        status: 502,
        body: { error: "Telegram API error", details: { error_code: 400, description: "Bad Request: bad formatting" } },
      },
      ctx: { payloadHasEntities: false },
      expected: { action: "retry" },
    },
    {
      name: "502 with details.error_code 403 returns retry",
      result: {
        ok: false,
        kind: "http_error",
        status: 502,
        body: { error: "Telegram API error", details: { error_code: 403, description: "Forbidden: bot blocked by user" } },
      },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with missing details returns retry",
      result: { ok: false, kind: "http_error", status: 502, body: { error: "Telegram API error" } },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },

    // --- Rule 7: default fallback ---
    {
      name: "500 without retryAfter returns retry",
      result: { ok: false, kind: "http_error", status: 500, body: { error: "Internal Server Error" } },
      expected: { action: "retry" },
    },
    {
      name: "503 without retryAfter returns retry",
      result: { ok: false, kind: "http_error", status: 503, body: { error: "Service Unavailable" } },
      expected: { action: "retry" },
    },
    {
      name: "app_rejection without retryAfter returns retry",
      result: { ok: false, kind: "app_rejection", status: 200, body: { error: "Rejected" } },
      expected: { action: "retry" },
    },

    // --- Defensive handling of malformed bodies (never throws, falls through) ---
    {
      name: "502 with undefined body returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: undefined },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with string body returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: "Bad Gateway" },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with object body missing details returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: { status: "error" } },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with non-object details returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: { details: "string details" } },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with non-numeric error_code in details returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: { details: { error_code: "400" } } },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },
    {
      name: "502 with null details returns retry without throwing",
      result: { ok: false, kind: "http_error", status: 502, body: { details: null } },
      ctx: { payloadHasEntities: true },
      expected: { action: "retry" },
    },

    // --- Precedence Checks ---
    {
      name: "PRECEDENCE: 404 with retryAfter takes 404 arm (reregister), NOT pause",
      result: { ok: false, kind: "http_error", status: 404, body: { error: "Not found" }, retryAfter: 30 },
      ctx: { hasLocalSession: true, alreadyReregistered: false },
      expected: { action: "reregister" },
    },
    {
      name: "PRECEDENCE: 404 with retryAfter + alreadyReregistered takes 404 arm (terminal), NOT pause",
      result: { ok: false, kind: "http_error", status: 404, body: { error: "Not found" }, retryAfter: 30 },
      ctx: { hasLocalSession: true, alreadyReregistered: true },
      expected: { action: "terminal", reason: "Re-registration already attempted for this outbox entry" },
    },
    {
      name: "PRECEDENCE: 403 at attempts 0 with retryAfter takes Rule 3 (retry), NOT pause",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" }, retryAfter: 30 },
      ctx: { attempts: 0 },
      expected: { action: "retry" },
    },
    {
      name: "PRECEDENCE: 403 at attempts 2 with retryAfter takes Rule 3 (retry), NOT pause",
      result: { ok: false, kind: "http_error", status: 403, body: { error: "Forbidden" }, retryAfter: 30 },
      ctx: { attempts: 2 },
      expected: { action: "retry" },
    },
    {
      name: "PRECEDENCE: 400 with retryAfter takes Rule 4 (terminal), NOT pause",
      result: { ok: false, kind: "http_error", status: 400, body: { error: "Bad input" }, retryAfter: 30 },
      expected: { action: "terminal", reason: "Worker field validation failed (HTTP 400)" },
    },

    // --- Defensive handling of ok: true ---
    {
      name: "ok: true result passed defensively returns retry",
      result: { ok: true, kind: "success", status: 200, body: { ok: true } },
      expected: { action: "retry" },
    },
  ];

  it.each(testCases)("$name", ({ result, ctx, expected }) => {
    const fullCtx: DeliveryPolicyContext = { ...defaultCtx, ...ctx };
    const action = classifyDeliveryFailure(result, fullCtx);
    expect(action).toEqual(expected);
  });
});

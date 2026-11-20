/**
 * Verifying that an inbound request really came from Slack (bead pigeon-4ogz.4; spec §5).
 *
 * Slack signs every Events API, slash command and interactivity request with the app's signing
 * secret: `X-Slack-Signature: v0=<hex HMAC-SHA256(secret, "v0:<timestamp>:<raw body>")>` and
 * `X-Slack-Request-Timestamp: <unix seconds>`. The check runs on the RAW body, before anything
 * parses it, and with the secret of the workspace the request PATH names, so one workspace's
 * secret can never vouch for a request addressed to another machine.
 *
 * The timestamp must be within five minutes of now, which bounds how long a captured request can
 * be replayed (event dedup covers retries inside that window).
 */

/** How far the signed timestamp may be from now, either way. Slack's recommendation. */
export const SLACK_SIGNATURE_MAX_SKEW_S = 5 * 60;

export type SlackSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" };

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality (length is not secret: both are `v0=` + 64 hex digits). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `v0=` signature Slack would send for this body at this timestamp. Exported for tests. */
export async function slackSignature(signingSecret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  return `v0=${hex(mac)}`;
}

export async function verifySlackSignature(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowMs: number = Date.now(),
): Promise<SlackSignatureCheck> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "missing" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_S) return { ok: false, reason: "stale" };
  const expected = await slackSignature(signingSecret, timestamp, rawBody);
  return timingSafeEqual(signature, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

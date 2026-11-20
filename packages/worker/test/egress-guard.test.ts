/**
 * Egress guard (chat-transport phase 1, bead pigeon-lenr.1): the worker reaches Telegram from
 * exactly one file, `src/telegram.ts`. That is the seam a future provider swap replaces, and
 * it only stays a seam if nothing grows a second door. A new direct call belongs in the client,
 * as a method, so it is timed and bounded like the rest.
 */
import { describe, test, expect } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("telegram egress guard", () => {
  test("the glob actually sees the sources (a rotted pattern must not pass vacuously)", () => {
    expect(Object.keys(sources)).toContain("../src/telegram.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  test("api.telegram.org appears only in src/telegram.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => path !== "../src/telegram.ts" && text.includes("api.telegram.org"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

// ─── TelegramClient.downloadFile: the inbound media fetch, now through the client ───

import { fetchMock } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";
import { createTelegramClient } from "../src/telegram";

describe("TelegramClient.downloadFile", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    fetchMock.get("https://api.telegram.org").cleanMocks();
    fetchMock.deactivate();
  });

  test("fetches the file path under /file/bot<token>/ and returns the raw response", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "GET", path: "/file/bottok123/photos/file_7.jpg" })
      .reply(200, "JPEGBYTES");
    const res = await createTelegramClient("tok123").downloadFile("photos/file_7.jpg");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("JPEGBYTES");
  });

  test("a non-2xx is returned, not thrown, so the caller can report it", async () => {
    fetchMock.get("https://api.telegram.org").intercept({ method: "GET", path: /\/file\/bot.*/ }).reply(404, "nope");
    const res = await createTelegramClient("tok123").downloadFile("x/y.bin");
    expect(res.status).toBe(404);
  });
});

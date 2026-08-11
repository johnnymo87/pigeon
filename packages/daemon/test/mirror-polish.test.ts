import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPrompt } from "../src/hash-prompt";
import { splitTelegramMessage } from "../src/split-message";
import { TgMessageBuilder } from "../src/telegram-message";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("pigeon-pre9 mirror polish", () => {
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

  async function postMirror(
    app: ReturnType<typeof createApp>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app(
      new Request("http://localhost/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  /**
   * pre9 item 2 — an empty footer still contributes its "\n\n" separator, so every mirror ends
   * in a trailing blank line. Telegram trims it on display, which is why this is cosmetic and
   * was deferred; the separator is nonetheless wrong, and it also over-counts the chunk-budget
   * overhead by two characters.
   */
  describe("item 2 — an empty footer contributes no separator", () => {
    it("omits the trailing separator at the split-message level", () => {
      const header = new TgMessageBuilder().append("🧑 Session").build();
      const body = new TgMessageBuilder().append("hello world").build();
      const footer = new TgMessageBuilder().build();

      const chunks = splitTelegramMessage(header, body, footer);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toBe("🧑 Session\n\nhello world");
      expect(chunks[0]!.text.endsWith("\n")).toBe(false);
    });

    it("still separates a non-empty footer", () => {
      const header = new TgMessageBuilder().append("head").build();
      const body = new TgMessageBuilder().append("body").build();
      const footer = new TgMessageBuilder().append("foot").build();

      const chunks = splitTelegramMessage(header, body, footer);

      expect(chunks[0]!.text).toBe("head\n\nbody\n\nfoot");
    });

    /**
     * Removing the phantom separator exposed a latent hole. A body that ends in an unpaired
     * high surrogate and fits in one chunk used to be sanitised only by accident: the empty
     * footer's "\n\n" pushed it over maxLen, and the length clamp walked the surrogate off. With
     * the separator correctly gone, nothing trimmed it. The clamp now runs unconditionally.
     */
    it("strips a trailing unpaired high surrogate even when the chunk is under maxLen", () => {
      const empty = new TgMessageBuilder().build();
      const body = new TgMessageBuilder().append("abc\uD83D").build();

      const chunks = splitTelegramMessage(empty, body, empty, 4096);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toBe("abc");
    });

    it("applies the conditional separator to every chunk of a multi-chunk body", () => {
      const header = new TgMessageBuilder().append("🧑 Session").build();
      const body = new TgMessageBuilder().append("x".repeat(9_000)).build();
      const footer = new TgMessageBuilder().build();

      const chunks = splitTelegramMessage(header, body, footer);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
        expect(chunk.text.startsWith("🧑 Session\n\n")).toBe(true);
        expect(chunk.text.endsWith("\n")).toBe(false);
      }
    });

    it("keeps chunks within maxLen when truncation runs against an empty counterpart", () => {
      const longHeader = new TgMessageBuilder().append("H".repeat(300)).build();
      const body = new TgMessageBuilder().append("b".repeat(500)).build();
      const empty = new TgMessageBuilder().build();

      // Header truncation, empty footer.
      for (const chunk of splitTelegramMessage(longHeader, body, empty, 260)) {
        expect(chunk.text.length).toBeLessThanOrEqual(260);
        expect(chunk.text.endsWith("\n")).toBe(false);
      }

      // Footer truncation, empty header.
      const longFooter = new TgMessageBuilder().append("F".repeat(300)).build();
      for (const chunk of splitTelegramMessage(empty, body, longFooter, 260)) {
        expect(chunk.text.length).toBeLessThanOrEqual(260);
        expect(chunk.text.startsWith("\n")).toBe(false);
      }
    });

    it("omits the trailing separator on a real mirror payload", async () => {
      const app = newApp();
      storage!.sessions.upsert(
        { sessionId: "ses_fmt", title: "Fmt Session", cwd: "/home/dev/projects/pigeon" } as never,
        1_000,
      );

      const res = await postMirror(app, {
        sessionId: "ses_fmt",
        messageId: "msg_fmt",
        text: "no trailing blank line please",
      });
      expect(res.status).toBe(200);

      const ready = storage!.outbox.getReady();
      expect(ready).toHaveLength(1);
      const payload = JSON.parse(ready[0]!.payload) as { messages: Array<{ text: string }> };
      const text = payload.messages[0]!.text;

      expect(text).toContain("no trailing blank line please");
      expect(text.endsWith("\n")).toBe(false);
      expect(text.endsWith("\n\n")).toBe(false);
    });
  });

  /**
   * pre9 item 3 — whitespace-only text returned before injectedPrompts.consume, so an injected
   * whitespace-only prompt never had its count consumed.
   *
   * RATIONALE CORRECTED after adversarial review. The bead, the roadmap and the first version of
   * this fix all claimed the leaked count "suppresses a later identical prompt for 15 minutes".
   * It cannot: hashPrompt is a raw sha256 with no normalisation, so anything hashing to the same
   * value is also whitespace-only and is dropped by !text.trim() whatever the count says. The
   * count is unobservable. This is hygiene — the row is freed at echo time rather than at the TTL
   * sweep, and "consumed exactly once" stops being conditional on the shape of the text.
   */
  describe("item 3 — a whitespace-only injected prompt does not leak its count", () => {
    it("consumes the recorded count even though nothing is mirrored", async () => {
      const app = newApp();
      const text = "   \n\t ";
      const hash = hashPrompt(text);

      storage!.injectedPrompts.record("ses_ws", hash, 1_000);
      expect(storage!.injectedPrompts.has("ses_ws", hash, 1_000)).toBe(true);

      const res = await postMirror(app, { sessionId: "ses_ws", messageId: "msg_ws", text });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mirrored: false });

      // The count must be gone: leaving it suppresses a later identical prompt for 15 minutes.
      expect(storage!.injectedPrompts.has("ses_ws", hash, 1_000)).toBe(false);
      expect(storage!.outbox.getReady()).toHaveLength(0);
    });

    /**
     * Positive control: consuming must not become unconditional. A whitespace-only prompt that
     * was never injected has no count to consume and must not disturb any other entry.
     */
    it("leaves an unrelated recorded prompt untouched", async () => {
      const app = newApp();
      const otherHash = hashPrompt("a real injected prompt");
      storage!.injectedPrompts.record("ses_ws", otherHash, 1_000);

      await postMirror(app, { sessionId: "ses_ws", messageId: "msg_ws", text: "   " });

      expect(storage!.injectedPrompts.has("ses_ws", otherHash, 1_000)).toBe(true);
    });
  });
});

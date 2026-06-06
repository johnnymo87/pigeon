import { describe, expect, it } from "vitest";
import {
  classifyActivity,
  snippetFromMessages,
  lastActivityFromMessages,
} from "../src/current-state-enrich";

describe("current-state-enrich", () => {
  describe("classifyActivity", () => {
    it("returns idle for empty message array", () => {
      expect(classifyActivity([])).toBe("idle");
    });

    it("returns idle for unknown last message shape or missing info", () => {
      expect(classifyActivity([{}])).toBe("idle");
      expect(classifyActivity([{ info: {} }])).toBe("idle");
      expect(classifyActivity([{ info: { role: "other" } }])).toBe("idle");
    });

    it("returns active when last message is from user", () => {
      const messages = [
        { info: { role: "assistant", time: { created: 100, completed: 150 } } },
        { info: { role: "user", time: { created: 200 } } },
      ];
      expect(classifyActivity(messages)).toBe("active");
    });

    it("returns idle when last message is assistant with completed time", () => {
      const messages = [
        { info: { role: "user", time: { created: 100 } } },
        { info: { role: "assistant", time: { created: 150, completed: 200 } } },
      ];
      expect(classifyActivity(messages)).toBe("idle");
    });

    it("returns active when last message is assistant without completed time", () => {
      const messages = [
        { info: { role: "user", time: { created: 100 } } },
        { info: { role: "assistant", time: { created: 150 } } },
      ];
      expect(classifyActivity(messages)).toBe("active");
    });

    it("returns active when last message is assistant with completed time missing entirely", () => {
      const messages = [
        { info: { role: "assistant", time: { created: 150 } } },
      ];
      expect(classifyActivity(messages)).toBe("active");
    });
  });

  describe("snippetFromMessages", () => {
    it("returns empty string for empty message array", () => {
      expect(snippetFromMessages([])).toBe("");
    });

    it("returns empty string if no assistant message is present", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      ];
      expect(snippetFromMessages(messages)).toBe("");
    });

    it("finds the most recent assistant message and returns its last non-empty text part trimmed", () => {
      const messages = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "first response" }],
        },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "next user message" }],
        },
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "ignored part" },
            { type: "text", text: "  last response part  \n" },
            { type: "image", text: "not-text" },
            { type: "text", text: "" }, // empty text part
          ],
        },
      ];
      expect(snippetFromMessages(messages)).toBe("last response part");
    });

    it("truncates the last response part to maxLen and trims the output", () => {
      const messages = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "this is a very long response string" }],
        },
      ];
      // Test custom maxLen
      expect(snippetFromMessages(messages, 10)).toBe("this is a");
      // Test default maxLen (200)
      const longText = "a".repeat(250);
      const longMessages = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: longText }],
        },
      ];
      expect(snippetFromMessages(longMessages)).toBe("a".repeat(200));
    });

    it("is safe with malformed/missing parts and non-string text", () => {
      expect(snippetFromMessages([
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: 123 }], // invalid type
        },
      ])).toBe("");

      expect(snippetFromMessages([
        {
          info: { role: "assistant" },
          // parts missing
        },
      ])).toBe("");

      expect(snippetFromMessages([
        {
          info: { role: "assistant" },
          parts: [{}], // parts missing type/text
        },
      ])).toBe("");
    });
  });

  describe("lastActivityFromMessages", () => {
    it("returns null for empty array", () => {
      expect(lastActivityFromMessages([])).toBeNull();
    });

    it("returns the newest timestamp across all messages", () => {
      const messages = [
        { info: { role: "user", time: { created: 100 } } },
        { info: { role: "assistant", time: { created: 150, completed: 180 } } },
        { info: { role: "user", time: { created: 120 } } }, // older out-of-order
      ];
      expect(lastActivityFromMessages(messages)).toBe(180);
    });

    it("uses created timestamp if completed is missing", () => {
      const messages = [
        { info: { role: "user", time: { created: 100 } } },
        { info: { role: "assistant", time: { created: 190 } } },
      ];
      expect(lastActivityFromMessages(messages)).toBe(190);
    });

    it("handles missing/malformed timestamps and info defensively", () => {
      expect(lastActivityFromMessages([
        { info: { role: "user", time: {} } },
        { info: {} },
        {},
      ])).toBeNull();

      const messagesWithSomeValid = [
        { info: { role: "user", time: { created: 100 } } },
        { info: { role: "assistant", time: {} } },
        {},
      ];
      expect(lastActivityFromMessages(messagesWithSomeValid)).toBe(100);
    });

    it("ignores NaN timestamps and returns a valid earlier timestamp", () => {
      const messages = [
        { info: { role: "user", time: { created: 12345 } } },
        { info: { role: "assistant", time: { created: NaN } } },
        { info: { role: "user", time: { created: 100, completed: NaN } } },
      ];
      expect(lastActivityFromMessages(messages)).toBe(12345);
    });
  });
});

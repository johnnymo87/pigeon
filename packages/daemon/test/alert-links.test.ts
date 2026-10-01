import { describe, expect, it, vi } from "vitest";
import {
  MAX_ALERT_LINKS,
  MAX_BUTTON_LABEL_CHARS,
  buildAlertKeyboard,
  parseAlertLinks,
  resolveAlertKeyboard,
  topicUrl,
  type TopicLookup,
} from "../src/alert-links";

const CHAT = "-1001234567890";

describe("parseAlertLinks", () => {
  it("returns [] for anything that is not an array", () => {
    for (const raw of [undefined, null, "x", 1, {}, { label: "a", sessionId: "s" }]) {
      expect(parseAlertLinks(raw)).toEqual([]);
    }
  });

  it("keeps well-formed entries and silently drops malformed ones", () => {
    expect(
      parseAlertLinks([
        { label: "one", sessionId: "s1" },
        null,
        "s2",
        { label: "", sessionId: "s3" },
        { label: "four", sessionId: "" },
        { label: 4, sessionId: "s4" },
        { label: "five", sessionId: 5 },
        { label: "  six  ", sessionId: "  s6  " },
      ]),
    ).toEqual([
      { label: "one", sessionId: "s1" },
      { label: "six", sessionId: "s6" },
    ]);
  });

  it("dedupes by sessionId, first label wins", () => {
    expect(
      parseAlertLinks([
        { label: "first", sessionId: "s1" },
        { label: "second", sessionId: "s1" },
      ]),
    ).toEqual([{ label: "first", sessionId: "s1" }]);
  });

  it("caps the number of links", () => {
    const raw = Array.from({ length: MAX_ALERT_LINKS + 5 }, (_, i) => ({ label: `l${i}`, sessionId: `s${i}` }));
    const parsed = parseAlertLinks(raw);
    expect(parsed).toHaveLength(MAX_ALERT_LINKS);
    expect(parsed[0]).toEqual({ label: "l0", sessionId: "s0" });
  });

  it("truncates a long label with an ellipsis, counting code points", () => {
    const long = "😀".repeat(MAX_BUTTON_LABEL_CHARS + 10);
    const [link] = parseAlertLinks([{ label: long, sessionId: "s1" }]);
    expect([...link!.label]).toHaveLength(MAX_BUTTON_LABEL_CHARS);
    expect(link!.label.endsWith("…")).toBe(true);
  });
});

describe("topicUrl", () => {
  it("strips the -100 supergroup prefix", () => {
    expect(topicUrl(CHAT, 42)).toBe("https://t.me/c/1234567890/42");
  });

  it("refuses a chat id that is not a -100 supergroup id", () => {
    expect(topicUrl("1234567890", 42)).toBeNull();
    expect(topicUrl("-1234567890", 42)).toBeNull();
    expect(topicUrl("-100", 42)).toBeNull();
    expect(topicUrl("-100abc", 42)).toBeNull();
  });

  it("refuses a missing or non-positive thread id", () => {
    expect(topicUrl(CHAT, null)).toBeNull();
    expect(topicUrl(CHAT, 0)).toBeNull();
    expect(topicUrl(CHAT, -3)).toBeNull();
    expect(topicUrl(CHAT, 1.5)).toBeNull();
  });
});

describe("buildAlertKeyboard", () => {
  const links = [
    { label: "alpha", sessionId: "s1" },
    { label: "beta", sessionId: "s2" },
    { label: "gamma", sessionId: "s3" },
    { label: "delta", sessionId: "s4" },
  ];

  it("one url button per row, in link order, skipping unlinkable sessions", () => {
    const keyboard = buildAlertKeyboard(links, {
      s1: { chatId: CHAT, messageThreadId: 10, state: "open" },
      s2: null,
      s3: { chatId: CHAT, messageThreadId: null, state: "open" },
      s4: { chatId: CHAT, messageThreadId: 40, state: "closed" },
    });
    expect(keyboard).toEqual({
      inline_keyboard: [
        [{ text: "alpha", url: "https://t.me/c/1234567890/10" }],
        [{ text: "delta", url: "https://t.me/c/1234567890/40" }],
      ],
    });
  });

  it("returns undefined when nothing is linkable", () => {
    expect(buildAlertKeyboard(links, {})).toBeUndefined();
    expect(buildAlertKeyboard([], {})).toBeUndefined();
  });
});

describe("resolveAlertKeyboard (fail open)", () => {
  const raw = [{ label: "alpha", sessionId: "s1" }];

  it("looks up the parsed session ids once and builds the keyboard", async () => {
    const lookup = vi.fn<TopicLookup>().mockResolvedValue({
      s1: { chatId: CHAT, messageThreadId: 10, state: "open" },
    });
    const keyboard = await resolveAlertKeyboard(raw, lookup, 1000);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(["s1"], expect.any(AbortSignal));
    expect(keyboard?.inline_keyboard).toHaveLength(1);
  });

  it("does not call the lookup when there are no usable links", async () => {
    const lookup = vi.fn<TopicLookup>();
    expect(await resolveAlertKeyboard(undefined, lookup, 1000)).toBeUndefined();
    expect(await resolveAlertKeyboard([{ bogus: true }], lookup, 1000)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns undefined when no lookup is configured", async () => {
    expect(await resolveAlertKeyboard(raw, undefined, 1000)).toBeUndefined();
  });

  it("returns undefined when the lookup throws", async () => {
    const lookup = vi.fn<TopicLookup>().mockRejectedValue(new Error("boom"));
    expect(await resolveAlertKeyboard(raw, lookup, 1000)).toBeUndefined();
  });

  it("returns undefined when the lookup returns garbage", async () => {
    const lookup = vi.fn<TopicLookup>().mockResolvedValue("nope" as never);
    expect(await resolveAlertKeyboard(raw, lookup, 1000)).toBeUndefined();
    const lookup2 = vi.fn<TopicLookup>().mockResolvedValue({ s1: { chatId: 5, messageThreadId: "x" } } as never);
    expect(await resolveAlertKeyboard(raw, lookup2, 1000)).toBeUndefined();
  });

  it("gives up after the timeout even if the lookup never settles, and aborts it", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const lookup = vi.fn<TopicLookup>((_ids, signal) => {
        seen = signal;
        return new Promise(() => {});
      });
      const pending = resolveAlertKeyboard(raw, lookup, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBeUndefined();
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

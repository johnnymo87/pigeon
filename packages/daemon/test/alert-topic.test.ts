import { describe, expect, it, vi } from "vitest";
import { parseAlertTopic, resolveAlertTopic, type NamedTopicResolver } from "../src/alert-topic";

describe("parseAlertTopic", () => {
  it("accepts a valid key and trims the name", () => {
    expect(parseAlertTopic({ key: "digest:alpha_1.x-y", name: "  Alpha  " })).toEqual({
      key: "digest:alpha_1.x-y",
      name: "Alpha",
    });
  });

  it("defaults a missing or blank name to the key", () => {
    expect(parseAlertTopic({ key: "k1" })).toEqual({ key: "k1", name: "k1" });
    expect(parseAlertTopic({ key: "k1", name: "  " })).toEqual({ key: "k1", name: "k1" });
    expect(parseAlertTopic({ key: "k1", name: 5 })).toEqual({ key: "k1", name: "k1" });
  });

  it("returns undefined for anything malformed, never throws", () => {
    for (const raw of [undefined, null, "k", 1, [], {}, { key: "" }, { key: "a b" }, { key: "x".repeat(65) }, { key: 7 }, { key: "ok/no" }]) {
      expect(parseAlertTopic(raw)).toBeUndefined();
    }
  });
});

describe("resolveAlertTopic (fail open)", () => {
  const topic = { key: "k", name: "n" };

  it("returns the resolver's thread", async () => {
    const r = vi.fn<NamedTopicResolver>().mockResolvedValue({ messageThreadId: 5, created: true });
    expect(await resolveAlertTopic(topic, r, 1000)).toEqual({ messageThreadId: 5, created: true });
    expect(r).toHaveBeenCalledWith({ key: "k", name: "n" }, expect.any(AbortSignal));
  });

  it("passes staleThreadId through", async () => {
    const r = vi.fn<NamedTopicResolver>().mockResolvedValue({ messageThreadId: 6, created: true });
    await resolveAlertTopic(topic, r, 1000, 5);
    expect(r).toHaveBeenCalledWith({ key: "k", name: "n", staleThreadId: 5 }, expect.any(AbortSignal));
  });

  it("undefined when there is no resolver, it throws, or it returns garbage", async () => {
    expect(await resolveAlertTopic(topic, undefined, 1000)).toBeUndefined();
    expect(await resolveAlertTopic(topic, vi.fn<NamedTopicResolver>().mockRejectedValue(new Error("x")), 1000)).toBeUndefined();
    expect(await resolveAlertTopic(topic, vi.fn<NamedTopicResolver>().mockResolvedValue({ messageThreadId: 0, created: false }), 1000)).toBeUndefined();
    expect(await resolveAlertTopic(topic, vi.fn<NamedTopicResolver>().mockResolvedValue("x" as never), 1000)).toBeUndefined();
  });

  it("gives up at the timeout even if the resolver never settles", async () => {
    vi.useFakeTimers();
    try {
      const r = vi.fn<NamedTopicResolver>(() => new Promise(() => {}));
      const p = resolveAlertTopic(topic, r, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

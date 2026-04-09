import { describe, expect, it } from "vitest";
import { TgMessageBuilder, type TgMessage, type TgEntity } from "../src/telegram-message";

describe("TgMessageBuilder", () => {
  it("builds plain text with no entities", () => {
    const msg = new TgMessageBuilder().append("hello").build();
    expect(msg.text).toBe("hello");
    expect(msg.entities).toHaveLength(0);
  });

  it("tracks offset for bold entity", () => {
    const msg = new TgMessageBuilder()
      .append("Hello ")
      .appendBold("world")
      .build();
    expect(msg.text).toBe("Hello world");
    expect(msg.entities).toEqual([{ offset: 6, length: 5, type: "bold" }]);
  });

  it("tracks offset for code entity", () => {
    const msg = new TgMessageBuilder()
      .append("Session: ")
      .appendCode("sess-abc123")
      .build();
    expect(msg.text).toBe("Session: sess-abc123");
    expect(msg.entities).toEqual([{ offset: 9, length: 11, type: "code" }]);
  });

  it("tracks offset for italic entity", () => {
    const msg = new TgMessageBuilder()
      .append("Note: ")
      .appendItalic("swipe to reply")
      .build();
    expect(msg.text).toBe("Note: swipe to reply");
    expect(msg.entities).toEqual([{ offset: 6, length: 14, type: "italic" }]);
  });

  it("handles multiple entities with correct cumulative offsets", () => {
    const msg = new TgMessageBuilder()
      .appendBold("Stop")
      .append(": ")
      .appendCode("my-project")
      .append(" on ")
      .appendItalic("devbox")
      .build();
    expect(msg.text).toBe("Stop: my-project on devbox");
    expect(msg.entities).toEqual([
      { offset: 0, length: 4, type: "bold" },
      { offset: 6, length: 10, type: "code" },
      { offset: 20, length: 6, type: "italic" },
    ]);
  });

  it("handles newline convenience method", () => {
    const msg = new TgMessageBuilder()
      .append("line1")
      .newline()
      .append("line2")
      .newline(2)
      .append("line4")
      .build();
    expect(msg.text).toBe("line1\nline2\n\nline4");
  });

  it("handles emoji correctly (UTF-16 surrogate pairs)", () => {
    // 🤖 is U+1F916, encoded as 2 UTF-16 code units
    const msg = new TgMessageBuilder()
      .append("🤖 ")
      .appendBold("Stop")
      .build();
    expect(msg.text).toBe("🤖 Stop");
    // "🤖 " = 2 (surrogate pair) + 1 (space) = 3 UTF-16 code units
    expect(msg.entities).toEqual([{ offset: 3, length: 4, type: "bold" }]);
  });

  it("builds empty message", () => {
    const msg = new TgMessageBuilder().build();
    expect(msg.text).toBe("");
    expect(msg.entities).toHaveLength(0);
  });
});

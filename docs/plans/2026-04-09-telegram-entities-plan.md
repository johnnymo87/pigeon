# Telegram Entities Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `parse_mode: "Markdown"` with Telegram `entities` arrays across all notification and message paths, eliminating Markdown escaping failures for arbitrary AI output.

**Architecture:** New `TgMessageBuilder` produces `{ text, entities }` objects. Formatters use the builder instead of string concatenation with escapeMarkdown. The splitter operates on `TgMessage` triples (header, body, footer). Entities flow through outbox, poller, and worker to the Telegram API.

**Tech Stack:** TypeScript, Vitest, Telegram Bot API `entities` field

**Design:** [docs/plans/2026-04-09-telegram-entities-design.md](./2026-04-09-telegram-entities-design.md)

---

### Task 1: TgMessageBuilder — types and builder

**Files:**
- Create: `packages/daemon/src/telegram-message.ts`
- Create: `packages/daemon/test/telegram-message.test.ts`

**Step 1: Write the tests**

```ts
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
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/telegram-message.test.ts`
Expected: FAIL — module not found

**Step 3: Implement TgMessageBuilder**

```ts
export interface TgEntity {
  offset: number;
  length: number;
  type: "bold" | "italic" | "code" | "pre";
}

export interface TgMessage {
  text: string;
  entities: TgEntity[];
}

export class TgMessageBuilder {
  private text = "";
  private entities: TgEntity[] = [];

  append(s: string): this {
    this.text += s;
    return this;
  }

  appendBold(s: string): this {
    return this.appendEntity(s, "bold");
  }

  appendItalic(s: string): this {
    return this.appendEntity(s, "italic");
  }

  appendCode(s: string): this {
    return this.appendEntity(s, "code");
  }

  newline(count = 1): this {
    this.text += "\n".repeat(count);
    return this;
  }

  build(): TgMessage {
    return { text: this.text, entities: [...this.entities] };
  }

  private appendEntity(s: string, type: TgEntity["type"]): this {
    const offset = this.text.length;
    this.text += s;
    this.entities.push({ offset, length: s.length, type });
    return this;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/telegram-message.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/telegram-message.ts packages/daemon/test/telegram-message.test.ts
git commit -m "feat: add TgMessageBuilder for Telegram entity-based formatting"
```

---

### Task 2: Add `concatMessages` utility and test it

We need a utility to concatenate multiple `TgMessage` objects (for joining header + separator + body chunk + separator + footer). This belongs in `telegram-message.ts`.

**Files:**
- Modify: `packages/daemon/src/telegram-message.ts`
- Modify: `packages/daemon/test/telegram-message.test.ts`

**Step 1: Write the tests**

```ts
import { concatMessages, type TgMessage } from "../src/telegram-message";

describe("concatMessages", () => {
  it("concatenates text and adjusts entity offsets", () => {
    const a: TgMessage = {
      text: "Hello ",
      entities: [{ offset: 0, length: 5, type: "bold" }],
    };
    const b: TgMessage = {
      text: "world",
      entities: [{ offset: 0, length: 5, type: "italic" }],
    };
    const result = concatMessages([a, b]);
    expect(result.text).toBe("Hello world");
    expect(result.entities).toEqual([
      { offset: 0, length: 5, type: "bold" },
      { offset: 6, length: 5, type: "italic" },
    ]);
  });

  it("handles empty messages in the array", () => {
    const a: TgMessage = { text: "hi", entities: [] };
    const b: TgMessage = { text: "", entities: [] };
    const c: TgMessage = {
      text: "there",
      entities: [{ offset: 0, length: 5, type: "code" }],
    };
    const result = concatMessages([a, b, c]);
    expect(result.text).toBe("hithere");
    expect(result.entities).toEqual([
      { offset: 2, length: 5, type: "code" },
    ]);
  });

  it("returns empty message for empty array", () => {
    const result = concatMessages([]);
    expect(result.text).toBe("");
    expect(result.entities).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/telegram-message.test.ts`
Expected: FAIL — concatMessages not exported

**Step 3: Implement concatMessages**

```ts
export function concatMessages(messages: TgMessage[]): TgMessage {
  let text = "";
  const entities: TgEntity[] = [];
  for (const msg of messages) {
    const offset = text.length;
    text += msg.text;
    for (const e of msg.entities) {
      entities.push({ offset: e.offset + offset, length: e.length, type: e.type });
    }
  }
  return { text, entities };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/telegram-message.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/telegram-message.ts packages/daemon/test/telegram-message.test.ts
git commit -m "feat: add concatMessages utility for joining TgMessage objects"
```

---

### Task 3: Migrate splitTelegramMessage to entity-aware

**Files:**
- Modify: `packages/daemon/src/split-message.ts`
- Modify: `packages/daemon/test/split-message.test.ts`

**Step 1: Write the new tests**

Replace the test file entirely. The new tests use `TgMessage` inputs:

```ts
import { describe, expect, it } from "vitest";
import { splitTelegramMessage } from "../src/split-message";
import type { TgMessage } from "../src/telegram-message";

describe("splitTelegramMessage", () => {
  const header: TgMessage = {
    text: "HEADER",
    entities: [{ offset: 0, length: 6, type: "bold" }],
  };
  const footer: TgMessage = {
    text: "FOOTER",
    entities: [{ offset: 0, length: 6, type: "code" }],
  };
  const plainHeader: TgMessage = { text: "HEADER", entities: [] };
  const plainFooter: TgMessage = { text: "FOOTER", entities: [] };
  const plainBody = (text: string): TgMessage => ({ text, entities: [] });

  it("returns single message when body fits", () => {
    const result = splitTelegramMessage(plainHeader, plainBody("Short body"), plainFooter, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("HEADER\n\nShort body\n\nFOOTER");
    expect(result[0].entities).toHaveLength(0);
  });

  it("adjusts header and footer entity offsets in combined message", () => {
    const body = plainBody("hello");
    const result = splitTelegramMessage(header, body, footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("HEADER\n\nhello\n\nFOOTER");
    // header bold: offset 0, length 6
    // footer code: offset = 6 + 2 + 5 + 2 = 15, length 6
    expect(result[0].entities).toEqual([
      { offset: 0, length: 6, type: "bold" },
      { offset: 15, length: 6, type: "code" },
    ]);
  });

  it("splits on paragraph boundary and duplicates header/footer entities", () => {
    const body = plainBody("Paragraph one.\n\nParagraph two.");
    // overhead = 6 + 6 + 4 = 16, maxBody = 30 - 16 = 14
    const result = splitTelegramMessage(header, body, footer, 30);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("Paragraph one.");
    expect(result[1].text).toContain("Paragraph two.");
    // Both chunks should have header bold entity at offset 0
    expect(result[0].entities[0]).toEqual({ offset: 0, length: 6, type: "bold" });
    expect(result[1].entities[0]).toEqual({ offset: 0, length: 6, type: "bold" });
  });

  it("splits on line boundary when no paragraph break fits", () => {
    const body = plainBody("Line one.\nLine two.");
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 26);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("Line one.");
    expect(result[1].text).toContain("Line two.");
  });

  it("splits on sentence boundary when no line break fits", () => {
    const body = plainBody("First sentence. Second sentence.");
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 32);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("First sentence.");
    expect(result[1].text).toContain("Second sentence.");
  });

  it("hard-cuts when no natural boundary found", () => {
    const body = plainBody("x".repeat(100));
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("uses 4096 as default maxLen", () => {
    const body = plainBody("x".repeat(4000));
    const result = splitTelegramMessage(plainHeader, body, plainFooter);
    expect(result).toHaveLength(1);
  });

  it("handles empty body", () => {
    const result = splitTelegramMessage(plainHeader, plainBody(""), plainFooter, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("HEADER\n\n\n\nFOOTER");
  });

  it("preserves body entities within a single chunk", () => {
    const body: TgMessage = {
      text: "plain then code_thing plain",
      entities: [{ offset: 11, length: 10, type: "code" }],
    };
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 200);
    expect(result).toHaveLength(1);
    // body entity offset shifts by header + "\n\n" = 8
    expect(result[0].entities).toEqual([
      { offset: 19, length: 10, type: "code" },
    ]);
  });

  it("clips body entities at split boundary", () => {
    // Entity spans positions 5-14 in body. If body splits at position 10,
    // first chunk gets entity clipped to offset 5, length 5.
    // Second chunk gets no part of that entity (entity started in first chunk).
    const body: TgMessage = {
      text: "AAAAABBBBBBBBBBCCCCC",  // 20 chars: 5 A, 10 B, 5 C
      entities: [{ offset: 5, length: 10, type: "bold" }],
    };
    // Force split: overhead=16, maxBody=20-16=4. That's too tight.
    // Use overhead=8 (shorter header/footer): maxBody=16-8=8
    const shortHeader: TgMessage = { text: "H", entities: [] };
    const shortFooter: TgMessage = { text: "F", entities: [] };
    // overhead = 1+1+4 = 6, maxBody = 16-6 = 10
    const result = splitTelegramMessage(shortHeader, body, shortFooter, 16);
    expect(result.length).toBeGreaterThan(1);
    // The entity should appear in whichever chunk(s) contain its span,
    // clipped to the chunk boundaries
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/split-message.test.ts`
Expected: FAIL — signature mismatch

**Step 3: Rewrite splitTelegramMessage**

The new implementation:
- Accepts `(header: TgMessage, body: TgMessage, footer: TgMessage, maxLen?)`
- Splits the body text using the same `findSplitPoint` algorithm
- For each body chunk, slices the body entities that fall within that chunk's range, adjusting offsets
- Concatenates header + `\n\n` + chunk + `\n\n` + footer using offset arithmetic
- Returns `TgMessage[]`

Use `concatMessages` from `telegram-message.ts` for the final join step of each chunk.

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/split-message.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/split-message.ts packages/daemon/test/split-message.test.ts
git commit -m "feat: migrate splitTelegramMessage to entity-aware TgMessage"
```

---

### Task 4: Migrate formatters to TgMessageBuilder

**Files:**
- Modify: `packages/daemon/src/notification-service.ts`
- Modify: `packages/daemon/test/notification-service.test.ts`

**Step 1: Update tests for new return types**

Update all formatter tests to expect `TgMessage` return types instead of Markdown strings. Key changes:
- `formatTelegramNotification` tests check for `header`, `body`, `footer` properties (each a `TgMessage`) and `replyMarkup`
- `formatQuestionNotification` tests check for `message` property (a `TgMessage`) and `replyMarkup`
- `formatQuestionWizardStep` tests check for `message` property (a `TgMessage`) and `replyMarkup`
- Replace assertions like `toContain("*Stop*")` with entity-based assertions: check that "Stop" appears in `text` and has a bold entity at the correct offset
- Remove all assertions about escaped Markdown characters (`\\_`, `\\[`, etc.)

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: FAIL — return type mismatch

**Step 3: Rewrite formatters**

- `formatTelegramNotification`: use `TgMessageBuilder` to build header (emoji + bold event + plain label), body (plain summary), and footer (code cwd, plain machine, code sessionId, italic swipe-reply). Return `{ header, body, footer, replyMarkup }`. Delete `escapeMarkdown` function.
- `formatQuestionNotification`: use `TgMessageBuilder` to build a single `TgMessage`. Bold for headers, plain for question text/options, code for cwd/sessionId, italic for hints. Return `{ message, replyMarkup }`.
- `formatQuestionWizardStep`: same pattern as question notification. Return `{ message, replyMarkup }`.

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: migrate notification formatters to TgMessageBuilder entities"
```

---

### Task 5: Update TelegramNotificationService (direct path)

**Files:**
- Modify: `packages/daemon/src/notification-service.ts`
- Modify: `packages/daemon/test/notification-service.test.ts`

**Step 1: Update tests**

- `TelegramNotificationService` tests: assert that the Telegram API call includes `entities` array instead of `parse_mode: "Markdown"`. Assert `parse_mode` is absent from the payload.

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: FAIL — payload still has parse_mode

**Step 3: Update sendTelegramMessage**

Change the private `sendTelegramMessage` method:
- Accept `entities: TgEntity[]` parameter
- Replace `parse_mode: "Markdown"` with `entities` in the Telegram API JSON payload
- Update `sendStopNotification` to call `splitTelegramMessage(header, body, footer)` with the new formatter output, then pass entities from each chunk
- Update `sendQuestionNotification` similarly

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: TelegramNotificationService sends entities instead of parse_mode"
```

---

### Task 6: Update WorkerNotificationService and interface

**Files:**
- Modify: `packages/daemon/src/notification-service.ts`
- Modify: `packages/daemon/test/notification-service.test.ts`

**Step 1: Update tests**

- `WorkerNotificationService` tests: assert that `sendNotification` is called with entities array as an additional parameter.

**Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: FAIL — entities not passed

**Step 3: Update WorkerNotificationService**

- Add `entities?: TgEntity[]` to `WorkerNotificationSender.sendNotification` interface
- Pass entities through in `sendViaWorker` calls
- Update `sendStopNotification` and `sendQuestionNotification` to use the new formatter outputs and pass entities

**Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/daemon/test/notification-service.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: WorkerNotificationService passes entities through to worker"
```

---

### Task 7: Update outbox payload format and OutboxSender

**Files:**
- Modify: `packages/daemon/src/app.ts`
- Modify: `packages/daemon/src/worker/outbox-sender.ts`

**Step 1: Update app.ts outbox payloads**

In the `/stop` handler:
- Call `splitTelegramMessage(header, body, footer)` from the formatter output
- Store `messages: chunks.map(c => ({ text: c.text, entities: c.entities }))` in the outbox payload instead of `texts: string[]`

In the `/question-asked` handler:
- Store `message: { text, entities }` instead of `text: string`

**Step 2: Update OutboxSender to parse new format**

- Parse `messages` array (stop) or `message` object (question) from payload
- Pass entities alongside text to `sendNotification`

**Step 3: Update SendNotificationFn type**

Add `entities?` parameter to the `SendNotificationFn` type.

**Step 4: Run all daemon tests**

Run: `npm run test -- packages/daemon`
Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/app.ts packages/daemon/src/worker/outbox-sender.ts
git commit -m "feat: outbox stores and delivers TgMessage entities"
```

---

### Task 8: Update Poller to pass entities to worker

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts`

**Step 1: Update sendNotification**

Add `entities?` parameter. Include `entities` in the JSON POST body to the worker `/notifications/send`.

**Step 2: Update editNotification**

Add `entities?` parameter. Include `entities` in the JSON POST body to the worker `/notifications/edit`.

**Step 3: Run daemon tests**

Run: `npm run test -- packages/daemon`
Expected: PASS

**Step 4: Commit**

```
git add packages/daemon/src/worker/poller.ts
git commit -m "feat: poller passes entities to worker notification endpoints"
```

---

### Task 9: Update command-ingest wizard edit path

**Files:**
- Modify: `packages/daemon/src/worker/command-ingest.ts`

**Step 1: Update wizard edit calls**

- `formatQuestionWizardStep` now returns `{ message: TgMessage, replyMarkup }` 
- Pass `message.text` and `message.entities` to `editNotification`
- Update the `editNotification` callback type in options to accept entities

**Step 2: Run daemon tests**

Run: `npm run test -- packages/daemon`
Expected: PASS

**Step 3: Commit**

```
git add packages/daemon/src/worker/command-ingest.ts
git commit -m "feat: wizard edit passes entities to editNotification"
```

---

### Task 10: Update worker to forward entities to Telegram API

**Files:**
- Modify: `packages/worker/src/notifications.ts`

**Step 1: Update handleSendNotification**

- Read `entities` from request body (add to `SendNotificationBody` interface)
- Include `entities` in the Telegram `sendMessage` payload when present

**Step 2: Update handleEditNotification**

- Read `entities` from request body
- Include `entities` in the `editMessageText` payload when present
- Remove `parseMode` handling (clean break)

**Step 3: Run worker tests (if any)**

Run: `npm run test -- packages/worker`
Expected: PASS (or no tests to run)

**Step 4: Commit**

```
git add packages/worker/src/notifications.ts
git commit -m "feat: worker forwards entities to Telegram sendMessage/editMessageText"
```

---

### Task 11: Drop parse_mode from daemon startup message

**Files:**
- Modify: `packages/daemon/src/index.ts`

**Step 1: Remove parse_mode: "Markdown" from sendTelegramMessage**

Line 36: remove `parse_mode: "Markdown"` from the JSON body. The startup message is plain text.

**Step 2: Run all tests**

Run: `npm run test`
Expected: PASS

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```
git add packages/daemon/src/index.ts
git commit -m "chore: drop parse_mode from daemon startup message"
```

---

### Task 12: Final cleanup and verification

**Step 1: Search for any remaining parse_mode references**

```bash
grep -r "parse_mode" packages/
```

The only remaining reference should be in `webhook.ts` `handleEditNotification` if the worker still accepts it from external callers — but per Task 10 we removed it. Verify none remain.

**Step 2: Search for any remaining escapeMarkdown references**

```bash
grep -r "escapeMarkdown" packages/
```

Should return zero results.

**Step 3: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit any cleanup**

```
git add -A
git commit -m "chore: final cleanup — remove all parse_mode and escapeMarkdown references"
```

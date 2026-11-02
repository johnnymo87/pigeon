# Rich tables in Telegram — Implementation Plan (pigeon-p909)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop notifications whose body contains a GFM pipe table are sent with Telegram's
`sendRichMessage`, falling back once (loudly) to the plain `sendMessage` on rejection.

**Architecture:** The daemon decides (it owns header/body/footer and chunking) and attaches
`rich: {markdown}` to the stop outbox payload; the outbox sender puts it on chunk 0's request;
the worker tries rich, falls back to the plain chunk it was given, and reports which it did.
Design: `docs/plans/2026-11-02-telegram-rich-tables-design.md`.

**Tech Stack:** TypeScript, vitest (daemon: node; worker: `@cloudflare/vitest-pool-workers` +
`fetchMock`).

Commands: `npm run test --workspace @pigeon/daemon -- <file>`,
`npm run test --workspace @pigeon/worker -- <file>`, `npm run typecheck`.

---

### Task 1: daemon `rich-markdown.ts`

**Files:** Create `packages/daemon/src/rich-markdown.ts`, `packages/daemon/test/rich-markdown.test.ts`.

Functions and the tests that pin them:

- `hasPipeTable(text)`: true for header+delimiter rows (with and without outer pipes, with
  alignment colons); false for a lone `|` line, a delimiter row without a header row with a
  pipe, and a table inside a fenced code block.
- `maxTableColumns(text)`: column count of the widest delimiter row outside fences.
- `sanitizeBodyMarkdown(text)`: escapes `$`, `<`, `==`, and `||` (non-table lines only)
  outside fences and inline code spans; leaves fenced code and inline code byte-identical;
  converts lone `\n` to `"  \n"` outside fences and table blocks; leaves `\n\n` alone.
- `tgMessageToMarkdown(msg)`: escapes plain segments; `code` → backticks (longer fence when
  content contains backticks, padded when it starts/ends with one); `bold` → `**`, `italic` →
  `_`, `pre` → fenced block; `\n` → hard break; null on overlapping entities.
- `buildRichMarkdown(header, body, footer)`: null without a table; null over 20 columns,
  over 500 estimated blocks, over 32768 code points; otherwise header/body/footer joined by
  `\n\n`, empty parts skipped.

### Task 2: daemon stop payload + outbox sender

**Files:** Modify `packages/daemon/src/app.ts` (`handleStopBody`, ~line 752),
`packages/daemon/src/worker/poller.ts` (`SendNotificationInput.rich`, request body),
`packages/daemon/src/worker/outbox-sender.ts` (payload parse, chunk loop).
Tests: `packages/daemon/test/outbox-sender.test.ts`, `packages/daemon/test/stop-idempotency.test.ts`
(or the nearest existing stop-payload test).

- Stop payload carries `rich` only when the body has a table.
- Outbox: chunk 0 carries `rich`; `{rich:"sent"}` ends the entry after one request (multi-chunk
  too); `{rich:"fallback"}` and a field-less success continue with chunks 1..N-1; later chunks
  never carry `rich`; fallback is logged.

### Task 3: worker `sendRichMessage` + fallback

**Files:** Modify `packages/worker/src/telegram.ts`, `packages/worker/src/notifications.ts`,
`packages/worker/src/types.ts`. Test: `packages/worker/test/rich-messages.test.ts`.

- Rich success: one `sendRichMessage` call with `chat_id`, `rich_message.markdown`,
  `message_thread_id` when threaded, mention keyboard from the markdown; D1 row recorded;
  response `rich: "sent"`.
- 400 → one `sendMessage` with the plain text; response `rich: "fallback"`; warn logged.
- 5xx → 502, no plain send. 429 → 429.
- No `rich` in request → no `sendRichMessage`, no `rich` field in response.
- `TELEGRAM_RICH_MESSAGES = "off"` → plain only, `rich: "fallback"`.
- Oversized markdown (> 32768 code points) → plain only.

### Task 4: worker webhook `inReplyTo` from `rich_message`

**Files:** Modify `packages/worker/src/webhook.ts`; test in `packages/worker/test/worker.test.ts`
next to the existing `buildExecuteMetadata` tests.

- `richMessagePlainText(rich)` extracts paragraph/heading/list/table text.
- `buildExecuteMetadata` uses it when `text` and `caption` are absent.

### Task 5: docs

**Files:** `AGENTS.md` (Notifications section), the `worker-architecture` skill if it lists
Telegram methods.

### Task 6: full suite, typecheck, adversarial review, PR (shepherding-pull-requests).

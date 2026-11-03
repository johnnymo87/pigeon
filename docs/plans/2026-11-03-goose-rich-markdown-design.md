# Goose turns render their markdown (pigeon-6mkr)

Follow-up to `2026-11-02-telegram-rich-tables-design.md` (pigeon-p909).

## Problem

Goose coordinators write markdown: `**bold**` lead-ins, numbered lists with nested bullets,
blockquotes, inline code. Their turns reach Telegram as plain text, so the human reads raw
`**` and `>`. opencode does not have this problem because its plugin strips markdown before
the daemon sees it (`opencode-plugin/src/message-tail.ts` `stripMarkdown`). Goose turns are
not stripped: honkd `turn.ended` → `POST /goose/turn-event` → `renderHookTurn` →
`handleStopBody`, and pigeon's own goose runner also ends in `handleStopBody`.

p909 already sends a stop as one Telegram rich message, but only when its body has a pipe table.

## Decision

**A stop from a goose-acp session is offered rich whatever its body contains.** Every other
session keeps the table-only trigger. The test is `session.backendKind === GOOSE_BACKEND_KIND`
in `handleStopBody`. That covers both goose paths (hook turns and runner turns, plus the
runner's own notices) and nothing else. goose-pull sessions do not send stops.

Everything else is p909's machinery, unchanged: the same sanitizer, the same limits (32768
characters, 500 estimated blocks, 20 columns), plain chunks still built and stored as the
fallback, the worker's rich-then-plain logic, the kill switch `TELEGRAM_RICH_MESSAGES=off`.
No worker change.

### Why not detect markdown instead of keying on the backend

A "does this look like markdown" test is ambiguous (is a lone `*` emphasis? is `1.` a list?),
and coordinators use markdown in almost every turn, so it would buy little. Turning rich on
for a prose-only message changes nothing visible, because the sanitizer keeps every newline
(lone newlines become hard breaks) and defangs Telegram's extensions. Measured on real goose
turns from cloudbox's outbox: bold, nested ordered/bullet lists, blockquotes and code spans
all come back from the live API as the intended blocks.

### Why not opencode too

opencode's text arrives already stripped, so widening its trigger would render nothing new.
Rendering opencode markdown instead of stripping it is a plugin change with its own
trade-offs, tracked separately.

## Sanitizer change

Probing the live API showed one new hazard that only matters once rich is not table-only:
an ATX heading directly under a list item (`- done\n# Heading`) is absorbed into the item.
The sanitizer now puts a blank line before a heading line (outside fences) whose previous
line is not blank. Other probed cases need nothing: a single `~` is not strikethrough,
`+3 tests` is not a list, lists directly under a paragraph line start correctly, task-list
checkboxes render, and `#ext-channel` becomes a hashtag exactly as plain messages already do.

## Known limits

- A line indented four spaces outside a list becomes a code block. Agents rarely do this.
- Code renders without plain messages' inset bubble (Telegram styling).
- Bodies over 32768 characters still go plain in 4096-character chunks.

## Plan

1. `rich-markdown.ts`: `buildRichMarkdown(header, body, footer, { requireTable })` with
   `requireTable` defaulting to true; heading blank-line rule in `sanitizeBodyMarkdown`. Tests first.
2. `app.ts` `handleStopBody`: `requireTable: session.backendKind !== GOOSE_BACKEND_KIND`. Test
   through `POST /stop` and `POST /goose/turn-event`.
3. Docs: AGENTS.md "Tables render natively" section, this file.
4. Deploy: daemons only.

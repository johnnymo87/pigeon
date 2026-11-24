# Slack `/quote` Implementation Plan (pigeon-14uk)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** `/quote [N|prev|full …]` typed in a goose session's Slack channel posts that session's
trimmed replies (from honkd's `_honk/quote`) with an **Answer** button; the button opens a modal
with each passage read-only and an answer box under it; **Send** sends honk-shaped
`> quote / answer` text to the session as Jonathan's message.

**Design:** `docs/plans/2026-11-24-slack-quote-design.md` (decided; read its contract section).
honk side is honk-9qf.31.7 (not in this repo). Until honkd has `_honk/quote`, the command answers
"honkd on <machine> does not support /quote yet" — the pigeon side ships dormant.

**Tech:** TypeScript. Worker: Cloudflare Workers, D1, vitest-pool-workers (`fetchMock` for Slack).
Daemon: node, vitest. Run `npm run test` and `npm run typecheck` from the repo root before each
commit (or the package's own: `npm run --workspace @pigeon/worker test`, `… @pigeon/daemon test`).

**Conventions:** commit messages `[NO-JIRA] <Area>: <what> (pigeon-14uk)`. Never `git stash`,
`reset`, `checkout --`. Only `src/slack.ts` may name Slack's host (`slack-egress.test.ts`); call
Slack through `callSlack(token, method, args)`. D1 schema SQL must not contain `;` inside comments
(tests split on `;`). Every handler failure becomes a chat message; nothing throws out of a poller
callback (a throw skips the ack → redelivery for 24 h).

---

## Shared shapes

`_honk/quote` request/reply — exactly the design doc's contract:

```ts
// packages/daemon/src/goose/quote-types.ts
export type QuotePick = { kind: "since" } | { kind: "prev" } | { kind: "last"; n: number };
export interface QuoteRequest { sessionId: string; pick: QuotePick; full: boolean; tag?: string; quoteId?: string }
export interface QuoteReply {
  header: string;            // "# 11-24 13:05 (wake: mail) · ask"
  passages: string[][];      // verbatim, unquoted lines
  inProgress: boolean;
}
export interface QuoteResult {
  summary: string | null;
  replies: QuoteReply[];
  notices: string[];
  warnings: string[];
  empty: null | "no_replies" | "never_spoke" | "nothing_since" | "one_prompt" | "nothing_kept";
  model: string | null;
}
```

Stored quote (D1 `slack_quotes.payload_json`, and the `quote` field the daemon sends on
`/notifications/send`):

```ts
interface StoredQuote {
  v: 1;
  sessionId: string;
  passages: { header: string; lines: string[]; first: boolean }[]; // first = first passage of its reply
  total: number;            // passages before capping
}
```

Cap (daemon, before sending): at most `QUOTE_MAX_PASSAGES = 45` passages and 100 000 chars of
lines in total; `total` keeps the uncapped count. A passage over 2 900 chars is fine in storage;
the modal splits it across sections.

Wire names: command type `quote`; button `callback_data` `quote:<quoteId>`; modal `callback_id`
`quote_answer`, `private_metadata` `{"quoteId":"…","channelId":"C…"}`; answer inputs `block_id` `a<i>`,
`action_id` `answer`. Outbox ids: body `qt:<sessionId>:<quoteId>`, answer post
`qa:<sessionId>:<quoteId>`; `quoteId` = the worker command id (32 hex).

---

### Task 1: Daemon — `GooseAcpClient.quote` and the allowlist

**Files:** `packages/daemon/src/goose/quote-types.ts` (new), `packages/daemon/src/goose/acp-client.ts`
(`ALLOWED_ACP_METHODS` ~1670 and its comment block ~1640-1669, new method next to
`renameSession` ~1190), `packages/daemon/test/goose-acp-client.test.ts` (pin ~1460, new tests next
to the rename tests ~1553).

1. Tests first (FakePeer pattern from the rename tests):
   - allowlist pin now also contains `_honk/quote`;
   - `quote(req, {timeoutMs})` sends `_honk/quote` with params `{sessionId, pick, full, tag?, quoteId?}`
     (omit undefined keys) and resolves the validated `QuoteResult`;
   - a JSON-RPC error `-32601` (method not found) rejects with `QuoteUnsupportedError`;
   - any other error rejects with `GooseProtocolError` carrying the message;
   - a malformed result (missing `replies`, a passage that is not `string[]`) rejects with
     `GooseProtocolError("malformed _honk/quote result")`;
   - no reply within `timeoutMs` rejects with a timeout error (fake timers).
2. Implement. `private call()` has no timeout, so wrap with the existing `withDeadline` helper
   (find it in `session-runner.ts` / reuse or move to a util). Add the human-decision note:
   `Human decision (2026-11-24, Jonathan, pigeon-14uk): _honk/quote, sent only to honkd, reads the
   session's own transcript and makes one tool-less model call (honkd _honk/oneshot); it executes
   nothing.`
3. `npm run --workspace @pigeon/daemon test -- goose-acp-client` → pass; typecheck; commit.

### Task 2: Daemon — render the quote (pure)

**Files:** `packages/daemon/src/goose/quote-render.ts` (new), `packages/daemon/test/goose-quote-render.test.ts` (new).

Functions (pure, fully unit-tested):

- `flattenPassages(result): StoredQuote["passages"]` — reply order, then passage order; `first`
  true for each reply's first passage. In-progress replies included (their header already says so
  or append ` · in progress` if honk does not; test with `inProgress: true`).
- `capPassages(passages)` → `{passages, total}` per the cap above.
- `quoteBodyText(result, pickLabel, label)` → plain text for the body post:
  ```
  📋 /quote <pickLabel> · <label>
  <summary without the leading "# ", or "quoted in full">
  ⚠️ <each warning>
  ℹ️ <each notice>

  [1] 11-24 13:05 (wake: mail) · ask
  > line
  >
  > line
  [2] …            (a passage after a gap in the same reply: "[2] …" without repeating the header)
  ```
  Numbers match `flattenPassages` indices + 1. Blank source line → bare `>`.
- `quoteBodyMarkdown(...)` → the same as Slack-dialect GFM (header lines bold, quote lines as
  `> `), escaping per `sanitizeBodyMarkdown`/the existing markdown escape helper used for stops
  (find it in `rich-markdown.ts`); returns `null` when over `SLACK_RICH_MAX_CHARS`.
- `emptyText(result, pickLabel)` → one line per `empty` value, prefixed with notices, e.g.
  `nothing_since` → "Nothing has replied since your last message. Try /quote 3 or /quote prev.";
  `nothing_kept` → "The trim found nothing that needs you (/quote full shows everything).".
- `pickLabel(pick, full)` → "since your last message" | "since your previous message" |
  "last N" (+ " (full)").

Commit after tests pass.

### Task 3: Daemon — poller knows `quote`

**Files:** `packages/daemon/src/worker/poller.ts` (message interfaces ~201-368, union ~378,
`PollerCallbacks` ~394, `KNOWN_COMMAND_TYPES` ~665, dispatch ~710-740), `packages/daemon/test/poller.test.ts` (~389).

Add `QuoteMessage { commandId; commandType: "quote"; sessionId; chatId; messageThreadId?; metadata: { pick: QuotePick; full: boolean } }`,
`onQuote?: (msg) => Promise<void>`. Check `packages/worker/src/poll.ts buildCommandBody` sends
`metadata` for an unlisted type (it falls to the execute branch); if it sends it under another
key, map it. Malformed metadata → reply "Malformed /quote" via the same path other handlers use
and ack (never leave it un-acked). Test: dispatches `quote` to `onQuote` and acks. Commit.

### Task 4: Daemon — the `/quote` handler

**Files:** `packages/daemon/src/goose/quote-command.ts` (new), wire in `packages/daemon/src/index.ts`
(next to `onCompact` ~884), `packages/daemon/test/goose-quote-command.test.ts` (new).

`createQuoteHandler(deps)` returns `(msg: QuoteMessage) => Promise<void>`. Deps (injected, faked in
tests): `getSession(id)`, `createClient(url, token)` (as `createMintClient`, index.ts ~769),
`reply(text)` (from `createChatReplySender(sendChatMessage, msg)`), `upsertOutbox(input, now)`
(`storage.outbox.upsert`), `machineId`, `now()`, `log`.

Behaviour:
1. **Returns quickly.** Validates, then starts `run()` detached (`void run().catch(log)`) and
   returns, so the poller acks at once. Keep an in-memory `Set` of command ids seen in the last
   hour; a redelivered id is ignored.
2. Session missing → reply "Session not found". `backendKind !== "goose-acp"` → reply
   "/quote works only for goose sessions for now." No `backendEndpoint` → reply naming that.
3. Tag: `boundTopicKey` matching `stallwatch:<tag>` (reuse the parser in `tag-key.ts`) → `tag`;
   otherwise omit (honkd falls back to the session's own tag).
4. Open a **separate** client (`createClient(session.backendEndpoint, session.backendAuthToken)`),
   `connect()`, require `isHonk` (else reply "this session is on bare goose, not honkd; /quote
   needs honkd"), `quote({sessionId: backendSessionIdOf(session), pick, full, tag, quoteId: msg.commandId}, {timeoutMs: 600_000})`,
   always `close()` in `finally`. A separate socket keeps the runner's idle timer and turn state out
   of it; closing it cancels the honkd call.
5. `QuoteUnsupportedError` → reply "honkd on <machine> does not support /quote yet (needs honk-9qf.31.7)."
   Other errors → reply "/quote failed: <message>".
6. `result.empty` → reply `emptyText(...)`.
7. Otherwise upsert two outbox entries (template: the mirror enqueue in `app.ts` ~599-635; read
   `UpsertOutboxInput`):
   - body: `notificationId qt:<sid>:<cmdId>`, `kind "quote"`, payload
     `{messages: splitChatMessage(plain header, body, empty footer) mapped to {text, entities}, threaded: true, rich?: {markdown, dialect: "slack"}}`
     (no replyMarkup, so mention-link buttons still work on it);
   - answer: `notificationId qa:<sid>:<cmdId>`, `kind "quote"`, `afterNotificationId` = the body id,
     payload `{messages: [{text: "✍️ Answer <k> passage(s) from this /quote" (+ " — the first 45 of <total>" when capped)}], threaded: true,
     replyMarkup: {inline_keyboard: [[{text: "Answer", callback_data: "quote:<cmdId>"}]]},
     quote: StoredQuote}`.
   Check `OutboxSender` passes unknown payload fields through: it does **not** — add `quote` to the
   parsed fields (~803-840) and forward it on the last chunk's request (the answer entry has one
   chunk). Check ordering of an unknown kind (sorted last) is fine with `afterNotificationId`;
   add `"quote"` wherever kinds are enumerated if a test pins them.
8. Wire in `index.ts`: `onQuote: createQuoteHandler({...})`. Do **not** route through
   `handleGooseControl` (that refuses).

Tests: each branch above with fakes, including "returns before the quote call resolves"
(a deferred promise), dedupe of a repeated command id, close() called on success and failure, tag
derivation, the two outbox entries' exact shapes and ordering. Plus an `outbox-sender` test that
`quote` rides on the request. Commit.

### Task 5: Worker — parse `/quote`

**Files:** `packages/worker/src/chat/commands.ts`, its test (`packages/worker/test/chat-commands.test.ts` or wherever `parseChatCommand` is tested — grep).

Add `{ kind: "quote"; pick: QuotePick; full: boolean; target?: string }` to `ChatCommand`
(define `QuotePick` locally in the worker; do not import from the daemon).
Grammar (`all` = `full`): `/quote [<REF>] [full|all] [prev|<N>]`, N a positive integer ≤ 1000.
`/quote` → since; `/quote 5` → last 5; `/quote prev`; `/quote full`; `/quote full 5`; `/quote all prev`;
`/quote ses_xxxxxxxx 3`. Anything else starting with `/quote` → `{kind:"usage", command:"/quote"}`
(add to `SESSION_COMMAND_NAME_RE`) and add a `/quote [N|prev|full]` line to `SESSION_COMMAND_USAGE_TEXT`.
Tests for every form and for `/quote 0`, `/quote -1`, `/quote prev 3`, `/quote fulll`. Commit.

### Task 6: Worker — `/quote` slash command, manifest, pins

**Files:** `packages/worker/src/slack-inbound.ts` (`SLACK_APP_COMMANDS` :72, `handleCommand`
~663), `packages/worker/slack/manifest.template.json`, `packages/worker/test/slack-inbound.test.ts`,
`packages/daemon/test/slack-manifest-script.test.ts` (`COMMANDS` :33, test name "eight" :86).

In `handleCommand`, a `quote` branch: resolve `target` via `namedSession`, else
`channelContext` → `contextSession`, and **if that finds no session, try
`getBoundSessionByThread(db, chat, handle)`** (a coordinator's channel; check the bound session's
machine is recent like `contextSession`). Queue `commandType: "quote"`, `command: "/quote …"`
(the typed text), `metadataJson: JSON.stringify({pick, full})`. Reply **ephemeral**:
"⏳ Quoting <pick> for <label>. The trim can take a minute or two; the quote will be posted here."
Manifest: add `/quote` with `description` "Quote the session's replies so you can answer them",
`usage_hint` "[N|prev|full]", `should_escape: false`, same URL as the others.
Tests: queued row (type, metadata, thread handle) for a topic channel, for a bound coordinator
channel, for an explicit id; usage reply; unknown session reply; manifest/SLACK_APP_COMMANDS pins.
Commit.

### Task 7: Worker — store quotes from `/notifications/send`

**Files:** `packages/worker/src/d1-schema.sql`, `packages/worker/src/notifications.ts`
(`SendNotificationBody` :17, `handleSendNotification` :310), new
`packages/worker/src/slack-quotes.ts` (repo: `putQuote`, `getQuote`, `sweepSlackQuotes`),
`packages/worker/src/index.ts` (cron sweep next to `sweepSlackSeenEvents` ~233-245),
`packages/worker/scripts/slack-flip.mjs` table check is **not** needed (optional feature),
tests `packages/worker/test/slack-quotes.test.ts` + a notifications test.

Schema (no index beyond the PK plus one on `created_at` for the sweep — each index costs a D1
row written per insert):
```sql
-- Answer-modal data for /quote posts (pigeon-14uk). Kept 7 days, swept hourly.
CREATE TABLE IF NOT EXISTS slack_quotes (
  quote_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_quotes_created ON slack_quotes(created_at);
```
`handleSendNotification`: when `body.quote` is a valid `StoredQuote` (validate shape, `v === 1`,
`sessionId === body.sessionId`, payload JSON ≤ 200 000 chars) **and** the replyMarkup carries a
`quote:<id>` button, `INSERT OR IGNORE` the row **before** posting (so the button never exists
without its data; a retry is idempotent). Invalid `quote` → 400 (the daemon built it; a 4xx is
terminal and logged by the outbox). Missing table ("no such table") → log and post anyway (the
button then answers "quote expired"). `sweepSlackQuotes` deletes rows older than 7 days, 5000 per
run, logs and returns 0 on a missing table. Tests: stored on send, idempotent on retry, rejected
when invalid, sweep. Commit.

### Task 8: Worker — Answer button opens the modal

**Files:** new `packages/worker/src/slack-quote-modal.ts` (pure builders), `slack-inbound.ts`
`handleInteractivity` (~756; add `trigger_id` to `BlockActionsPayload`), tests
`packages/worker/test/slack-quote-modal.test.ts` + interactivity tests in `slack-inbound.test.ts`.

`buildAnswerModal(quoteId, channelId, stored, label)` (channelId = the channel the button was tapped in) → Slack view:
`{type:"modal", callback_id:"quote_answer", private_metadata: JSON.stringify({quoteId, channelId}), title:{type:"plain_text", text:"Answer quote"}, submit:{… "Send"}, close:{… "Cancel"}, blocks}`.
Blocks, in order, never more than 100:
- for each passage i (1-based): section(s) `mrkdwn`: `*[i]* <header without "# ">` (when `first`,
  otherwise `*[i]* …`) then the lines as `> ` quote lines, mrkdwn-escaped (`&`, `<`, `>` inside
  the line text — reuse the escape in `chat/slack-render.ts`); split into several sections so each
  is ≤ 3000 chars; then `{type:"input", block_id:"a<i>", optional:true, label:{plain_text "Your answer to [i]"}, element:{type:"plain_text_input", action_id:"answer", multiline:true}}`;
- stop adding passages when the next one would exceed 99 blocks; then a context block "Passages
  <n+1>–<total> are not shown; answer them in the thread." (also when `stored.total > passages.length`).

`handleInteractivity`: after the owner check, `value.startsWith("quote:")` → `getQuote`; missing →
`postEphemeral("This quote has expired. Run /quote again.")`; else
`callSlack(ws.botToken, "views.open", {trigger_id, view})` synchronously (3 s window), log a failure
and `postEphemeral` the Slack error. Return 200. Tests: view JSON for 1, 3 and 60 passages (block
cap), escaping, splitting a 7 000-char passage, the expired path, `views.open` called with the
trigger id. Commit.

### Task 9: Worker — modal submission sends the answer

**Files:** `slack-quote-modal.ts` (`composeAnswer`), `slack-inbound.ts` (`handleInteractivity`:
handle `payload.type === "view_submission"` **before** the `block_actions` early return), tests.

`composeAnswer(stored, answers: Map<number,string>)` → text: for each passage with a non-blank
answer, in order: the reply header line (exactly `header`, e.g. `# 11-24 13:05 (wake: mail) · ask`)
when it differs from the last header written, the passage's lines as `> line` (bare `>` for
blank), then the answer (trimmed of trailing whitespace); passages separated by a blank line.
Unanswered passages are dropped. All blank → `null`.

Submission flow (`callback_id === "quote_answer"`), synchronous and fast (Slack wants a reply in
3 s, and a slow reply invites a second tap):
1. team check (as today), **owner check** `payload.user.id === ws.ownerUserId` (else 200 `{}`).
2. `quoteId` from `private_metadata`; `getQuote`; missing → `{response_action:"errors", errors:{a1:"This quote has expired. Copy your answers and run /quote again."}}` (block_id of the first input).
3. Answers from `payload.view.state.values["a<i>"].answer.value`.
4. `composeAnswer` null → errors on `a1`: "Type an answer under at least one passage."
5. Length > `MAX_COMMAND_LENGTH` → errors on the first answered block: "Too long to send
   (<n> of 10000 characters). Shorten an answer or answer fewer passages."
6. Target session: from `channelId` in `private_metadata`: the channel's handle
   (`channelHandle`), then its `topics` row session, else `getBoundSessionByThread` — so an answer
   in a coordinator channel reaches the *current* coordinator even if it was rotated since the
   quote. None found → the quote's `session_id` if it still exists in `sessions`, else errors
   "That session has ended." If the resolved session differs from the quote's, prefix the copy
   post with "(the quoted session was replaced; sent to the current one)".
7. One `db.batch([seenInsert(db, "view:" + payload.view.id), touch, commandInsertStatement(db, {machineId, sessionId, command: text, chatId, commandType:"execute", metadataJson: JSON.stringify({senderId: payload.user.id}), messageThreadId: handle})])`;
   a seen-conflict → 200 `{}` (duplicate tap).
8. Return `{response_action:"clear"}`; in `ctx.waitUntil`, post the copy into that channel:
   `🧑 via /quote\n<text>` via `postInChannel`.
Tests: owner refusal, expired, blank, too long, queued command (type, senderId, text), duplicate
view id ignored, copy posted. Commit.

### Task 10: Docs

Update: `AGENTS.md` (Commands: app command list `:329`, table row for `/quote`, a short
"`/quote` (pigeon-14uk)" paragraph: flow, honkd `_honk/quote` requirement, `slack_quotes` table
+ schema-before-deploy, the allowlist human decision, coordinator tag pass-through, deferred
items), `.agents/skills/worker-architecture/SKILL.md` (command list + interactivity
`quote:`/`view_submission`), `.agents/skills/worker-parity-checks/SKILL.md:40` command list,
`docs/runbooks/slack-workspace-setup.md` command list (`:112`) and a note that adding `/quote`
to a live app is a manifest edit without reinstall, `.agents/skills/daemon-architecture/SKILL.md`
if it lists command types. Commit.

---

## Deploy (after merge)

1. Apply `packages/worker/src/d1-schema.sql` to D1 (`npx wrangler d1 execute pigeon-router --remote --file packages/worker/src/d1-schema.sql`, from `packages/worker`), check `slack_quotes` exists.
2. Daemons first (`scripts/deploy-daemon.sh` on cloudbox, devbox, macbook — `--dry-run` first): an old
   daemon would leave a `quote` command un-acked.
3. Worker (`npm run --workspace @pigeon/worker deploy`), `/health`.
4. Each Slack app's manifest gains `/quote` (render with `slack-manifest.mjs render <m>`, apply via
   `apps.manifest.update` if a config token is at hand, otherwise this is Jonathan's paste ×3).
5. Until honk-9qf.31.7 is deployed, `/quote` answers "does not support /quote yet". Verify end to end
   in a coordinator channel once it is.

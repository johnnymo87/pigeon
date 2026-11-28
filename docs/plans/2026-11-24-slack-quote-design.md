# Slack `/quote` (pigeon-14uk) — options

Status: **decided 2026-11-24** — Jonathan: "go with the recommendations" (1.1 `/quote` slash
command, 2a post + Answer button → answer modal, 3a session-wide, 4a honkd `_honk/quote`,
including his OK to add `_honk/quote` to pigeon's `ALLOWED_ACP_METHODS`). Contract below.

Jonathan (2026-11-24, honk pigeon channel): "this /quote stuff is working great and i need
something like it in slack, the interface i use to communicate with you via pigeon when I'm on
the go".

honk's `/quote` (honk `docs/chat.md`, `/quote` rows and `_honk/oneshot`; epic honk-9qf.31):
quote the coordinator's replies since his last prompt as `> ` lines, trimmed by goose's default
model to what needs him (line numbers only, so every `> ` line is the agent's own words; `#`
lines are honk's), into the composer, where he types his answers under the quotes.
Forms: bare, `N`, `prev`, `full [N|prev]`.

## What exists today (facts the options rest on)

- **Slack has no composer prefill.** Nothing a bot does can put text into his message box.
  The only editable, prefilled text box Slack offers a bot is a **modal** (`views.open`) with a
  multiline `plain_text_input` whose `initial_value` is set: at most **3000 characters per
  box**, at most 100 blocks per modal, opened only with a `trigger_id` (from a slash command,
  shortcut or button) **within 3 s**, updatable afterwards with `views.update`.
- **Slash commands do not work in threads** (Slack limit; already true of `/model` etc.).
- **pigeon has no transcript.** The daemon never reads a goose session's history; it keeps turn
  text for an hour in the outbox. The worker's `slack_posts` holds posted chunks for 30 days, but
  they are split/rich-rendered, capped at 64 KB per turn, and carry no trigger (human vs wake vs
  swarm). The prompts pigeon sends to honkd carry no "this is Jonathan" marker either; honk tells
  them apart by text shape (`honk_wire::classify`: `[sw wake …]`, `<swarm_message …>`, plain
  text = you).
- **The trim lives in the honk client**, not honkd: `crates/honk/src/tui/quote.rs` (pick the
  replies) and `trim.rs` (700 lines: system prompt, numbered-line prompt, 100 KB batches four at a
  time, JSON validation, merge, fallbacks). `_honk/oneshot` is only the model call.
- **pigeon's honkd client is allowlisted** (`ALLOWED_ACP_METHODS`,
  `packages/daemon/src/goose/acp-client.ts`); each added method is a recorded human decision.
  No `_honk/*` method is on it.
- **The Slack app** has `commands`, `chat:write`, `channels:history`, interactivity on, events
  `message.channels` only, no shortcuts, no reactions, no DMs. A new slash command or shortcut is
  a manifest edit pasted into each of the three apps (no reinstall); a new **scope** needs a
  reinstall.
- **Slash commands typed in a coordinator's (bound named) channel don't resolve a session
  today**; only plain messages do. `/quote` must resolve the bound session too.

Scope: goose sessions behind honkd (coordinators, honk-launched sessions). opencode session
channels are out of v1 (no honkd; their history would need opencode's message API).

## Decision 1 — trigger

1. **Slash command `/quote [N|prev|full …]`, typed in the session's channel. Recommended.**
   Same words and forms as honk, one line to type, no new scope. Can't be typed inside a
   thread (Slack), which is fine: the result doesn't depend on where it was typed.
2. **Message shortcut "Quote from here"** (long-press a coordinator post → ⋯ → shortcut).
   Works in threads, gives a `trigger_id`, and names an explicit start point (Decision 3c).
   Costs a manifest `shortcuts` entry and `message_action` handling. Good **add-on later**,
   not a substitute: three taps where `/quote` is one line, and no `N`/`prev`/`full`.
3. **Reaction** (e.g. 💬 on a coordinator post = "quote from here"). One tap and works on any
   post, and with landing 2a it needs no `trigger_id`. But no arguments, invisible to anyone
   who doesn't know the convention, and needs `reactions:read` + the `reaction_added` event
   (a new scope: reinstall of all three apps).
4. **DM the app.** Needs the App Home messages tab and `im:*` scopes, and the DM has no session,
   so he'd have to name one. Worst fit.

## Decision 2 — where the result lands

The trim takes seconds to a few minutes, and on a phone he will often leave Slack meanwhile.
That favours landing the result as a **post** (persistent, notifies him) and opening any modal
only afterwards, from a button, when the quote is ready.

a. **Post + "Answer" button → answer modal. Recommended.** When the trim is done, pigeon posts
   the quote in the channel: the `#` summary, then numbered passages `[1] # 11-24 13:05 (wake:
   mail) · ask` with the reply's own lines as Slack quotes. Under it, an **Answer** button. Tap
   it and a modal opens at once (the data is ready, so the 3 s `trigger_id` window is no
   problem): each passage shown read-only, with an empty optional answer box under it. He types
   answers under the passages he wants, taps **Send**, and pigeon composes exactly honk's shape
   (`> ` lines of each answered passage, his answer under it; unanswered passages dropped) and
   sends it to the session as his prompt, plus a `🧑 via /quote` copy in the channel. No copy,
   no paste, no moving a cursor through prefilled text, and the quoted lines can't be altered.
   If he closes the modal, the post is still there; tap Answer again.
b. **Post only; answer in its thread.** Same post, no button. He replies in the post's thread
   (`1 yes, 3 hold off`); pigeon already attaches the thread parent to the prompt (today capped
   at 500 chars, which a quote post would lift). Simplest to build and fine for short answers,
   but his answers are not interleaved under the quotes. (a) includes this for free: a thread
   reply to the quote post works either way.
c. **Modal opened by `/quote` itself, prefilled editable boxes** (one box per reply, `> ` lines
   prefilled, he types between them). Closest copy of honk's composer, but the modal sits on
   "Trimming…" for up to minutes and is lost if he leaves the app; editing inside 3000-char
   prefilled boxes is fiddly on a phone; and it needs view ids, `hash`-guarded updates and a
   stuck-view story.
d. **A post he copies from** (long-press → Copy text, paste, edit in the composer). Whether
   mobile Slack keeps the `>` markers on copy is unverified. Not recommended.
e. **Ephemeral ("only visible to you").** Lost on app reload; limited actions on mobile.
   Not recommended.

Common limit: today a message sent to a session is capped at 10,000 chars
(`MAX_COMMAND_LENGTH`). With (a) and (b) only answered passages plus his words are sent, which
is almost always far below that; a send over the cap is refused **in the modal, with his
text still in it**, never after he loses it. Raising the cap is possible but touches the D1
command row and the daemon path, so it is not proposed.

## Decision 3 — what "since my last message" means on Slack

a. **Session-wide, from honkd's transcript. Recommended.** All his prompts reach the same goose
   session, whether typed in the channel, in a thread under a coordinator post, or in honk chat,
   and pigeon posts the coordinator's replies top-level in the channel regardless. So "his last
   prompt" is his last prompt *to the session*, wherever he typed it — identical to honk's
   `/quote`, and `/quote` in Slack and in honk agree. Wakes, swarm messages, scheduled prompts,
   goose-written prompts and `/compact` don't count, as in honk. A reply typed in a thread
   reaches goose prefixed `[Replying to this earlier message …]`; it still counts as his.
   Known edges, same as honk: a coordinator that was rotated has none of his prompts, so it
   falls back to the last 3 replies (the post says so); plain-text prompts an agent wrote (a
   `/launch` prompt, a plain stall-watch kickoff) count as his, since nothing marks them.
b. **Per Slack thread.** Doesn't map: coordinator replies are not threaded under the prompt
   that caused them, so a thread holds his messages but not the answers.
c. **Explicit anchor:** with the shortcut (Decision 1.2), "from this post to now". Natural on a
   phone; needs mapping a Slack post back to a honkd turn (by time). An add-on to (a).

## Decision 4 — engine (how pigeon gets the history and the trim)

a. **A new honkd RPC, `_honk/quote {sessionId, pick: since|n|prev, n?, full?, tag?}` →
   `{passages:[{header, tag, lines}], summary, warnings, model}`. Recommended.** honk moves the
   pick and the trim into honkd, so honk chat and pigeon run one implementation and can't drift.
   Honest size of the honk work: honkd stores raw ACP frames, and turning them into replies is
   today done by honk's client (`transcript.rs`), so honkd needs that reconstruction too; it
   should read the on-disk log rather than load an idle session into goose; the "same replies
   reuse the last answer" cache moves into honkd; and it takes an explicit spend `tag` (see
   below). pigeon's daemon calls it over its existing honkd socket. **This is a honk change**
   (a bead for the honk coordinator) **and adds one method to pigeon's honkd allowlist, which
   needs your OK**: it reads the session's own transcript and makes a tool-less model call; it
   executes nothing.
b. **pigeon reimplements it:** replay the transcript with `session/load` (already allowed),
   port `classify`, turn reconstruction, the pick and the 700-line trim to TypeScript, and call
   `_honk/oneshot` (an allowlist addition all the same). No honk work, but two copies that will
   drift. Only worth it if honk can't take the work soon.
c. **Slack history / `slack_posts`.** Wrong source (chunked, rendered, truncated, no
   triggers, misses replies posted elsewhere). Rejected.

**Spend attribution (applies to honk's own `/quote` too).** `_honk/oneshot` copies the quoted
session's session-tags tag. A stall-watch coordinator is tagged `stall-watcher-runs`, so a quote
of a coordinator would be charged there, not to its program. pigeon knows the program from the
channel binding (`stallwatch:<tag>`) and passes it as `tag`; honk chat has the same bug today,
which goes in the honk bead.

## How the recommended path works (1.1 + 2a + 3a + 4a)

```
/quote prev ─► worker /slack/<m>/commands
                 resolve session: topics row, else the channel's bound coordinator; goose only
                 ephemeral ack "quoting…"; queue D1 command type=quote {pick, program tag}
daemon poll ─► start the trim detached and return (the poll loop runs one command at a time;
               a minutes-long await would hold every session's commands), ack; dedupe by
               command id so a redelivery never trims twice
               honkd _honk/quote(...)  → post through the durable outbox (retried):
                 numbered passages + [Answer] button; failure → a post saying why
                 (honkd down, bare goose not honkd, nothing since your prompt, untrimmed + warning)
[Answer]   ─► worker block_actions (owner check) → views.open with passages read-only + answer boxes
                 (passages kept in D1 by quote id; the button value is only the id)
Send       ─► worker view_submission: owner = payload.user.id, target re-resolved from the
                 channel now (a rotated coordinator gets the answer, with a note), dedupe on
                 view id, compose "> passage / answer", refuse >10k in the modal,
                 queue as his message (same path as typing), 200 at once;
                 "🧑 via /quote" copy posted in waitUntil
```

Slack app changes: one slash command `/quote` in `manifest.template.json`, pasted into the three
apps' manifests (no new scope; the interactivity URL already exists). A shortcut, if chosen, is
one more manifest entry; a reaction trigger is a new scope and a reinstall of all three.
Deploy order: honk's `_honk/quote`, then daemons, then the worker. A button on the quote post
means the post carries its own keyboard, which today switches off pigeon's mention-link buttons
for that post; the two get merged.

Unverified until tried on his phone: how a modal with many read-only passages and boxes
scrolls on iOS. Cheap to check with a mock modal before the honk work lands.

## What Jonathan decides

1. **Trigger:** `/quote [N|prev|full]` slash command (rec.) / message shortcut / 💬 reaction / DM.
   Optionally a shortcut or reaction later as "quote from this post".
2. **Landing:** post + Answer button → answer modal (rec.) / post, answer in thread /
   `/quote` opens a prefilled editable modal / post to copy / ephemeral.
3. **"Since my last message":** session-wide, as honk (rec.) / per Slack thread / explicit anchor post.
4. **Engine:** honkd `_honk/quote` (rec.; honk work, plus your OK for one method on pigeon's
   honkd allowlist) / pigeon ports the trim.

## `_honk/quote` contract (for the honk bead)

JSON-RPC request on a honkd viewer connection (pigeon's existing per-session socket):

```jsonc
{ "sessionId": "<goose session id>",
  "pick": { "kind": "since" } | { "kind": "prev" } | { "kind": "last", "n": 5 },
  "full": false,            // true = untrimmed, no model call (honk's /quote full)
  "tag": "pigeon",          // optional session-tags tag for the oneshot's spend; overrides tagFrom
  "quoteId": "<opaque>" }   // optional; "_honk/quote/cancel {quoteId}" cancels, as oneshot
```

Reply: honk's own pick and trim, as structured data instead of composer text, so pigeon can
number passages and put an answer box under each without reparsing `#` lines:

```jsonc
{ "summary": "# honk: trimmed by claude-opus-5-5, kept 12 of 80 lines from 3 of 5 replies",
                            // honk's first '#' line; null when nothing was trimmed
  "replies": [
    { "header": "# 11-24 13:05 (wake: mail) · ask",   // exactly as honk's composer shows it
      "passages": [["line", "", "line"], ["line"]],   // kept runs of verbatim reply lines,
                                                      // oldest first; honk's "# …" sits between
      "inProgress": false } ],
  "notices": ["…"],         // what honk would show as notices (e.g. fell back to the last 3)
  "warnings": ["…"],        // e.g. trim failed, quoted in full; 2 of 5 calls failed
  "empty": null,            // or "no_replies" | "never_spoke" | "nothing_since" | "one_prompt"
                            //    | "nothing_kept", with the reason also in notices
  "model": "claude-opus-5-5" }
```

Lines are unquoted (pigeon adds `> `). Unknown session → a JSON-RPC error. Requirements beyond
honk chat's `/quote`: reads the session's log without loading an idle session into goose; the
"same replies reuse the last answer" cache lives in honkd; `tag` overrides `tagFrom` (fixes the
`stall-watcher-runs` attribution for honk chat's `/quote` too, if honk chat passes its program).
Timeout: honk's per-call 90 s budget, batches as today; pigeon waits up to 10 min.

---

## Addendum: Notes-guided `/quote` (pigeon-exmt, 2026-11-28)

Jonathan (2026-11-28, pigeon program channel): pass free-text notes he took while reading to
`/quote` so the trim model uses them as a **floor** (selecting every passage his notes respond to
while still thinking critically to select anything else that needs him), matches each note to its
passage, and pre-fills the Answer modal — without silently dropping notes that match no passage.

### 1. Slack command syntax (`packages/worker/src/chat/commands.ts`)

```
/quote [<session-id>] [full|all] [prev|N] [--|—] [<notes>]
```

- **Direct free text on a phone:** `/quote approve PR 264, hold off on deploy` and
  `/quote 3 approve PR 264` work without requiring a separator.
- **Multi-line notes:** Newlines and internal whitespace in `<notes>` are preserved verbatim
  (e.g. pasting a bullet list after `/quote\n` or `/quote 3\n`).
- **Explicit `--` separator (and iOS em-dash `—`):** Matches honk chat's `/quote [N|prev] -- <notes>`
  and escapes notes that happen to start with a number (`1..1000`), `prev`, `full`, or `all`.
- **Guarding `full`/`all` against prose:** `full` and `all` are consumed as the `full: true` flag
  only when followed by end-of-string, newline, `--`/`—`, `prev`, or `1..1000`. So
  `/quote all good, ship it` parses as `pick: since, full: false, notes: "all good, ship it"`.
- **Bare malformed flags still answer with usage:** `/quote 0`, `/quote -1`, `/quote 1001`,
  `/quote ses_abc`, `/quote full 0`, and bare `/quote --`.
- **Cap:** `notes` is capped at 16,000 characters in the worker (Slack's own slash-command box
  caps around ~4,000 characters).
- **Ephemeral ack:** appends `(with notes)` to the pick label when notes are present.
- **Manifest:** `usage_hint` in `manifest.template.json` updated to `"[N|prev|full] [notes]"`
  (cosmetic; no app manifest re-paste is needed for `/quote <notes>` to work).

### 2. `_honk/quote` contract extension (agreed with honk-9qf.31.8)

Additive and backward-compatible:

- **Request:** optional `notes?: string` (omitted when absent or whitespace-only).
- **Reply:**
  - `replies[i].passages: string[][]` unchanged.
  - `replies[i].prefills?: (string | null)[]` — optional, parallel to `passages` (same length
    when present; `prefills[j]` is the draft answer for `passages[j]`, or `null` if none).
    Omitted when no passage in that reply has a prefill.
  - `unmatchedNotes?: string[]` — optional, notes that matched no kept passage, in original
    order. Omitted when empty.
- **Deploy-skew invariant:** honkd guarantees that whenever `notes` is non-empty, the reply has
  either at least one non-null `prefill` or non-empty `unmatchedNotes`. If pigeon sent non-empty
  `notes` and receives neither (e.g. an older honkd that ignored `notes`), the daemon adds a
  warning and carries the raw `notes` in `unmatchedNotes` so nothing is ever silently dropped.

### 3. Stored quote & channel posts (daemon + worker)

`StoredQuote` keeps `v: 1` with three optional additive fields:
- `StoredQuotePassage.prefill?: string` (omitted when null/absent).
- `StoredQuote.unmatchedNotes?: string[]` (omitted when empty).
- `StoredQuote.notesRaw?: string` (the exact notes as typed, omitted when absent).
- `StoredQuote.passages` may be empty only when `unmatchedNotes` is non-empty (so an `empty`
  result like `nothing_since` with notes still offers an Answer modal prefilled with those notes).
- **No silent loss on capping or failures:** If `capPassages` drops passages past the 45-passage /
  100k-char cap (or truncates a prefill past 3,000 chars), the dropped prefill/tail is appended to
  `unmatchedNotes`. Every failure/refusal reply (worker or daemon) appends the user's raw notes
  (with broadcasts defused) so notes typed on a phone are never lost on an error.
- **Body post (`qt:`):** Shows `📝 draft: <prefill>` under each prefilled passage and an
  `Unmatched notes (carried into Answer modal):` section at the bottom when `unmatchedNotes` is
  non-empty (broadcasts defused; markdown-escaped in rich mode).
- **Answer button post (`qa:`):** Reports counts when present, e.g.
  `✍️ Answer 3 passage(s) from this /quote (2 prefilled, 1 unmatched note)`.

### 4. Answer modal & submission (`packages/worker/src/slack-quote-modal.ts`)

- **Original notes visible:** When `notesRaw` is present, a read-only `"*Your notes as typed:*"`
  section is shown at the top of the modal so Jonathan can verify any drafted prefills against his
  original wording before tapping Send.
- **Per-passage prefill:** Sets `initial_value` on each passage's `plain_text_input` when
  `passage.prefill` is non-empty, and labels it `Your answer to [i] (draft from notes)`.
- **Slack 3,000-char `initial_value` limit:** If a passage prefill exceeds 3,000 characters, it is
  split (surrogate-pair safe) and the tail is carried into the unmatched notes boxes so nothing is
  silently truncated.
- **Unmatched notes boxes (`block_id: "general"`, `"general2"`, …):** Added at the end of the
  modal when `unmatchedNotes` is non-empty (or when any passage omitted by the 100-block modal cap
  carried a prefill, or a prefill overflowed 3,000 chars). Multi-line notes are separated by a
  blank line (`\n\n`) and split across as many ≤3,000-char boxes as needed so long notes are never
  cut off. The exact number of header + notes boxes is reserved up front so total blocks stay
  ≤100.
- **Submission (`composeAnswer`):** Reads `a1..aN` and all `general*` boxes in order. Appends
  `# Other notes\n<text>` at the end when passage answers are also present, or sends `<text>` alone
  when only general boxes are filled. Validation error block uses `"a1"` when passages exist and
  `"general"` otherwise so Slack never rejects an error targeting a nonexistent block.

### 5. Deploy order

`honk` (`honk-9qf.31.8`) → `daemons` (`cloudbox`, `devbox`, `macbook`) → `worker`. Deploying
daemons before the worker is required: an older daemon ignores unknown `metadata.notes` and would
silently drop notes after the new worker acknowledged `(with notes)`. A new daemon against an old
worker is completely safe (an old worker never sends `notes`).

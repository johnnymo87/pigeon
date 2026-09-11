# Tagging a session at `/launch` time (Telegram)

Bead: `pigeon-vlsj`. Prior art: workstation PR #491 (`opencode-launch --tag`), plus
its follow-ups #493 / #494.

## The gap

`oc-tags` charts list-price consumption per tag, and every session always has
exactly one tag: an untagged session falls back to a directory-derived `auto:`
tag (`auto:pigeon`, `auto:mono/some-worktree`). Roughly two thirds of the dollars
sit in primary-root sessions whose directory says nothing about what the work
was. A session launched from Telegram knows what it was launched to *do* at the
one moment that knowledge is free to record; today it is discarded and
reconstructed by hand weeks later from `oc-tags top`.

Tagging at launch is therefore an **override, not a creation** — it converts the
session off its `auto:` fallback.

## Surface

```
/launch <machine> <dir> --tag <tag> <prompt>
```

`--tag` is optional and positional-adjacent: it is recognised only as the first
token of the prompt tail, immediately after the directory.

### Why not the alternatives

- **`#tag` sigil** (`/launch devbox pigeon #fbm fix the thing`). Shortest to type,
  and rejected as a correctness bug. The prompt is free text, and a prompt that
  legitimately begins with a `#`-number — `#4231 is failing, fix it` — is ordinary
  in this repo. `4231` passes `isValidTag`, so that prompt would be *silently*
  shortened and charted under a nonsense tag. Silent text loss in the payload is
  the worst available failure.
- **`/launch:<tag> <machine> <dir> <prompt>`**. Unambiguous against the prompt,
  because the tag rides the command token. But Telegram's bot-command entity stops
  at the colon, so autocomplete breaks; and the token is exactly what
  `parseTelegramCommand` inspects for the `@BotName` suffix, so `/launch:fbm@bot`
  adds a second dimension to a parser whose whole job is refusing commands
  addressed to other bots. Too much blast radius for a few saved keystrokes.
- **Do not extend `/launch`; reply `/tag <tag>` to the launch confirmation.**
  This does *not* work today, contrary to the obvious assumption. The daemon posts
  the launch confirmation through the raw Telegram API (`daemon/src/index.ts`),
  while the `messages` table that `resolveReplySession` consults is written only by
  the worker's `/notifications/send` — so a swipe-reply to that confirmation misses
  Try 1 and falls through to Try 2, **topic membership**, which tags whatever
  session owns the topic the `/launch` was typed in. In the General topic it
  answers "Could not find a session for that message"; inside another session's
  topic it silently tags the *wrong* session. Filed separately (`pigeon-j6f9`);
  either way it is a second round trip on a phone at the moment attention has
  already moved on, which is precisely the bookkeeping step that is not happening
  today.

What is traded away, stated honestly: `--tag` is six characters of typing on a
phone, and a prompt whose *first* token is the literal string `--tag` is
misparsed. The **mechanism** is the same one that disqualifies `#tag` — a
plausible-looking token gets eaten and the prompt is silently shortened
(`/launch devbox pigeon --tag is broken, fix it` tags `is`). The difference is
purely **base rate**: a prompt beginning `#4231 ...` is ordinary in this repo,
a prompt beginning with the literal `--tag ...` is not. That is a real, if small,
hole and no parser can close it without banning legitimate tags. Near-miss
spellings (`--tag=fbm`, `-t`, `--Tag`, and the em dash iOS smart punctuation
produces from `--`) are *not* in the hole: any first tail token that begins with
a dash-like character is answered with usage, since a real prompt never starts
that way.

## Flow

1. **Worker** (`launch-command.ts`, new; `webhook.ts`) parses
   `/launch <machine> <dir> [--tag <tag>] <prompt>`, validating the tag with the
   existing `isValidTag` from `tag-command.ts`. A malformed `/launch` replies with
   usage rather than falling through to the plain-message path — a typo becoming a
   prompt injected into a live session is worse than any parse error (the same
   reasoning `/tag` already carries). The tag travels in `metadata_json`; the
   `command` column keeps holding the prompt.
2. **Worker `poll.ts`** puts `tag` on the launch payload.
3. **Daemon** (`launch-ingest.ts`) re-validates the tag with the daemon's own
   `isValidTag` (from `tag-ingest.ts`, same package — not a third copy). The
   daemon reads a D1 row, not the worker function's return value, so the side that
   spawns a process validates its own input.

   Two things about that check are load-bearing. It must be
   `tag !== undefined && !isValidTag(tag)`: `tag` is absent on every ordinary
   `/launch`, and on a corrupt `metadata_json` (which `poll.ts` turns into `{}`),
   and `isValidTag(undefined)` is false — so a bare `!isValidTag(tag)` would
   refuse **every untagged launch**. And an invalid tag *launches anyway* with
   `🏷 Tag not applied: invalid tag`, rather than refusing: "tagging never costs a
   launch" is the governing rule, the daemon-side path is reachable only through a
   tampered D1 row (whoever holds the API key can already queue any launch they
   like, so refusing buys no security) or through regex drift between the two
   copies, where refusing would reject a tag the worker had just accepted. The
   "a typo costs nothing" property is delivered by the worker, which refuses to
   queue at all — before anything is created.
4. **Order: after `createSession`, after `sendPrompt`, after auto-attach.** Safe
   because oc-tags attribution is retroactive — verified in `oc_tags.py`:
   `aggregate()` takes `session_tags`/`dir_tags` as read-time arguments and joins
   them against message costs, and `session_tag.created_at` is written but never
   read for attribution. A tag written a second late still covers every dollar the
   session ever spends. There is no race to win by tagging earlier, only a launch
   to risk.
5. `oc-tags set <tag> <session-id>` — **tag first**. Reversed, oc-tags tags a
   session literally named `ses_...` and reports success. Spawned as argv through
   the existing `OcTagsRunner`, never a command string, so shell metacharacters
   are inert; the live hazard is argument injection (a tag named `--dir`), which
   the leading-alphanumeric rule in `isValidTag` blocks.

## Failure handling

Tagging must never cost a launch, and nobody reads stderr on a phone, so every
outcome is a line in the one Telegram confirmation:

| Case | Reply line |
|---|---|
| success | `🏷 Tagged session 'ses_x' as 'fbm'` — oc-tags' own line, because oc-tags lowercases (`--tag FBM` charts as `fbm`) and a line we composed ourselves would name a tag the chart never shows |
| invalid tag (tampered row / regex drift) | `🏷 Tag not applied: invalid tag <tag>` — no spawn |
| oc-tags not installed | `🏷 Tag not applied: oc-tags is not installed on <machine>.` |
| timeout / killed child | `🏷 Tag not applied: oc-tags timed out after 20s.` |
| spawn failure (ENOENT/EACCES) | `🏷 Tag not applied: spawn /nix/.../oc-tags ENOENT` |
| non-zero exit | `🏷 Tag not applied: <last line of stderr>` — a locked `tags.db` raises `OperationalError`, which escapes `cmd_set`'s `except ValueError` and prints a 20-line traceback whose *last* line is the only useful one |

Distinguishing the timeout from a spawn failure needs code: `execFile` reports a
timeout kill as `{code: null, killed: true, signal: "SIGTERM"}` with the message
`Command failed: <argv>` — the word "timeout" appears nowhere in it, so the naked
`err.message` (which is what `tag-ingest`'s `runOrExplain` prints today) reads as
a generic failure. The classifier therefore lives in `oc-tags.ts`
(`describeOcTagsFailure`), and `/tag`'s `runOrExplain` was switched to it in the
same change, so the same failure is not worded two ways.

"Never costs a launch" is exact about the launch and loose about what follows
it: the tag runs before the confirmation is sent and before the poller acks, so a
hung oc-tags delays both by up to the runner's timeout, and holds that daemon's
poll loop for the same 20s. The lease is 60s and the preceding HTTP calls are
bounded at 30s each, so the worst case is arithmetic worth stating rather than a
realistic operating point — but it is why the timeout is bounded at all.

The timeout is the runner's shared 20s, sized for `oc-tags top`. Measured on
cloudbox, `set` against a 9.2 GB `opencode.db` with 12,355 sessions takes ~100 ms,
and a contended sqlite is bounded by oc-tags' own `busy_timeout=5000` (twice —
`opencode.db` read, then the `tags.db` write). So 20s is a backstop that nothing
short of a pathological host reaches, and it is not worth a second timeout
constant to shave.

In every non-success case the session is already created and prompted, and the
confirmation still names the session id and directory. The whole tag branch sits
in its **own** `try`/`catch`, which is the only mechanism that makes "cannot
throw" true — and both placements are wrong without it. Inside the existing
launch `try`, a throw is caught by the handler that replies
`Failed to launch session…`, which would be a flat lie about a live, prompted
session. Outside it, a throw propagates to the poller, which skips the ack, and
the redelivered `launch` is a **duplicate session** — far worse than a missing
tag row.

## Version skew

**Deploy daemons first, then the worker.**

- New worker, old daemon: `tag` is ignored and the session launches untagged. The
  only authoritative confirmation that a tag was applied is the daemon's `🏷`
  line — the worker's `Launching on …` ack is sent before the daemon has seen the
  command, so it can promise nothing. A missing `🏷` line means an old daemon.
- Old worker, new daemon: the old worker has no `--tag` parse, so `--tag fbm`
  lands verbatim at the front of the prompt. Ugly, harmless, and self-correcting
  on the worker deploy.

Both directions degrade to "launched, not tagged". Neither can lose a launch.

## Guardrails on the surrounding positions

`--tag` in the *wrong* position is the likely mistake, because the workstation CLI
takes its flags first. `/launch --tag fbm devbox pigeon x` would otherwise answer
"`--tag` is not recently seen", and `/launch devbox --tag fbm pigeon x` would
create a session in `~/projects/--tag`. Both are answered with usage: a machine id
or directory beginning with a dash is rejected. A tag that looks like a session id
is rejected too, mirroring `/tag`.

## Testing

vitest, following the existing `launch-ingest` / `tag-ingest` / `worker.test.ts`
patterns. The `oc-tags` runner is injected, so no test spawns a real `oc-tags`
and nothing touches `~/.local/share/oc-tags/tags.db`. The Telegram reply text is
the assertion in each failure case, because on this surface the reply *is* the
error channel.

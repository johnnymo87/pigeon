# Pigeon Agent Guide

This repo uses agent skills in `.opencode/skills`.

Use this file as the quickstart and table of contents for agent-facing docs.

## Quickstart

- Install deps: `npm install`
- Run all tests: `npm run test`
- Run all typechecks: `npm run typecheck`
- Worker package path: `packages/worker`
- Daemon package path: `packages/daemon`
- OpenCode plugin package path: `packages/opencode-plugin`
- Worker health (deployed): `curl https://ccr-router.jonathan-mohrbacher.workers.dev/health`
- Daemon health (local): `curl http://127.0.0.1:4731/health` (anonymous by design)
- OpenCode serve health (local): `curl http://127.0.0.1:4096/global/health`
- Swarm route exists (local): `curl -s -X POST -H 'content-type: application/json' -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" http://127.0.0.1:4731/swarm/send -d '{}'` → expect `{"error":"from is required"}` (NOT 404)
- Deploy worker: `npm run --workspace @pigeon/worker deploy`
- Deploy daemon/plugin: `git pull`, then **separately** `npm install`, then restart service per machine (see [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md)). Two bash calls, not one — see below.

### Heavy commands and your serve's memory cgroup

On cloudbox an agent's bash command normally runs in its own systemd scope
(`oc-agent.slice`, `MemoryMax=10G`), isolated from the `opencode serve` that spawned it.
**A command whose text contains a bare `git` token is deliberately exempted** and runs
inside the serve's own cgroup instead: `MemoryMax=14G`, `OOMPolicy=stop`, shared with the
serve process and every peer session on that port. The exemption exists so opencode's
`git ... : deny` permission rules still match — wrapping the command would blind them.

The consequence is that `OOMPolicy=stop` makes **any** OOM in that cgroup stop the whole
serve. That kills the plugin, so no `session.idle` fires and the session's Telegram
notifications stop **silently** — it looks like a pigeon bug, not an OOM. It also takes out
every other session on that port. This has happened (`pigeon-8bif`).

So: **never chain `git` with an install or a test run in one bash call.** Split them.

```bash
git pull --ff-only          # call 1 — unscoped, but trivial
npm install && npm run test # call 2 — scoped and capped
```

The suite itself is modest (~1.0 GiB peak, measured cold and warm), so this is about not
adding load to a cgroup that may already be near its ceiling — not about the suite being
large. On macOS/devbox there is no such scoping at all, and everything runs unscoped.

## Architecture

Pigeon is a Telegram bot that routes commands to machines running opencode.

```
Telegram → Webhook → Worker → D1 (SQLite)
                                 ↑
              Daemon polls:  GET  /machines/:id/next    (every 5s)
              Daemon acks:   POST /commands/:id/ack
              Daemon sends:  POST /notifications/send
                                 ↓
                           Plugin → OpenCode
```

Messages flow: Telegram → Worker (Cloudflare) → D1 ← Daemon (polls every 5s) → opencode serve.

The worker stores commands in D1 (Cloudflare's serverless SQLite). The daemon short-polls for commands via HTTP. No long-lived connections. If the worker restarts, the next poll succeeds against the new instance. If the daemon restarts, pending commands wait in D1 until it comes back.

**Future improvement (noted, not planned):** Long polling at the Worker level (`GET /machines/:id/next?timeout=25`) to reduce polling traffic. Not needed at current scale. See [design doc](docs/plans/2026-03-14-d1-polling-architecture-design.md).

### Model Override

The `/model` command sets a per-session model override stored in the daemon's SQLite `sessions` table. When a command is delivered, the override is read and passed through the adapter to the plugin, which includes it in the `prompt_async` request body. The override persists until the session ends or a new `/model` command changes it.

### Telegram Forum Topics

Pigeon supports operating in a Telegram forum supergroup (`TELEGRAM_TOPICS_ENABLED = "true"` in worker `wrangler.toml`). Each opencode session maps to a dedicated forum topic thread named after the session's TUI title. Inbound commands, outbound notifications, and media pass through thread-aware worker endpoints referencing `commands.message_thread_id` and the D1 `topics` table. For migration details, see [`docs/runbooks/telegram-forum-migration.md`](docs/runbooks/telegram-forum-migration.md).

Topic names are **write-once, with exactly one exception**: `topicName(dir, title)` renders `title · ~/path` and is called only at topic creation, so a drifting TUI title never re-renames a topic. `/rename <new title>` is the manual override.

The exception is the **provisional-name upgrade** (`pigeon-353p`). opencode names a new session `New session - <ISO>` and only replaces it once its summarizer runs, seconds later — so a session whose first notification arrives in that window (in practice, any session that receives a swarm message early: lgtm dispatch, coordinator kickoff) would be named after a timestamp forever. Both the daemon (`parseTitle`) and the worker (`isPlaceholderTitle`) therefore treat that placeholder as **no title at all**; the topic opens as just `~/projects/foo`, `topics.name_provisional` is set to 1, and the first later notification carrying a real title renames the topic once via `editForumTopic` and clears the flag. The regex is duplicated in both packages on purpose: the worker deploys centrally while daemons are updated per-machine, so the worker must not depend on a daemon being current. The rename is best-effort and never affects delivery — any failure leaves the flag set for the next titled notification to retry. `/rename` clears the flag unconditionally, so a human-chosen name is never overwritten.

Two deliberate limits worth knowing before filing a bug against `/rename`:

- **A renamed topic loses the ` · ~/path` suffix.** The worker has no durable per-session directory (`topics` has no `dir` column, `sessions` has no dir, and `commands.directory` is `/launch`-only and reaped), so a rename cannot re-derive the path. It calls the same `topicName` formatter with an empty dir, keeping exactly one naming path rather than adding a second formatter.
- **The `sessions.label` half of a rename is not durable.** The daemon re-registers a session with its own local label at session start and during outbox recovery (`outbox-sender.ts`), which reverts the worker-side label. The renamed **topic** persists; the label may not. Daemon-side preservation was judged disproportionate for a P3.

Telegram auto-pins the first message posted into a freshly created topic. The worker clears that pin with `unpinAllForumTopicMessages`, fired exactly once — on the single request that both created the topic and won the finalize CAS (`resolveTopic` reports `created: true`), immediately after that first `sendMessage`. It is best-effort: a failure (bot missing `can_pin_messages`, Telegram 5xx) logs a `console.warn` and never fails an already-delivered notification. Because it runs seconds after topic creation and only for that one send, no human-made pin can be caught by it.

### Swarm IPC

Cross-session messaging between opencode sessions on the same machine. Senders POST to daemon `/swarm/send` (typically via `~/.local/bin/pigeon-send` from workstation, or transparently via `opencode-send <ses_*>` which auto-routes). The daemon persists in `swarm_messages` and returns 202 immediately. A background `SwarmArbiter` (500ms tick, at-most-one-in-flight per target) delivers via opencode serve `prompt_async`, with the message wrapped in a `<swarm_message v="1" ...>` XML envelope so the receiving agent can structurally distinguish swarm traffic from user prompts. Receivers can also call the `swarm_read` opencode tool (registered by the plugin) to fetch their inbox via `GET /swarm/inbox`.

Swarm messages are mirrored into the receiver's Telegram topic at insert time via outbox `kind='swarm'` (`w:<msg_id>` notice, `wc:<msg_id>` retraction). This feed is best-effort and indicates message dispatch rather than transcript delivery. Outbox rate limits (`SWARM_SUB_BUDGET = 6`/60s) prevent swarm bursts from starving conversational notifications or triggering Telegram topic rate limits.

This fixes the prompt_async race architecturally — the daemon is the single writer to opencode serve for cross-session messages, so the "concurrent prompt_async from different `x-opencode-directory` headers bypasses the busy guard" race that bit COPS-6107 cannot occur for daemon-routed traffic. See the `swarm-architecture` skill for tables/routes/algorithm and `swarm-operations` for ops + debugging.

### Commands

| Command | Example | What it does |
|---------|---------|--------------|
| *(plain message)* | `fix the failing test in src/auth.ts` | Executes in the current opencode TUI session via the plugin |
| `/launch <machine> <dir> <prompt>` | `/launch devbox pigeon "say hello"` | Starts a headless opencode session on the specified machine |
| `/kill` | *(reply to a session notification)* | Terminates the session (resolved from replied-to message) |
| `/interrupt` | *(reply to a session notification)* | Interrupts in-flight processing without destroying the session (like Ctrl-C) |
| `/compact` | *(reply to a session notification)* | Summarizes (compacts) the session's conversation to reduce context |
| `/mcp list` | *(reply to a session notification)* | Lists MCP servers with connection status |
| `/mcp enable <server>` | *(reply to a session notification)* | Connects (or reconnects) an MCP server |
| `/mcp disable <server>` | *(reply to a session notification)* | Disconnects an MCP server |
| `/model` | *(reply to a session notification)* | Lists available models from allowed providers |
| `/model <provider/model>` | *(reply to a session notification)* | Sets model override for the session |
| `/rename <new title>` | *(reply to a session notification)* | Renames the session's forum topic to the given title. Worker-only — never reaches opencode |

**`/launch` directory shorthand:** A bare word like `pigeon` expands to `~/projects/pigeon`. Full paths (`~/projects/pigeon`) and `~`-prefixed paths also work.

**The `@BotName` suffix.** In a group, Telegram's autocomplete sends `/kill@mohrbacher_01_bot` rather than `/kill`. Every command above accepts either form. The suffix attaches to the **command token**, not the subcommand — Telegram emits `/mcp@mohrbacher_01_bot list`, never `/mcp list@...`. Three things follow from how this is matched (worker `parseTelegramCommand`):

- **Only our own username is accepted**, from `TELEGRAM_BOT_USERNAME` in worker `wrangler.toml`. Pigeon is a group *admin*, so Telegram delivers it every message including commands addressed to other bots; accepting any `@name` would let a command aimed at a different bot trigger a real `/kill` here. A command addressed elsewhere is dropped, never injected into the session as a prompt.
- **If that var is unset the suffixed form fails closed** — commands are dropped, not executed and not injected — and each drop emits a `console.warn` naming the command token. If autocompleted commands ever silently stop working, check that var first and look for that warning in `wrangler tail`.
- **A `@word` that cannot be a Telegram bot username is treated as ordinary text**, so a prompt like `/opencode-serve@4098 is stuck` still reaches the agent unchanged. The residue is prose whose first token genuinely looks like a bot address (`/deploy@robot ...`), which is dropped and logged. Media **captions** bypass this normalisation entirely and are always prompts (`pigeon-50l`).

### Attaching to a headless session

From a terminal on the machine, connect to a session launched via `/launch`:

```
opencode attach http://localhost:4096 --session <session-id>
```

The session ID is included in the Telegram confirmation message.

### Notifications

Opencode events (stop, question, error) are sent back to Telegram as replies, tagged with the machine name. Each notification includes the session ID on its own line for easy copy-paste.

**Durable notification delivery:** Stop, question, and swarm mirror notifications are routed through the daemon's durable outbox. The daemon accepts the event (HTTP 202), stores it in a SQLite outbox, and returns immediately. A background OutboxSender delivers to Telegram every 5s, retrying with backoff on failure. The worker deduplicates by `notificationId` so retries are safe.

**TUI-typed prompt mirror:** A prompt typed directly into the opencode TUI is posted into the session's topic as `🧑 <session>` (outbox `kind='mirror'`, `notificationId` `m:<sessionId>:<messageId>`), so a topic is no longer one-sided — it shows the prompts as well as the answers. The plugin accumulates user-role parts per message, flushes after 500ms of quiescence, and POSTs to daemon `/mirror`.

Prompts the daemon *injected* must not be mirrored, because Telegram already showed them — and they arrive as ordinary user messages, indistinguishable from typing. So the daemon records `sha256(prompt)` in a counted `injected_prompts` table (15-min TTL, swept by the session reaper) immediately **before** each injection, and `/mirror` consumes one count and stays silent on a hit. Two details are load-bearing rather than defensive:

- **Recorded before the HTTP call, never after the response.** `prompt_async` is non-idempotent and a 30s timeout may mean *processed* (`worker/delivery-policy.ts`). A response-time record loses the race to the events it exists to suppress.
- **Counted, not single-use.** A plain row is consumed by the first of two identical prompts and the second echoes. Sending `continue` twice inside 15 minutes is routine, and arbiter retry-after-timeout produces byte-identical re-injections.

Four things are deliberately never mirrored: subagent sessions, parts marked `synthetic`, messages yielding no text parts, and empty/whitespace text. The third is not hypothetical — a **compaction marker is a user-role message whose only part is `{type: "compaction"}` and it is not flagged synthetic**, so without that rule every compaction posts an empty message. A post-compaction *resumption* prompt, by contrast, does mirror and should: it is a genuine input that redirects the session.

Both remaining leaks fail toward silence rather than duplicates (an unconsumed count suppresses an identical TUI prompt for ≤15 min; an undiscovered session drops its mirror). That direction is deliberate — a missing post is a gap, a duplicate post is noise in every topic on the machine.

**Token usage footer:** Stop notifications include a compact `📊 12.3K tokens · 7%` footer showing the cumulative context-window usage reported by the latest assistant message and its percentage of the model's context window. Sourced from `message.updated` events; matches what the OpenCode TUI sidebar displays. The percent is omitted when the model's context limit cannot be resolved.

**Question notification reliability:** When the plugin receives a `question.asked` event, it enqueues the question in an in-memory retry queue that bypasses the circuit breaker and calls `sendQuestionAsked` with a 3s timeout.

**Multi-question wizard:** When a question has multiple sub-questions, the daemon renders them one at a time in a single Telegram message that is edited in-place as the user answers each step. Button callbacks include a version number (`cmd:TOKEN:v{version}:q{index}`) to prevent stale presses. On the final step, all accumulated answers are delivered to the plugin as a single reply.

**Rate limit retry notifications:** When OpenCode hits a rate limit and retries, the plugin detects `session.status` events of type `"retry"` and sends a notification with the attempt number, error message, and next retry time.

**Message splitting:** When a notification body exceeds Telegram's 4096-character limit, it is split into multiple messages at natural boundaries (paragraph breaks, line breaks, sentence ends). Reply markup is attached only to the last chunk.

### Media Relay

Photos, documents, audio, video, and voice messages sent to the Telegram bot are relayed to OpenCode sessions via R2:

- **Inbound**: Telegram media → Worker (downloads from Telegram API, stores in R2) → Daemon (fetches from R2, converts to data URI) → Plugin (sends as file part to `prompt_async`)
- **Outbound**: OpenCode file attachments → Plugin (captures FileParts and tool attachments) → Daemon (uploads to R2) → Worker (sends as `sendPhoto`/`sendDocument` reply in Telegram)

Media is stored temporarily in the `pigeon-media` R2 bucket with a 24-hour TTL, cleaned hourly by cron.

### Session Reaper

A background hourly timer in the daemon cleans up stale Pigeon routing state. Sessions whose `last_seen` is older than `SESSION_TTL_MS` (1 week) are removed from local storage and unregistered from the worker, but their opencode transcripts are preserved. `opencode-serve` is restarted separately for process hygiene.

### Dead Session Cleanup

When command delivery fails with a connection error (ECONNREFUSED, timeout, etc.), the daemon automatically removes the session from local storage. This prevents repeated delivery attempts to a dead plugin process.

Health check URLs are listed in the Quickstart section above.

## Skills TOC

### Worker

- [worker-architecture](.opencode/skills/worker-architecture/SKILL.md)
  - Use when you need endpoint, table, and flow-level system understanding.
- [worker-deployment](.opencode/skills/worker-deployment/SKILL.md)
  - Use when deploying to Cloudflare and validating production health/auth.
- [telegram-forum-migration](docs/runbooks/telegram-forum-migration.md)
  - Runbook for Telegram Forum Topics supergroup migration and rollback steps.
- [worker-operations](.opencode/skills/worker-operations/SKILL.md)
  - Use for incident triage, log tailing, quick diagnostics, and rollback steps.
- [worker-troubleshooting](.opencode/skills/worker-troubleshooting/SKILL.md)
  - Use when notifications, webhook auth, or command routing are failing.
- [worker-parity-checks](.opencode/skills/worker-parity-checks/SKILL.md)
  - Use for authenticated parity verification, including notification+reply flow.

### Daemon

- [daemon-architecture](.opencode/skills/daemon-architecture/SKILL.md)
  - Use for daemon module boundaries, storage model, and worker integration flow.
- [daemon-development](.opencode/skills/daemon-development/SKILL.md)
  - Use when implementing or testing daemon routes/services/adapters.
- [daemon-operations](.opencode/skills/daemon-operations/SKILL.md)
  - Use for daemon service health checks, restarts, logs, and burn-in checks.
- [daemon-troubleshooting](.opencode/skills/daemon-troubleshooting/SKILL.md)
  - Use when daemon notifications, command ingest, or injections fail.
- [daemon-cutover-burnin](.opencode/skills/daemon-cutover-burnin/SKILL.md)
  - Use for systemd cutover/revert steps and production stabilization checks.

### OpenCode Plugin

- [opencode-plugin-architecture](.opencode/skills/opencode-plugin-architecture/SKILL.md)
  - Use for plugin event lifecycle, session state, and daemon contract understanding.
- [opencode-plugin-development](.opencode/skills/opencode-plugin-development/SKILL.md)
  - Use when changing plugin handlers, tests, or daemon payload fields.
- [opencode-plugin-deployment](.opencode/skills/opencode-plugin-deployment/SKILL.md)
  - Use when deploying or updating the OpenCode plugin on devbox or via Nix.

### Swarm IPC

- [swarm-architecture](.opencode/skills/swarm-architecture/SKILL.md)
  - Use for swarm tables, routes, the per-target arbiter, the session→directory registry, and the wire envelope.
- [swarm-development](.opencode/skills/swarm-development/SKILL.md)
  - Use when adding swarm features (kinds, channels, plugin tools, schema changes) with TDD.
- [swarm-operations](.opencode/skills/swarm-operations/SKILL.md)
  - Use for swarm health checks, inspecting messages, debugging stuck deliveries, and reading the arbiter log.

### Serve Pool / Routing Registry

- [serve-pool-registry](.opencode/skills/serve-pool-registry/SKILL.md)
  - **Read before spawning ANY `opencode serve`** (directly, from a script, or
    transitively via a test harness) — your bash env carries a live pool identity.
    Also for diagnosing a slot pointing at a dead port, stuck draining, or 500ing
    every prompt.

### Cross-Cutting

- [secrets-and-auth](.opencode/skills/secrets-and-auth/SKILL.md)
  - Use for sops secret flow, token sources, and auth boundaries.
- [machine-setup-devbox](.opencode/skills/machine-setup-devbox/SKILL.md)
  - Use when onboarding or repairing devbox/macOS machine configuration.
- [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md)
  - Use when deploying pigeon code changes across all machines after merging to main.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->

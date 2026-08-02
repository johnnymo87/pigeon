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
- Deploy daemon/plugin: `git pull && npm install` then restart service per machine (see [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md))

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

Topic names are **write-once**: `topicName(dir, title)` renders `title · ~/path` and is called only at topic creation, so a drifting TUI title never re-renames a topic. `/rename <new title>` is the manual override. Two deliberate limits worth knowing before filing a bug against it:

- **A renamed topic loses the ` · ~/path` suffix.** The worker has no durable per-session directory (`topics` has no `dir` column, `sessions` has no dir, and `commands.directory` is `/launch`-only and reaped), so a rename cannot re-derive the path. It calls the same `topicName` formatter with an empty dir, keeping exactly one naming path rather than adding a second formatter.
- **The `sessions.label` half of a rename is not durable.** The daemon re-registers a session with its own local label at session start and during outbox recovery (`outbox-sender.ts`), which reverts the worker-side label. The renamed **topic** persists; the label may not. Daemon-side preservation was judged disproportionate for a P3.

### Swarm IPC

Cross-session messaging between opencode sessions on the same machine. Senders POST to daemon `/swarm/send` (typically via `~/.local/bin/pigeon-send` from workstation, or transparently via `opencode-send <ses_*>` which auto-routes). The daemon persists in `swarm_messages` and returns 202 immediately. A background `SwarmArbiter` (500ms tick, at-most-one-in-flight per target) delivers via opencode serve `prompt_async`, with the message wrapped in a `<swarm_message v="1" ...>` XML envelope so the receiving agent can structurally distinguish swarm traffic from user prompts. Receivers can also call the `swarm_read` opencode tool (registered by the plugin) to fetch their inbox via `GET /swarm/inbox`.

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
| `/current-state [machine]` | `/current-state cloudbox` | Surveys the machine's `main` tmux opencode TUIs and replies with an index plus one swipe-reply card per session (🟢 active / ⚪ idle). Machine defaults to `cloudbox` |

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

**Durable notification delivery:** Both stop and question notifications are routed through the daemon's durable outbox. The daemon accepts the event (HTTP 202), stores it in a SQLite outbox, and returns immediately. A background OutboxSender delivers to Telegram every 5s, retrying with backoff on failure. The worker deduplicates by `notificationId` so retries are safe.

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

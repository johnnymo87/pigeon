# Delete Telegram (pigeon-4ogz.13) — plan

Spec: `docs/plans/2026-11-20-slack-transport-design.md` §9 steps 8-9. Bead: `pigeon-4ogz.13`
(gate evidence is in its notes). Owner session: `ses_e01a9f753ffeEWEDOKaceOH8RL` (devbox,
worktree `.worktrees/delete-telegram`). No rollback past this step, so it is split into PRs that
each keep production working with whatever is deployed beside them.

State at start (2026-11-21 ~13:50Z): all three machines on Slack. D1 still holds Telegram rows:
`topics` (~2300 numeric chat ids), `named_topics` (41 numeric), `messages` (~25k numeric). No
numeric `named_topic_bindings` or `commands`. `seen_updates` was still receiving Telegram updates
at 13:36Z (after every flip): find out what they are before deleting the webhook.

## Scope decisions (mine, within the spec)

1. **Rename scope = in-process identifiers, files, env and config that say Telegram**
   (`telegram`, `tg`, `Tg`, `TELEGRAM_*`). **Wire values stay** (oracle finding 7): the
   `telegram:{status,…}` object, `"Telegram API error"`, `telegram_error`/`_unparseable`/`_failed`,
   `/^telegram call /` text, and Telegram-shaped fields (`entities`, `replyMarkup.inline_keyboard`,
   `callback_data`, `messageThreadId`, `retryAfter`, `details.error_code`). Old daemons match some
   literally, so renaming them is a three-step cross-machine dance for no behaviour change. They go
   to a P4 follow-up bead.
2. **Persisted values stay** (`telegram-reply` pull source and `OpencodeDirectSource` values are
   `.14`; `GooseTurnOrigin "telegram"` is persisted in goose inflight rows): rename only if it
   needs no migration.
3. **Old Telegram D1 rows are purged** after the worker deploy (Time Travel bookmark first; batched
   `DELETE … WHERE chat_id NOT LIKE 'slack:%'` on `topics`, `named_topics`,
   `named_topic_bindings`, `messages`, `commands`; then `DROP TABLE seen_updates`). The code does
   not depend on the purge (oracle 3): a numeric address gets a distinct internal result
   `{ok:false, kind:"no_transport"}` that never reaches `toResponse`/`failureDetails` (a synthetic
   400 would read as "Telegram refused" / `strip_entities` to old daemons). Per caller:
   - session `topics` row with a numeric chat: treated as absent (CAS delete, no close call, create
     the Slack channel; no 5-min age guard);
   - `/notifications/send` from a machine with no workspace: `503 {error:"no_transport"}`, no
     `retryAfter` (uncounted retry to TTL + worker-health page: config error); shared key: the
     existing `403 chat_not_allowed`;
   - `/messages/send` to a numeric address with a thread < 2^40: `403 chat_not_allowed`;
   - `/notifications/edit` numeric row: 404 "Message not found"; `/topics/rename` numeric row:
     404 `unknown_session`;
   - reaper / orphan-closer numeric row: delete the row, no call, no 429 accounting.
4. **Topic reaper and unregister defer stay as they are** (daily close window, 30-day reap):
   harmless on Slack (archive), and redesigning them is not this bead. Comments lose the Telegram
   rationale only where it is wrong.
5. **High-water alert** goes to every configured workspace's `#alerts`, deduped by team id.
   **Relocation alert** keeps only its Slack branch.
6. **`movedTopicHint` (.22) is deleted.** `slack-flip.mjs off` and the Telegram direction of
   `/topics/named/rehome` are deleted; `on` stays (new machine onboarding, team change).
7. **Shared key** can no longer post anywhere (it already could not reach Slack).
8. Telegram bot itself (BotFather) is Jonathan's: not deleted, just disconnected (webhook deleted,
   token removed from every store). Recommend he revokes the token (it is in sops history).

## PRs, in order

### PR A — worker: delete Telegram (deploy first)
- Delete `telegram.ts` (move shared types to `chat/transport.ts`: `ChatResult`, option types;
  `getTelegramErrorDetails` → `failureDetails`; `isPermanentTopicFailure` → `chat/`), `webhook.ts`
  (move `MAX_COMMAND_LENGTH`, `MAX_FILE_SIZE`, `MAX_IMAGE_DIMENSION`, `IN_REPLY_TO_MAX_CHARS` to
  `chat/limits.ts`), `/webhook/telegram`, `cleanupSeenUpdates`, `chat/allowlist.ts`,
  `movedTopicHint`, `topicsEnabled` (= always on), icon colours, auto-unpin, the t.me url branch,
  `TELEGRAM_RICH_MESSAGES` / dialect-less rich path, Telegram reaper branch, per-transport 429 set,
  supersede between transports (no second transport; numeric rows are purged).
- `transportForChat(chatId, ctx)`: no bot token; Slack or `NO_TRANSPORT`; test injection
  `transport?` applies to any address.
- Env: drop `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_CHAT_IDS`,
  `ALLOWED_USER_IDS`, `TELEGRAM_TOPICS_ENABLED`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_RICH_MESSAGES`
  from types, `wrangler.toml`, `vitest.config.ts`.
- Contract, **backward compatible with today's daemons**: `chatId` optional for a machine principal
  on every route (missing = its own workspace / `#alerts`); a numeric `chatId` from a machine is
  still accepted and mapped as today. Response wire values unchanged (decision 1).
  `/topics/unpin` becomes a constant `{ok:true}` (removed in PR C). `whoami` unchanged.
- `/topics/named/rehome`: unconditional "rehome to the machine's Slack workspace" (no Telegram
  direction, no transport-mismatch branch).
- Tests: delete Telegram-only tests; port shared-logic tests (topic CAS/holds, notifications,
  named topics, poll refusal) to Slack env or an injected fake transport.
- Deploy (oracle 4-6): `wrangler tail` the webhook to see what still arrives (log update keys);
  if a human still types there, post one "moved to Slack" note in General; `deleteWebhook
  ?drop_pending_updates=true`; deploy; `wrangler d1 time-travel info` bookmark; batched purge; drop
  `seen_updates`; `wrangler secret delete TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`. Leave
  the deployed plain vars alone or delete them one by one in the dashboard: never flip
  `keep_vars` (it would wipe dashboard-set `SLACK_*` vars).

### PR B — daemon + plugin: delete Telegram (deploy to devbox, cloudbox, macbook)
- Delete `direct-telegram-alarm.ts` (move `severityPrefix`), Telegram half of `direct-alarm.ts`,
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`/`TELEGRAM_GROUP_ID` config, the `chatId` requirement
  (outbox, alert notifier, drainer, named topics, launch capability, poller), unpin, the t.me
  builder in `alert-links.ts`, Telegram rich dialect (always Slack), `"telegram"` transport state,
  Telegram-only delivery-policy/worker-health branches, `RateLimitError`.
- Rename Telegram-named identifiers/files (`telegram-message.ts` → `chat-message.ts`,
  `swarm/telegram-notice.ts` → `swarm/chat-notice.ts`, `sendTelegramReply`, `TelegramSendError`,
  `splitTelegramMessage`, …). Wire matches (`"Telegram API error"`, `obj.telegram`) stay.
- Persisted `whoami.transport = "telegram"` in `daemon_kv` and a 200 whoami without `transport`
  read as unknown, never as Telegram (oracle 8). Startup log line names the new build so the
  workstation step can gate on it (oracle 1).
- Plugin: `TELEGRAM_WEBHOOK_PORT` fallback removed (check nix env first).
- Deploy: `scripts/deploy-daemon.sh` on devbox; cloudbox and macbook via `swarm_launch`.

### PR C — worker: drop compat (after all three daemons run PR B)
- Remove `/topics/unpin` and the numeric-`chatId` mapping. Small; may fold into PR D.

### PR D — docs (deletions only; rebase on .12's wording PR first)
- Delete `docs/runbooks/telegram-forum-migration.md`, Telegram sections of AGENTS.md and skills.

### Workstation (per host, only after positive evidence PR B runs THERE: oracle 1)
- Evidence = the daemon's startup lines `[chat] Slack only (Telegram removed, pigeon-4ogz.13)` and
  `[alert] direct path: slack=set`.
- Rollback window: reverting PR B on a host is safe only while that host still exports
  `TELEGRAM_CHAT_ID` (old code skips the outbox and alert notifier without it, silently). After the
  workstation commit, there is no daemon rollback either.
- Remove `TELEGRAM_*` exports and sops declarations (devbox, cloudbox), `telegram_*` keys from
  `secrets/devbox.yaml`, darwin Keychain reads + setup prompts, the Telegram owner id from
  `PIGEON_PULL_ALLOWED_USER_IDS` and the flake checks pinning it.
- cloudbox `secrets/cloudbox.yaml` keys: a cloudbox session (swarm_launch), after the decls go.
- Mac Keychain items `pigeon-telegram-bot-token`, `pigeon-telegram-chat-id`: a Mac session, after
  the Keychain reads are gone from the deployed darwin config.
- Same commit removes or documents dead the `use-shared-worker-key` lever (shared key can't post).
- Same commit: declarations + exports together; YAML keys afterwards (sops-nix fails activation on
  a declared-but-missing key).

### Outside
- healthchecks.io: remove the Telegram integration (Jonathan's browser, CDP 9222, own tab).
- Close `pigeon-4ogz.24` (superseded). Reconcile epic prose. `.14` unblocks.

## Progress log
- PR A #245 merged 4c3e876, worker deployed b0303bac (2026-11-21 ~15:30Z). Webhook deleted, D1
  purged (topics 2307, named_topics 41, messages 25674), `seen_updates` dropped, worker Telegram
  secrets deleted. Deployed plain vars left inert.
- PR B (daemon + plugin) opened.

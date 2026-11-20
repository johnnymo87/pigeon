# Telegram single egress: the worker is the only normal caller of the Bot API

Status: design, 2026-11-20, reviewed by adversarial-reviewer-opus (buy-in with changes, all
applied below). Future phase (unplanned): replace Telegram with Slack behind the same seam.

## Goal

After this work, pigeon's normal traffic to Telegram leaves from one place: the `ccr-router`
worker's `TelegramClient` (`packages/worker/src/telegram.ts`). The daemons stop calling
`api.telegram.org` for anything except one deliberately narrow, named out-of-band alarm module.
Replacing Telegram later then means rewriting the worker's client plus that one daemon module.

This phase does **not** make the daemon↔worker contract provider-neutral. `chatId`,
`messageThreadId`, entities and URL buttons stay in the contract. Renaming them is the Slack
phase's job, done when a second provider exists to shape the abstraction.

## Where Telegram is called today (HEAD bb73582)

| # | Site | What | Through worker? | This phase |
|---|---|---|---|---|
| A | `worker/src/telegram.ts:220` `callTelegram` | every worker Bot API method | it *is* the worker | the seam |
| B | `worker/src/webhook.ts:424` | inbound file download (`/file/bot…`) | in worker, bypasses the client | into the client |
| C | `daemon/src/index.ts:379-411` `sendTelegramMessage` | every slash-command reply | **no** | via worker |
| D | `daemon/src/notification-service.ts:423-527` | `sendPlainAlert` (all operational alerts, `/alert`), `unpinTopic` | **no** | worker-first, direct fallback |
| E | `workstation/hosts/devbox/em-{ci-monitor,ci-failover,stack-monitor}.sh` | eternal-machinery monitors curl `sendMessage` with pigeon's bot token | **no** | **deferred** (see below) |

Also: `~/projects/ccr-worker` (legacy, Jan 2026, not in `projects.nix`) has
`name = "ccr-router"` and would overwrite the live worker if anyone ran `wrangler deploy` from it.
Not a live call site; archive it (tracked bead).

## The constraint that shapes the design: D is direct on purpose

`daemon/src/worker/worker-health.ts:21-26`: alerts leave via `sendPlainAlert`, which "does NOT
traverse the worker. That is what makes this alarm meaningful: it can still get out while the
thing it is reporting on is broken." The 2026-07-14 worker outage (pigeon-n4v) went unnoticed for
sixteen days. Routing D blindly through the worker would silence the alarm built to report a
broken worker. So D becomes **worker-first, direct fallback**, and the fallback must itself be
visible.

## Design

### Worker PR (merged and deployed before the daemon PR)

1. **`POST /messages/send`**: a session-free send. Auth: existing `authenticate` (shared or
   per-machine key), like `/notifications/send`; no acts-as check, same as today (every daemon
   host already holds the bot token, which is strictly more power). Body:
   `{ chatId, text, entities?, messageThreadId?, urlButtons? }`, `urlButtons` being
   `Array<Array<{text, url}>>`. `messageThreadId` is passed through as given; do **not** apply
   the webhook's topics-enabled gate (`webhook.ts:459`). `chatId` stays in the body (the worker
   has no machine→chat map; `named-topics.ts:207-219` does the same).

   The Telegram call gets an abort, default **~4 s**, overridable per request by an optional
   `timeoutMs` in the body (bounded, e.g. ≤ 30 s), because command replies (C) have no fallback
   and should ride out a slow Telegram (pigeon-bit4 saw 43.6 s stalls); only the alert path
   needs the tight 4 s/5 s pairing. Today `callTelegram` has none. Results:

   | Response | Meaning | Daemon does |
   |---|---|---|
   | `200 {ok:true, messageId}` | posted | done |
   | `200 {ok:false, telegram:{status:400, description}}` | Telegram 400 (incl. `thread not found`, description preserved) — nothing posted | throw `TelegramSendError(400, …, description)` → existing `/alert` ladder |
   | `200 {ok:false, telegram:{status:429, retryAfter, description}}` | rate limited | throw `TelegramSendError(429, …)` (as today; `RateLimitError` is unused) |
   | `403 {error:"chat_not_allowed"}` | chatId not in `ALLOWED_CHAT_IDS` | fall back |
   | `502 {error, telegram?:{status, description}}` | any other Telegram status (401/403/404 = broken worker token; 5xx), unparseable Telegram body, abort, transport throw | fall back |

   Anything else (worker 5xx, 401, 404 from a not-yet-deployed route, non-JSON body, transport
   error, worker-leg timeout) also falls back. Three behaviours: done / Telegram said no / fall
   back. Telegram 400/429 ride in a 200 so the daemon can tell "Telegram said no" from "worker
   broken"; this differs from `/notifications/send` (which relays Telegram errors as 502) on
   purpose. No `messages` rows: these posts are not reply-routable, as today.
2. **`POST /topics/unpin`** `{ chatId, messageThreadId }` → `tg.unpinAllForumTopicMessages`,
   same abort, best-effort.
3. **File download through the client.** `TelegramClient.downloadFile(filePath)` used at
   `webhook.ts:424`.
4. **Guard test** (`packages/worker`): `api.telegram.org` appears in no `src/` file but
   `telegram.ts`.

All additive; an old daemon keeps working against the new worker. **Rollout rule:** once any
daemon runs the new code, do not roll the worker back below this version (command replies would
404; see C).

### Daemon PR (C + D + guard, one PR; develop alongside the worker PR, merge after it deploys)

A shared `WorkerMessageClient` (`/messages/send`, `/topics/unpin`) using the poller's worker URL
and bearer.

**C, command replies.** `sendTelegramMessage` (`index.ts:379`) uses the client, with a timeout
(today's fetch has none; pass a long `timeoutMs`, e.g. 30 s, to the route). No fallback: replies are best-effort and their failures are already
swallowed (`index.ts:399-410`). Log a worker 404 as an **error** naming the missing route, so a
worker rollback or a daemon-first deploy is loud, not a silent loss.

**D, alerts.** Split `TelegramNotificationService`:

- `DirectTelegramAlarm` (new `daemon/src/direct-telegram-alarm.ts`): today's direct
  `sendMessage` code moved verbatim. The only `daemon/src` file allowed to contain
  `api.telegram.org`.
- A composing `StopNotifier`: worker leg first, per the table above.
  - **Budget:** worker leg capped at ~5 s (above the worker's 4 s Telegram abort, so a slow
    Telegram yields a definite 502 rather than a daemon-side timeout racing an in-flight post),
    direct leg gets the rest of `timeoutMs`. If under ~2 s remains **and a direct path exists**,
    go direct only; a worker-only host tries the worker with whatever is left.
  - **Visible fallback:** an alert sent direct gets a suffix `· sent direct; worker: <reason>`
    (truncate the body first so text + suffix stays ≤ 4096), and the fallback enqueues a
    throttled worker-health alert (via the existing `AlertRepository`, de-duplicated per reason,
    e.g. once per hour) so a broken worker is reported even if every alert still lands. The
    throttle is checked **before** enqueueing, including when the alert being sent is itself
    the worker-health alert and on worker-only hosts, so a persistently broken worker cannot
    loop. Test: a worker broken for a window yields at most one health alert per reason.
  - **Duplicates:** a worker-leg timeout after the worker posted, then a direct post, gives two
    copies, and `AlertDrainer` retries thrown errors (`alert-drainer.ts:117-131`), so this can
    compound. Accepted: for an operational alert a duplicate beats silence. Say so in a comment.
  - `unpinTopic` → worker only, best-effort, no fallback.
- `/alert` ladder (`app.ts:868-930`) unchanged.
- **Startup line** (`index.ts:1189,1273`): `worker+direct-fallback`, `worker-only` (no bot
  token), `direct-only` (no worker URL, e.g. `e2e-endpoint-fence.sh`), or `UNAVAILABLE`. Note:
  `launchCapable` still requires `telegramBotToken` (`index.ts:513-519`); leave it, but don't
  claim worker-only hosts are fully capable.
- Fix comments made false: `worker-health.ts:21-26` (and its literal `api.telegram.org`),
  `index.ts:916`.
- **Guard test** (`packages/daemon`): `api.telegram.org` appears in no `src/` file but
  `direct-telegram-alarm.ts`.

### E, eternal-machinery monitors: deferred

Moving them to the daemon's `/alert` would hand the daemon bearer token, which also authorizes
`/swarm/send` and `/injected-prompts` into dev's sudo-capable sessions
(`hosts/devbox/configuration.nix:1524-1526`), to a dedicated system user and a DynamicUser
(`em-ci-failover.nix:35`). em-ci-failover has no dead-man's switch and swallows send failures,
and `opencode-drift-alert` always exits 0, which would break em-ci-monitor's healthchecks
contract. These are eternal-machinery's traffic, not pigeon's; the Slack phase can give them a
channel of their own (filed as a deferred bead under the epic).

## Rollout

1. Worker PR → merge → `npm run --workspace @pigeon/worker deploy` → live check: a
   `/messages/send` post into a test topic; `/topics/unpin`; a photo sent to a session topic
   still relays to R2.
2. Daemon PR → merge → `scripts/deploy-daemon.sh` on devbox and cloudbox → live check:
   `POST 127.0.0.1:4731/alert` lands with no `sent direct` suffix; a slash-command reply arrives.
3. macOS daemon: needs a session on the Mac or a remote window (`remote-workstation-cutover`).
   Tracked as an open item; the phase isn't done while the Mac still sends direct. The Mac is
   safe on the old daemon meanwhile (worker change is additive).

## Verification

- Worker: route mapping for every row (incl. unparseable 200 → 502, abort on slow Telegram,
  allowlist → 403, Telegram 401 → 502), unpin, file download via client, guard.
- Daemon: the `/alert` ladder run against the **real composed notifier** with mocked fetch
  (existing ladder tests mock the notifier): `thread not found` from worker → recreate → second
  send; Telegram 401 via worker → direct with suffix; worker 200 non-JSON → direct; hung worker →
  direct within `PLAIN_ALERT_TIMEOUT_MS` total; <2 s budget → direct only; worker 404 → direct.
  Command reply: worker 404 logs an error. Guard.

## Out of scope

Provider-neutral contract and naming (Slack phase); E; webhook ingress; reply routing for
alerts; the poll-failure probe in `worker-health.ts` (pigeon-b6h4); binding chats to machines.

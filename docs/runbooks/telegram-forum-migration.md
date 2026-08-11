# Runbook: Telegram Forum Topics Migration

This runbook describes the procedure to migrate Pigeon from a single Telegram Direct Message (DM) chat to a Forum Supergroup where each OpenCode session gets its own topic.

---

## Central Invariant

**Additive D1 DDL is applied BEFORE any code deploy.**

> **Why:** Tasks T2.14+ made `queueCommand`'s `INSERT` and `pollNextCommand`'s `SELECT` reference `commands.message_thread_id` **unconditionally**. The feature flag (`TELEGRAM_TOPICS_ENABLED`) gates feature behaviour, not SQL query text. Deploying code before applying DDL causes every command poll and queue operation to fail with `no such column: message_thread_id`, resulting in a total command delivery outage regardless of whether feature flags are off or on. Additive DDL is backwards-compatible with older worker code, making DDL-first safe in both directions.

### Current Production State

Both required DDL changes were **already applied to production** D1 (`pigeon-router`) on 2026-07-26:
1. `topics` table and partial unique index `idx_topics_thread`.
2. `commands.message_thread_id` column.

Therefore, for this migration, Step 1 is **verify schema presence, not apply**.

---

## ⚠️ The `[vars]` Deploy-Revert Trap

Both `ALLOWED_CHAT_IDS` and `TELEGRAM_TOPICS_ENABLED` are declared in the `[vars]` section of `packages/worker/wrangler.toml`.

> **CRITICAL:** Running `wrangler deploy` (or `npm run --workspace @pigeon/worker deploy`) **re-asserts the `[vars]` declared in `wrangler.toml`**, silently overwriting any environment variables changed directly via the Cloudflare Dashboard UI.

To change worker environment variables safely:
1. **Edit `packages/worker/wrangler.toml`** directly.
2. Preview changes with `--dry-run`:
   ```bash
   npx --workspace @pigeon/worker wrangler deploy --dry-run
   ```
3. Deploy the worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
4. Verify the deployed variables post-deploy via API or Wrangler CLI.

---

## Strict Flag Matching (`TELEGRAM_TOPICS_ENABLED`)

The `topicsEnabled` predicate in `packages/worker/src/topics.ts` requires an **exact string match**:
```ts
env.TELEGRAM_TOPICS_ENABLED === "true"
```
Values like `"True"`, `"TRUE"`, `"1"`, `""`, or `"true "` evaluate to **`false`**. This fail-safe design prevents accidental enablement, but means a typo will silently keep topics disabled. Always verify that the deployed string value is exactly `"true"`.

---

## Manual Telegram Supergroup Setup

1. **Create Supergroup**: In Telegram, create a new group or convert an existing group to a Supergroup.
2. **Enable Topics**: Open Group Settings → Toggle **Topics** to ON.
3. **Add Bot**: Add the Pigeon Telegram bot to the supergroup.
4. **Promote Bot to Admin**:
   - Grant permission: **`can_manage_topics`** (required to create, edit, close, and reopen topics).
   - Grant permission: **`can_delete_messages`** (required for message cleanup).
   - *Note on Privacy Mode:* Promoting the bot to Admin automatically bypasses privacy mode. No BotFather `/setprivacy` change is needed.
   - *Note on Pinning:* **`can_pin_messages` is NOT required** — Pigeon does not pin topic messages.

---

## Pre-Flip Gate (Open Beads)

Do NOT set `TELEGRAM_TOPICS_ENABLED = "true"` until the following beads are settled:

- **`pigeon-cev`** (P1): four questions that only the live Telegram API can answer. **The numbering below
  is load-bearing — other beads and the plan cross-reference these items by number. Do not renumber.**
  1. **The `[vars]` revert trap.** Documented in this runbook (see above). Flip via `wrangler.toml`, or move
     the flag to a secret. Confirm with `--dry-run` first.
  2. **The `thread_not_found` classifier string** (`packages/worker/src/telegram.ts`). Still an unverified
     substring match inherited from T1.3. If Telegram's real string differs, T2.7 degrades gracefully — T2.8
     still delivers to General — but stale rows never clean up and every send double-hits Telegram. Verify by
     deliberately deleting a topic in the supergroup and reading the actual error description.
  3. **Can an admin bot post into a CLOSED topic at all?** T2.6 reopens before sending so we never depend on
     the answer, but it decides whether the reopen call is load-bearing or belt-and-braces, which matters for
     the 20/min budget. **This item also decides `pigeon-cal`.**
  4. **What does Telegram return when you reopen an ALREADY-OPEN topic?** The F1 fix assumes a generic
     non-429, non-`thread_not_found` error and guesses `TOPIC_NOT_MODIFIED`. Safe either way, but confirming
     tells us whether that branch is the common path or a rarity.

  Verify items 2, 3 and 4 in the **same** live session — all three are "ask the real API" questions.
- **`pigeon-cal`** (P1): webhook confirmations have no General fallback, so an ack or error sent into a
  *closed* topic can vanish silently — the webhook wrapper discards `TgResult`, unlike the notification path
  which gets T2.8's fallback. **Decided by `pigeon-cev` item 3 above:** if an admin bot *can* post into a
  closed topic, this is a non-issue; if it cannot, mirror T2.8 (on a non-429 failure with a thread id, retry
  once without it).
- **`pigeon-5o7`** (P2): Scope `deleteTopicBySession` to thread ID.
- **`pigeon-wly`** (P3): Reap-loop generic failures pinning head-of-line slots (accepted residual).

### Manual check still outstanding — required before the flip

Send **one swipe-reply command in the production DM** (reply to a session notification with, say, `/kill`)
and confirm it still works. Both prior adversarial reviews asked for this and it has not been done. It is
the only thing that would reveal a private chat unexpectedly carrying `message_thread_id` — the single
assumption the flag-off path leans on. If a DM *does* carry one, T2.13's service-message guard could
suppress a legitimate swipe-reply silently.

### Deferred Rate-Limit Gate
A D1-based chat-level `next_send_at` rate gate was deferred during Phase 2 design.
- **Trigger to build:** If 429 rate limit responses appear on more than a handful of days during burn-in, implement the rate gate.
- **Action:** Monitor and record 429 frequency in worker logs during the burn-in period.

---

## Migration Steps

Follow these steps in exact sequential order.

### Step 1: Verify D1 Schema

Confirm production D1 already contains the required schema additions.

```bash
# Check commands table for message_thread_id column
npx wrangler d1 execute pigeon-router --remote --command "SELECT message_thread_id FROM commands LIMIT 1;"

# Check topics table existence
npx wrangler d1 execute pigeon-router --remote --command "SELECT * FROM topics LIMIT 1;"
```

**Expected Result:** Both queries succeed without `no such column` or `no such table` errors.

<details>
<summary>Reference DDL (for new environments / rebuilds from scratch) — authoritative copy is <code>packages/worker/src/d1-schema.sql</code></summary>

```sql
CREATE TABLE IF NOT EXISTS topics (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT,
  chat_id TEXT NOT NULL,
  message_thread_id INTEGER,
  name TEXT,
  name_provisional INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
  ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL;

-- Required by the hourly topic reaper (topic-reaper.ts). Do not omit.
CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at);

ALTER TABLE commands ADD COLUMN message_thread_id INTEGER;
```
</details>

---

### Step 2: Deploy Worker Dark (Flag Off)

Deploy the worker code with `TELEGRAM_TOPICS_ENABLED = "false"`.

1. Verify `packages/worker/wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "8248645256"
   TELEGRAM_TOPICS_ENABLED = "false"
   ```
2. Deploy worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
3. Verify health endpoint:
   ```bash
   curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
   ```
   **Expected Result:** `ok`

> **Note on Dark Burn-in:** A dark burn-in gives **zero signal** regarding topic logic because code paths under `TELEGRAM_TOPICS_ENABLED = "false"` never query or write to the `topics` table. A quiet dark burn-in only confirms flag-off regression safety.

---

### Step 3: Add Supergroup Chat ID to `ALLOWED_CHAT_IDS`

Allow the worker to accept updates from both the old DM and the new Supergroup chat simultaneously.

1. Obtain the new Supergroup `chat_id` (typically a negative integer starting with `-100...`).
2. Edit `packages/worker/wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "8248645256,-1002345678901"  # Replace with actual supergroup chat ID
   TELEGRAM_TOPICS_ENABLED = "false"
   ```
3. Deploy worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
4. Verify deployment:
   ```bash
   curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
   ```

> **Expected during this step, not a fault:** with the supergroup allowed but the flag still off, anything
> you type in a topic gets its reply routed to **General** — the flag strips the thread id. Do not read that
> as a broken migration; it is the dark path behaving correctly.

---

### Step 4: Enable Forum Topics & Update Machine Configs

1. Check open beads gate before proceeding (see Pre-Flip Gate section).
2. Edit `packages/worker/wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "8248645256,-1002345678901"
   TELEGRAM_TOPICS_ENABLED = "true"
   ```
3. Preview deploy with `--dry-run`:
   ```bash
   npx --workspace @pigeon/worker wrangler deploy --dry-run
   ```
4. Deploy worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
5. Update `TELEGRAM_CHAT_ID` in host secrets on each target machine (devbox, cloudbox) to point to the new
   supergroup `chat_id`. This is a sops-encrypted secret surfaced at `/run/secrets/`; edit the sops file for
   the host and re-apply its NixOS configuration so the decrypted value is rewritten, then restart the
   daemon (next step). The daemon reads `TELEGRAM_CHAT_ID`, falling back to `TELEGRAM_GROUP_ID`
   (`packages/daemon/src/config.ts`). See the `secrets-and-auth` skill.
6. Restart daemon service on each host:
   ```bash
   sudo systemctl restart pigeon-daemon
   ```
7. Verify daemon health:
   ```bash
   curl -s http://127.0.0.1:4731/health
   ```
   **Expected Result:** `{"status":"ok"}`
8. **Verify the flip actually took — `/health` does NOT reflect the flag.** A typo'd flag string looks
   exactly like a successful flip with a quiet system, because `topicsEnabled` is a strict `=== "true"`
   match. Confirm the deployed binding, then confirm real behaviour:
   ```bash
   # a) the deployed value must print exactly: TELEGRAM_TOPICS_ENABLED ("true")
   npx --workspace @pigeon/worker wrangler deploy --dry-run

   # b) trigger any session notification, then confirm a topics row appeared
   npx wrangler d1 execute pigeon-router --remote --command "SELECT session_id, message_thread_id, state FROM topics;"
   ```
   **Expected Result:** a new row with a non-NULL `message_thread_id`, and a matching topic visible in the
   supergroup. **If no topic is created, the flag string is wrong — re-check `[vars]` in `wrangler.toml`.**

---

### Step 5: Burn-In & Monitoring

1. Tail worker logs to monitor real-time activity and rate limits:
   ```bash
   npx wrangler tail --cwd packages/worker
   ```
2. Check for Telegram 429 rate limits or delivery errors in the logs.
3. Send a test command in a topic in the supergroup (e.g., `/model`).
4. Follow the burn-in checklist in `.opencode/skills/daemon-cutover-burnin/SKILL.md`.

---

### Step 6: Post Burn-In Cleanup

Once burn-in passes and all active sessions are operating in topics:

1. Edit `packages/worker/wrangler.toml` to remove the old DM chat ID:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "-1002345678901"  # Supergroup ID only
   TELEGRAM_TOPICS_ENABLED = "true"
   ```
2. Deploy worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
3. Verify health endpoint returns `ok`.

---

## Rollback Procedure

If issues arise with forum topics, revert to DM operation immediately. Reverting worker source code is **not** required or recommended — flipping the feature flag acts as an instant kill switch.

> ### ⚠️ DO NOT REMOVE THE SUPERGROUP FROM `ALLOWED_CHAT_IDS` IN THE SAME DEPLOY
> Rolling the flag back and narrowing the allowlist together **permanently loses notifications.**
> Between the deploy and the moment every daemon has been re-pointed at the DM, each daemon is still
> sending with the supergroup chat id. The worker rejects those with **403 `Chat ID not allowed`**
> (`packages/worker/src/notifications.ts:201-203`), and the daemon outbox marks an entry **terminally
> failed** after `MAX_ATTEMPTS = 10` or `MAX_AGE_MS = 15 minutes`
> (`packages/daemon/src/worker/outbox-sender.ts:26-27,134-139`) — a budget the backoff burns through in
> about 14 minutes. Editing sops on two machines and restarting services can easily exceed that,
> **especially mid-incident, which is exactly when you are rolling back.**
>
> Keep **both** chat ids allowed until the daemons are reverted and the outbox has drained. Flag-off plus
> supergroup-allowed is a safe combination: notifications land in the supergroup's General until each
> daemon flips back. Narrowing the allowlist is a **final cleanup step**, never part of the rollback deploy.

1. Edit `packages/worker/wrangler.toml` — flip the flag off but **keep both chat ids**:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "8248645256,-1002345678901"  # BOTH, deliberately
   TELEGRAM_TOPICS_ENABLED = "false"
   ```
2. Deploy worker:
   ```bash
   npm run --workspace @pigeon/worker deploy
   ```
3. Update `TELEGRAM_CHAT_ID` in host secrets on each target machine back to the DM chat ID (`8248645256`).
4. Restart daemon service on each machine:
   ```bash
   sudo systemctl restart pigeon-daemon
   ```
5. **Confirm the outbox has drained before narrowing the allowlist.** Watch for terminal failures:
   ```bash
   sudo journalctl -u pigeon-daemon -n 100 --no-pager | grep -i "outbox\|failed"
   ```
6. **Only now** remove the supergroup from `ALLOWED_CHAT_IDS` and deploy again.

### What Reverts vs. What Does NOT Revert

- **Reverts:** Commands and notifications immediately return to single DM behavior.
- **Does NOT Revert (Harmless):**
  - Existing Telegram topics in the supergroup remain created in Telegram.
  - Rows in the D1 `topics` table remain (flag-off code never queries or writes to `topics`).
  - The `commands.message_thread_id` column remains in D1 (additive schema, fully ignored when unpopulated).

---

## Schema Addition: `topics.name_provisional` (pigeon-353p)

**This ALTER must be applied BEFORE deploying the worker build that contains it.** It is not
optional and the ordering is load-bearing: `finalize()` writes the column on every topic creation,
and topic-table D1 calls are deliberately not wrapped in `withD1`
(`notifications.ts:245-248`), so a missing column throws to the boundary catch as a 500. The
daemon retries a 500 forever, so the failure mode is "no new topic can ever be created, with
retry amplification" — not a degraded corner.

```bash
# 1. Apply
npx wrangler d1 execute pigeon-router --remote \
  --command "ALTER TABLE topics ADD COLUMN name_provisional INTEGER NOT NULL DEFAULT 0;"

# 2. GATE: verify before deploying the worker
npx wrangler d1 execute pigeon-router --remote --command "PRAGMA table_info(topics);"
# Expected: a row named name_provisional. Do NOT deploy until you see it.

# 3. Deploy
npm run --workspace @pigeon/worker deploy
```

Rollback is safe in the other direction: an older worker build post-ALTER never reads or writes
the column (`SELECT *` ignores it, inserts list columns explicitly), so it sits inert.

**Optional backfill** for topics already stuck with a placeholder name. Safe to run any time
after the worker deploy (the worker itself stops minting new placeholder names at that point,
regardless of daemon versions):

```bash
npx wrangler d1 execute pigeon-router --remote \
  --command "UPDATE topics SET name_provisional = 1 WHERE name LIKE 'New session - ____-__-__T%';"
```

The date-shaped `LIKE` (rather than a bare `New session - %`) is deliberate: a human who used
`/rename` to a name that happens to start with those words must not be dragged back into
automatic renaming.

Backfilled rows are renamed lazily, by the next notification that carries a real title. A session
that is already dead will keep its placeholder name until the reaper deletes the topic.

---

## Operational Reference & Handy Commands

### Worker API Authentication
The worker API endpoints require HTTP Bearer authentication using `CCR_API_KEY`:
```bash
# Correct:
curl -s -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"

# INCORRECT: Do NOT use x-api-key header.
```

### Manual Probe Polling (Safe Testing)
To test command polling against production worker without stealing/leasing commands from live daemons, poll using a **dummy probe machine ID**:
```bash
curl -s -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/machines/nonexistent-probe-machine/next"
```
**Expected Result:** HTTP `204 No Content` (confirms poll endpoint and SQL queries execute cleanly).

### Local Daemon API Authentication
The local daemon at `http://127.0.0.1:4731` is deny-by-default (except `GET /health`):
```bash
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" \
  "http://127.0.0.1:4731/swarm/inbox"
```

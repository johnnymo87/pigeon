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

- **`pigeon-cev`** (P1): Four live Telegram questions requiring verification:
  1. `wrangler deploy` override behavior against Cloudflare Dashboard `[vars]` (Settled: `wrangler.toml` wins).
  2. Can an admin bot post into a closed topic?
  3. What error/status does Telegram return when reopening or posting into a closed topic?
  4. Does Telegram return `message_thread_id` on callback queries / service messages?
- **`pigeon-cal`** (P1): Webhook confirmations in closed topics (decided by `pigeon-cev` item 3).
- **`pigeon-5o7`** (P2): Scope `deleteTopicBySession` to thread ID.
- **`pigeon-wly`** (P3): Reap-loop generic failures pinning head-of-line slots (accepted residual).

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
<summary>Reference DDL (for new environments / rebuilds from scratch)</summary>

```sql
CREATE TABLE IF NOT EXISTS topics (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT,
  chat_id TEXT NOT NULL,
  message_thread_id INTEGER,
  name TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread 
  ON topics (chat_id, message_thread_id) 
  WHERE message_thread_id IS NOT NULL;

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
5. Update `TELEGRAM_CHAT_ID` in host secrets on each target machine (devbox, cloudbox) to point to the new supergroup `chat_id`.
6. Restart daemon service on each host:
   ```bash
   sudo systemctl restart pigeon-daemon
   ```
7. Verify daemon health:
   ```bash
   curl -s http://127.0.0.1:4731/health
   ```
   **Expected Result:** `{"status":"ok"}`

---

### Step 5: Burn-In & Monitoring

1. Tail worker logs to monitor real-time activity and rate limits:
   ```bash
   npx wrangler tail --workspace packages/worker
   ```
2. Check for Telegram 429 rate limits or delivery errors in the logs.
3. Send a test command in a topic in the supergroup (e.g., `/current-state`).
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

1. Edit `packages/worker/wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_CHAT_IDS = "8248645256"  # DM chat ID
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

### What Reverts vs. What Does NOT Revert

- **Reverts:** Commands and notifications immediately return to single DM behavior.
- **Does NOT Revert (Harmless):**
  - Existing Telegram topics in the supergroup remain created in Telegram.
  - Rows in the D1 `topics` table remain (flag-off code never queries or writes to `topics`).
  - The `commands.message_thread_id` column remains in D1 (additive schema, fully ignored when unpopulated).

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

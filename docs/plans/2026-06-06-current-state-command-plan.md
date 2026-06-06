# `/current-state` Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/current-state [machine]` Telegram command that surveys the `main` tmux session's opencode TUIs and replies with an index message plus one swipe-reply "state card" per session (active/idle + summary).

**Architecture:** Worker (`webhook.ts`) matches the command and queues a new `current_state` command type to one machine (default `cloudbox`). The daemon poller dispatches to a new `current-state-ingest.ts`, which enumerates the `main`-session allowlist (tmux + pgrep + /proc, same definition as `reset-workspace`), enriches each sid via opencode serve, registers each sid with the worker, then sends an index header + per-session cards via `poller.sendNotification` (which makes each card a swipe-reply handle).

**Tech Stack:** TypeScript, Node, vitest. Monorepo workspaces `@pigeon/worker` (Cloudflare) and the daemon package.

**Design:** `docs/plans/2026-06-06-current-state-command-design.md`

---

## Implementation refinements discovered during planning

These supersede the design doc where they conflict (the UX is unchanged):

- **Per-session registration is required.** The worker's `handleSendNotification` 404s if the session isn't in its `sessions` table, and swipe-reply routing reads `machine_id` from that row. So the ingest must call `poller.registerSession(sid, label)` for each enumerated sid *before* sending its card.
- **No new notifier method.** Reuse `poller.sendNotification(sid, chatId, text, { inline_keyboard: [] }, undefined, undefined, entities)` to send each card; the worker stores the `message_id→session` mapping (the handle). `sendStateCard()` from the design is dropped; we add only a pure `formatStateCard()` formatter.
- **Binary paths must be configurable.** The daemon's systemd PATH is locked down (see `OC_AUTO_ATTACH_BIN` precedent in `launch-ingest.ts`). The enumeration shells out to `tmux` and `pgrep`, so accept their paths via `process.env.TMUX_BIN` / `process.env.PGREP_BIN` (defaults `"tmux"` / `"pgrep"`) and ensure the unit provides them at deploy time.

---

## Conventions

- Run tests for one package: `npm run --workspace @pigeon/daemon test` / `--workspace @pigeon/worker test`. Single file: `npx vitest run packages/daemon/test/<file>.test.ts`.
- Typecheck: `npm run typecheck` (root, all workspaces).
- Commit after each task with a `feat:`/`test:` message.
- TDD: write the failing test, run it red, implement minimally, run it green, commit. Reference @superpowers:test-driven-development.

---

## Task 1: Worker — `/current-state [machine]` command parsing

**Files:**
- Modify: `packages/worker/src/webhook.ts` (add to `CommandType` union near line 5; add a handler block inside the `if (update.message?.text)` section, alongside the `/launch` block ~line 541).
- Test: `packages/worker/test/worker.test.ts` (mirror existing `/launch` tests).

**Step 1: Write the failing test**

In `worker.test.ts`, add a describe block. Assert that a `/current-state` message:
- with no arg queues a command with `commandType: "current_state"`, `machineId: "cloudbox"`, `sessionId: null` when cloudbox is recent;
- with `/current-state devbox` targets `devbox`;
- replies "`<machine>` is not recently seen." when the machine is stale (no command queued).

Use the existing test harness (mock D1 / `isMachineRecent`) the `/launch` tests already use as the template.

**Step 2: Run red** — `npx vitest run packages/worker/test/worker.test.ts` → FAIL (no handler).

**Step 3: Implement**

Add `"current_state"` to the `CommandType` union (line 5). Inside `if (update.message?.text) { … }`, before the generic message handling, add:

```typescript
const currentStateMatch = update.message.text.match(/^\/current-state(?:\s+(\S+))?$/);
if (currentStateMatch) {
  const csChatId = update.message.chat.id;
  const machineId = currentStateMatch[1] ?? "cloudbox";

  const isRecent = await isMachineRecent(db, machineId);
  if (!isRecent) {
    await sendTelegramMessage(env, csChatId, `${machineId} is not recently seen.`);
    return OK();
  }

  const commandId = await queueCommand(
    db, env, machineId, null, "", String(csChatId), null, "current_state",
  );
  if (!commandId) return OK();

  await sendTelegramMessage(env, csChatId, `Fetching current state on ${machineId}…`);
  return OK();
}
```

**Step 4: Run green** — same vitest command → PASS.

**Step 5: Commit** — `git add -A && git commit -m "feat(worker): parse /current-state [machine] command"`

---

## Task 2: Worker — shape `current_state` in the poll response

**Files:**
- Modify: `packages/worker/src/poll.ts` (the `handlePollNext` command-shaping if/else, ~line 36).
- Test: `packages/worker/test/worker.test.ts`.

**Step 1: Write the failing test** — assert that when `pollNextCommand` returns a `current_state` row, the JSON body is exactly `{ commandId, commandType: "current_state", chatId }` (NO `sessionId`/`command` keys — it must not fall through to the `execute` default that would add an empty command).

**Step 2: Run red.**

**Step 3: Implement** — add an explicit branch (it needs no extra fields beyond the common ones already set):

```typescript
} else if (result.commandType === "current_state") {
  // No extra fields; the daemon uses its own machineId + enumerates locally.
} else if (...) // existing branches
```

Place it before the `else` (execute) default so it doesn't get `sessionId`/`command`.

**Step 4: Run green. Step 5: Commit** — `feat(worker): shape current_state poll response`.

---

## Task 3: Daemon poller — `CurrentStateMessage` type, callback, dispatch

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts` (add interface, extend `WorkerMessage`, `PollerCallbacks`, and `dispatch()`).
- Test: `packages/daemon/test/poller.test.ts`.

**Step 1: Write the failing test** — a poll returning `{ commandId, commandType: "current_state", chatId }` calls `callbacks.onCurrentState` with that message and acks. Mirror the existing `onLaunch` dispatch test.

**Step 2: Run red.**

**Step 3: Implement**

```typescript
export interface CurrentStateMessage {
  commandId: string;
  commandType: "current_state";
  chatId: string;
}
```
Add `| CurrentStateMessage` to `WorkerMessage`; add `onCurrentState: (msg: CurrentStateMessage) => Promise<void>;` to `PollerCallbacks`; add to `dispatch()`:
```typescript
} else if (msg.commandType === "current_state") {
  await this.callbacks.onCurrentState(msg);
```

**Step 4: Run green. Step 5: Commit** — `feat(daemon): route current_state in poller`.

---

## Task 4: Daemon — `main`-session allowlist enumeration

**Files:**
- Create: `packages/daemon/src/main-session-allowlist.ts`
- Test: `packages/daemon/test/main-session-allowlist.test.ts`

Pure module with injected readers so it's testable without a live tmux/process tree.

**Step 1: Write the failing tests** — for `enumerateMainSessionSids(deps)` where deps inject:
- `listMainPanePids(): Promise<number[]>`
- `childrenOf(pid: number): Promise<number[]>` (one level; the function recurses)
- `readCmdline(pid: number): Promise<string>` (NUL-joined argv as space string)
- `readCwd(pid: number): Promise<string | null>`
- `resolveSidByDir(dir: string): Promise<string | null>` (opencode serve lookup)

Assert:
- argv branch: a pid in the main subtree whose cmdline contains `opencode attach … --session ses_ABC` yields `ses_ABC`.
- subtree walk: a grandchild pid is included.
- bare branch: a main-subtree pid whose cmdline is bare `…/opencode` (no `--session`) and whose cwd resolves to `ses_XYZ` yields `ses_XYZ`.
- dedupe: same sid via two pids appears once.
- empty: no main panes → `[]`.

**Step 2: Run red.**

**Step 3: Implement** — signature + logic:

```typescript
export interface AllowlistDeps {
  listMainPanePids: () => Promise<number[]>;
  childrenOf: (pid: number) => Promise<number[]>;
  readCmdline: (pid: number) => Promise<string>;
  readCwd: (pid: number) => Promise<string | null>;
  resolveSidByDir: (dir: string) => Promise<string | null>;
}

const SID_RE = /(?:^|\s)--session\s+(ses_[A-Za-z0-9]+)(?:\s|$)/;
const ATTACH_RE = /\/opencode\s+attach\s/;

export async function enumerateMainSessionSids(deps: AllowlistDeps): Promise<string[]> {
  const seen = new Set<number>();
  const stack = await deps.listMainPanePids();
  const subtree: number[] = [];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    subtree.push(pid);
    stack.push(...await deps.childrenOf(pid));
  }
  const sids = new Set<string>();
  for (const pid of subtree) {
    const cmd = await deps.readCmdline(pid);
    if (!cmd) continue;
    if (ATTACH_RE.test(cmd)) {
      const m = cmd.match(SID_RE);
      if (m) { sids.add(m[1]!); continue; }
    }
    // bare-cwd branch: a `…/opencode` TUI with no subcommand/--session
    if (/\/opencode(\s|$)/.test(cmd) && !/\/opencode\s+\S/.test(cmd)) {
      const cwd = await deps.readCwd(pid);
      if (cwd) {
        const sid = await deps.resolveSidByDir(cwd);
        if (sid && /^ses_[A-Za-z0-9]+$/.test(sid)) sids.add(sid);
      }
    }
  }
  return [...sids];
}
```

(Refine the bare-vs-attach discrimination in tests; the argv branch is the primary path. Keep the `reset-workspace` exe-filter spirit: callers should only pass opencode processes — see Task 7 wiring.)

**Step 4: Run green. Step 5: Commit** — `feat(daemon): main-session allowlist enumeration`.

---

## Task 5: Daemon — live-readers + opencode enrichment helpers

**Files:**
- Modify: `packages/daemon/src/main-session-allowlist.ts` (add `makeLiveDeps()` that builds `AllowlistDeps` from real `tmux`/`pgrep`/`/proc`).
- Create: `packages/daemon/src/current-state-enrich.ts` (pure classify + snippet).
- Modify: `packages/daemon/src/opencode-client.ts` (add `listSessionsByDirectory` if needed for `resolveSidByDir`; opencode serve `GET /session?directory=…&roots=true&limit=1`).
- Test: `packages/daemon/test/current-state-enrich.test.ts`.

**Step 1: Write the failing tests** for `classifyActivity(messages)` and `snippetFromMessages(messages)`:
- last message assistant with `time.completed` set → `"idle"`.
- last message assistant without `time.completed` → `"active"`.
- last message role `user` → `"active"`.
- empty array → `"idle"` (nothing running).
- snippet returns the last assistant text part trimmed to 200 chars, or `""`.

**Step 2: Run red.**

**Step 3: Implement** `classifyActivity` / `snippetFromMessages` operating on the opencode `/message` shape (`{ info: { role, time: { completed? } }, parts: [{ type, text }] }`). For `makeLiveDeps`:
- `listMainPanePids`: `execFile(TMUX_BIN, ["list-panes","-s","-t","=main","-F","#{pane_pid}"])`, parse ints; on error → `[]`.
- `childrenOf`: `execFile(PGREP_BIN, ["-P", String(pid)])`.
- `readCmdline`: read `/proc/<pid>/cmdline`, replace NUL with space; verify `/proc/<pid>/exe` basename matches `/^\.?opencode(-wrapped)?$/` (the exe filter), else return `""`.
- `readCwd`: `readlink(/proc/<pid>/cwd)`.
- `resolveSidByDir`: `opencodeClient` GET `/session?directory=…&roots=true&limit=1` → `.[0].id`.
  `TMUX_BIN = process.env.TMUX_BIN ?? "tmux"`, `PGREP_BIN = process.env.PGREP_BIN ?? "pgrep"`.

**Step 4: Run green. Step 5: Commit** — `feat(daemon): current-state enrichment + live allowlist readers`.

---

## Task 6: Daemon — `formatStateCard` + index formatter

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (add exported pure `formatStateCard` and `formatCurrentStateIndex` using `TgMessageBuilder`).
- Test: `packages/daemon/test/notification-service.test.ts` (or a new `current-state-format.test.ts`).

**Step 1: Write the failing tests** asserting:
- `formatStateCard({ title, status, dir, sid, snippet, lastActivity, machineId })` produces text starting with the status emoji + title, includes the snippet, `📂 <dir-short>`, `🆔 <sid>`, `🖥 <machine>`, `↩️ Swipe-reply to respond`, and a relative time; returns `{ text, entities }`.
- `formatCurrentStateIndex({ machineId, sessions: [{title, status}] })` produces a header with the count line (`N main sessions · X 🟢 active · Y ⚪ idle`) and a numbered list.

**Step 2: Run red.**

**Step 3: Implement** both with `TgMessageBuilder` (see existing `formatTelegramNotification` for the entity/builder pattern). Add a small `relativeTime(ms, now)` helper ("just now", "2m ago", "3h ago", "2d ago").

**Step 4: Run green. Step 5: Commit** — `feat(daemon): current-state card + index formatters`.

---

## Task 7: Daemon — `current-state-ingest.ts` orchestration

**Files:**
- Create: `packages/daemon/src/worker/current-state-ingest.ts`
- Test: `packages/daemon/test/current-state-ingest.test.ts`

**Step 1: Write the failing tests** with all deps mocked. `ingestCurrentStateCommand(input)` where input has:
`{ commandId, chatId, machineId, opencodeClient, allowlistDeps, registerSession, sendCard, sendPlainText }`.

Assert:
- Given `enumerateMainSessionSids` → `[ses_A, ses_B]`, and `opencodeClient.getSession`/`getSessionMessages` returning known title/messages, it: registers both sids; sends one index message (via `sendPlainText`) then one card per sid (via `sendCard`) **ordered by last-activity desc**; **no cap**.
- A sid that 404s on `getSession` is skipped and the index count reflects "(1 unreadable)".
- Zero sids → single "No main-session TUIs found on `<machine>`." via `sendPlainText`, no cards.
- opencode serve unhealthy (`healthCheck()` false) → single "opencode serve is not running on `<machine>`." and returns.
- A `sendCard` rejection is caught (best-effort) and does not abort remaining cards.

**Step 2: Run red.**

**Step 3: Implement** the orchestration:
1. `if (!await opencodeClient.healthCheck()) { await sendPlainText("opencode serve is not running on " + machineId + "."); return; }`
2. `const sids = await enumerateMainSessionSids(allowlistDeps);`
3. For each sid: `getSession` (skip on null/404, increment `unreadable`), `getSessionMessages` → `classifyActivity` + `snippetFromMessages` + last-activity time → build a record.
4. Sort records by lastActivity desc.
5. `sendPlainText(formatCurrentStateIndex(...))` (or the "none found" message).
6. For each record: `await registerSession(sid, title)`, then `try { await sendCard(sid, card.text, card.entities) } catch (e) { console.warn(...) }`.

`sendCard(sid, text, entities)` and `sendPlainText(text, entities?)` are injected; `registerSession(sid, label)` injected.

**Step 4: Run green. Step 5: Commit** — `feat(daemon): current-state ingest orchestration`.

---

## Task 8: Daemon — wire `onCurrentState` in `index.ts`

**Files:**
- Modify: `packages/daemon/src/index.ts` (poller callbacks block, after `onModelSet` ~line 170; imports near other `ingest*` imports ~line 17).

**Step 1:** (Wiring; covered by an integration assertion if practical, else manual.) Add the callback:

```typescript
onCurrentState: async (msg) => {
  if (!opencodeClient) { console.warn("[index] onCurrentState: no opencodeClient configured"); return; }
  await ingestCurrentStateCommand({
    commandId: msg.commandId,
    chatId: msg.chatId,
    machineId: config.machineId,
    opencodeClient,
    allowlistDeps: makeLiveDeps(opencodeClient),
    registerSession: (sid, label) => poller!.registerSession(sid, label),
    sendCard: (sid, text, entities) =>
      poller!.sendNotification(sid, msg.chatId, text, { inline_keyboard: [] }, undefined, undefined, entities),
    sendPlainText: (text, entities) => sendTelegramMessage(msg.chatId, text, entities),
  });
},
```

(Mirrors the `poller!.editNotification` self-reference precedent in `onCommand`.)

**Step 2:** `npm run typecheck` → PASS. **Step 3: Commit** — `feat(daemon): wire /current-state ingest`.

---

## Task 9: Full verification + deploy

**Step 1:** `npm run typecheck` and `npm run test` (root) → all green.

**Step 2: Dogfood on cloudbox (pre-deploy sanity).** With the daemon built locally, confirm enumeration works in the daemon's environment:
- Verify `tmux`/`pgrep` resolve for the daemon (check the systemd unit PATH or set `TMUX_BIN`/`PGREP_BIN`). The `oc-auto-attach` precedent shows tmux is reachable from the daemon's spawned children, but the daemon process calling `execFile('tmux', …)` directly needs it on PATH — verify and, if missing, add to the unit env (see `cross-device-deployment`).

**Step 3: Deploy.**
- Worker: `npm run --workspace @pigeon/worker deploy`.
- Daemon: `git pull && npm install`, restart the daemon service on cloudbox (per `cross-device-deployment`).

**Step 4: Live test.** From Telegram, send `/current-state`. Expect: ack, an index message, and one swipe-reply card per `main` TUI, each labeled active/idle. Swipe-reply to one card with a plain message and confirm it routes to that session.

**Step 5: Close out.** Update `AGENTS.md` Commands table with `/current-state [machine]`. Commit `docs(agents): document /current-state`. File follow-up issues for any rough edges (e.g. extract shared `main-session-sids` helper if drift becomes a concern — design Approach B).

---

## Risks / watch-items

- **tmux/pgrep reachability from the daemon process** (Task 5/9) — the main deployment risk. Pin via `TMUX_BIN`/`PGREP_BIN` env if not on PATH.
- **tmux socket** — the daemon must see the user's `main` session (same `TMUX_TMPDIR`/socket the interactive session uses). Verify in Task 9.
- **Unregistered sessions** — handled by registering each sid before sending its card (Task 7).
- **Enumeration drift** vs `reset-workspace` — acceptable for v1; lift to a shared helper later if needed.

# Bounded swarm_read Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `swarm_read` return the N most-recent delivered messages (default 25) with a truncation breadcrumb, instead of dumping the entire inbox history and overwhelming the caller's context.

**Architecture:** Three layers in `~/projects/pigeon/`: (1) `SwarmRepository.getInbox` gains `limit`/`since` options and returns `{ messages, total }`, fetching the most-recent N via `ORDER BY msg_id DESC LIMIT` then reversing to chronological order; (2) the `GET /swarm/inbox` route applies `DEFAULT_INBOX_LIMIT = 25` server-side (so the bound lands on daemon restart, even for old plugins) and returns `total`/`returned`; (3) the `swarm_read` plugin tool adds a `limit` arg and renders a breadcrumb when truncated. Plus a workstation skill-doc update.

**Tech Stack:** TypeScript, better-sqlite3, vitest. Two npm workspaces: `packages/daemon`, `packages/opencode-plugin`.

**Design doc:** `docs/plans/2026-07-02-bounded-swarm-read-design.md`

**Before you start:** run the baseline so you know the suite is green.
```bash
cd ~/projects/pigeon && npm run --workspaces typecheck && npm test
```

---

### Task 1: Storage — `getInbox` count-bounded, returns `{ messages, total }`

**Files:**
- Modify: `packages/daemon/src/storage/swarm-repo.ts:148-170`
- Test: `packages/daemon/test/swarm-repo.test.ts:70-81` (rewrite) + new cases

**Step 1: Update the existing test + add new ones**

Replace the existing `getInbox` test (`swarm-repo.test.ts:70-81`) with the block below. Note the new return shape `{ messages, total }` and the options-object signature.

```ts
it("getInbox returns delivered messages for a session, ordered ascending", () => {
  const s = createStorage();
  s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
  s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
  s.swarm.markHandedOff("m1", 1_500);
  s.swarm.markHandedOff("m2", 2_500);
  const inbox = s.swarm.getInbox("ses_b", {});
  expect(inbox.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
  expect(inbox.total).toBe(2);
  const since = s.swarm.getInbox("ses_b", { since: "m1" });
  expect(since.messages.map((m) => m.msgId)).toEqual(["m2"]);
  expect(since.total).toBe(1);
  s.db.close();
});

it("getInbox with a limit returns the N most recent in chronological order", () => {
  const s = createStorage();
  for (let i = 1; i <= 5; i++) {
    s.swarm.insert({ ...BASE, msgId: `m${i}` }, i * 1_000);
    s.swarm.markHandedOff(`m${i}`, i * 1_000 + 500);
  }
  const page = s.swarm.getInbox("ses_b", { limit: 2 });
  // most-recent 2 (m4, m5) but presented oldest->newest
  expect(page.messages.map((m) => m.msgId)).toEqual(["m4", "m5"]);
  // total reflects the full matching set, not the returned count
  expect(page.total).toBe(5);
  s.db.close();
});

it("getInbox composes since + limit (N most recent that are newer than cursor)", () => {
  const s = createStorage();
  for (let i = 1; i <= 5; i++) {
    s.swarm.insert({ ...BASE, msgId: `m${i}` }, i * 1_000);
    s.swarm.markHandedOff(`m${i}`, i * 1_000 + 500);
  }
  const page = s.swarm.getInbox("ses_b", { since: "m1", limit: 2 });
  expect(page.messages.map((m) => m.msgId)).toEqual(["m4", "m5"]);
  expect(page.total).toBe(4); // m2..m5 are newer than m1
  s.db.close();
});

it("getInbox with limit=null returns full history", () => {
  const s = createStorage();
  for (let i = 1; i <= 3; i++) {
    s.swarm.insert({ ...BASE, msgId: `m${i}` }, i * 1_000);
    s.swarm.markHandedOff(`m${i}`, i * 1_000 + 500);
  }
  const page = s.swarm.getInbox("ses_b", { limit: null });
  expect(page.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]);
  expect(page.total).toBe(3);
  s.db.close();
});
```

> Note on `msg_id` ordering: this test uses `m1`..`m5`, which sort lexicographically the same as numerically for single digits. Keep the count ≤ 9 so string ordering matches intent (production `msg_id`s are time-sortable base36, so this is a faithful stand-in).

**Step 2: Run the test to verify it fails**

Run: `npm test -w @pigeon/daemon -- swarm-repo`
Expected: FAIL — `getInbox` still returns an array (`.messages` undefined) / signature mismatch.

**Step 3: Implement**

Replace `getInbox` (`swarm-repo.ts:148-170`) with:

```ts
  getInbox(
    toSession: string,
    opts: { since?: string | null; limit?: number | null } = {},
  ): { messages: SwarmMessageRecord[]; total: number } {
    const since = opts.since ?? null;
    const limit = opts.limit === undefined ? null : opts.limit;

    const where = ["to_session = ?", "state = 'handed_off'"];
    const params: unknown[] = [toSession];
    if (since !== null) {
      where.push("msg_id > ?");
      params.push(since);
    }
    const whereSql = where.join(" AND ");

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM swarm_messages WHERE ${whereSql}`)
        .get(...params) as { n: number }
    ).n;

    let rows: Row[];
    if (limit === null) {
      rows = this.db
        .prepare(
          `SELECT * FROM swarm_messages WHERE ${whereSql} ORDER BY msg_id ASC`,
        )
        .all(...params) as Row[];
    } else {
      // Fetch the most-recent N (DESC + LIMIT), then reverse to chronological ASC.
      rows = (
        this.db
          .prepare(
            `SELECT * FROM swarm_messages WHERE ${whereSql} ORDER BY msg_id DESC LIMIT ?`,
          )
          .all(...params, limit) as Row[]
      ).reverse();
    }
    return { messages: rows.map(asRecord), total };
  }
```

(The `${whereSql}` interpolation is safe: the clause strings are static literals; all values are bound params.)

**Step 4: Run the test to verify it passes**

Run: `npm test -w @pigeon/daemon -- swarm-repo`
Expected: PASS (all cases).

**Step 5: Commit**

```bash
git add packages/daemon/src/storage/swarm-repo.ts packages/daemon/test/swarm-repo.test.ts
git commit -m "feat(swarm): getInbox supports limit/since options, returns {messages,total}"
```

---

### Task 2: Route — `/swarm/inbox` default limit + `total`/`returned`

**Files:**
- Modify: `packages/daemon/src/app.ts` (add `DEFAULT_INBOX_LIMIT` const near top; rewrite handler at `:186-205`)
- Test: `packages/daemon/test/swarm-routes.test.ts:208-274` (append cases)

**Step 1: Add failing route tests**

Append inside the `describe("GET /swarm/inbox", ...)` block (before its closing `});` at `swarm-routes.test.ts:274`). Reuse the existing `insert`+`markHandedOff` pattern from lines 217-248.

```ts
  it("defaults to the 25 most recent and reports total/returned", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    for (let i = 1; i <= 30; i++) {
      const id = `m${String(i).padStart(2, "0")}`; // m01..m30 sort correctly
      storage.swarm.insert(
        {
          msgId: id,
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: `p${i}`,
        },
        i * 1_000,
      );
      storage.swarm.markHandedOff(id, i * 1_000 + 500);
    }
    const res = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ msg_id: string }>;
      total: number;
      returned: number;
      limit: number;
    };
    expect(body.total).toBe(30);
    expect(body.returned).toBe(25);
    expect(body.limit).toBe(25);
    expect(body.messages).toHaveLength(25);
    // most-recent 25 => m06..m30, chronological
    expect(body.messages[0]!.msg_id).toBe("m06");
    expect(body.messages[24]!.msg_id).toBe("m30");
  });

  it("honors an explicit limit", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    for (let i = 1; i <= 5; i++) {
      storage.swarm.insert(
        {
          msgId: `m${i}`,
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: `p${i}`,
        },
        i * 1_000,
      );
      storage.swarm.markHandedOff(`m${i}`, i * 1_000 + 500);
    }
    const res = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b&limit=2"),
    );
    const body = (await res.json()) as {
      messages: Array<{ msg_id: string }>;
      total: number;
    };
    expect(body.total).toBe(5);
    expect(body.messages.map((m) => m.msg_id)).toEqual(["m4", "m5"]);
  });

  it("rejects a malformed limit with 400", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });
    for (const bad of ["0", "-3", "abc", "1.5", ""]) {
      const res = await app(
        new Request(`http://localhost/swarm/inbox?session=ses_b&limit=${bad}`),
      );
      expect(res.status).toBe(400);
    }
  });
```

**Step 2: Run to verify it fails**

Run: `npm test -w @pigeon/daemon -- swarm-routes`
Expected: FAIL — `total`/`returned` undefined; malformed limits return 200 not 400.

**Step 3: Implement**

Add a module-level constant near the top of `app.ts` (below imports):

```ts
/** Default number of most-recent swarm messages returned by GET /swarm/inbox. */
export const DEFAULT_INBOX_LIMIT = 25;
```

Replace the handler (`app.ts:186-205`) with:

```ts
      if (request.method === "GET" && url.pathname === "/swarm/inbox") {
        const sessionId = url.searchParams.get("session");
        if (!sessionId) return Response.json({ error: "session is required" }, { status: 400 });
        const since = url.searchParams.get("since");

        const limitParam = url.searchParams.get("limit");
        let limit = DEFAULT_INBOX_LIMIT;
        if (limitParam !== null) {
          const parsed = Number(limitParam);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return Response.json(
              { error: "limit must be a positive integer" },
              { status: 400 },
            );
          }
          limit = parsed;
        }

        const { messages, total } = storage.swarm.getInbox(sessionId, { since, limit });
        return Response.json({
          total,
          returned: messages.length,
          limit,
          messages: messages.map((m) => ({
            msg_id: m.msgId,
            from: m.fromSession,
            to: m.toSession,
            channel: m.channel,
            kind: m.kind,
            priority: m.priority,
            reply_to: m.replyTo,
            payload: m.payload,
            created_at: m.createdAt,
            handed_off_at: m.handedOffAt,
          })),
        });
      }
```

(The existing "returns delivered messages ... supports `since`" test at `:217-266` has only 2 messages, well under 25, so it stays green unchanged.)

**Step 4: Run to verify it passes**

Run: `npm test -w @pigeon/daemon -- swarm-routes`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/daemon/src/app.ts packages/daemon/test/swarm-routes.test.ts
git commit -m "feat(swarm): default GET /swarm/inbox to 25 most recent, add total/returned"
```

---

### Task 3: Plugin — `limit` arg, breadcrumb, docstring fix

**Files:**
- Modify: `packages/opencode-plugin/src/swarm-tool.ts` (types, `swarmRead`, `formatInbox`, tool schema, header docstring)
- Test: `packages/opencode-plugin/test/swarm-tool.test.ts` (update existing, add breadcrumb + limit cases)

**Step 1: Update + add failing tests**

In `swarm-tool.test.ts`:

1. `swarmRead` now returns `{ messages, total, returned, limit }`. Update the three existing assertions that treat the result as an array:
   - Line 88-94: rename `const messages = await swarmRead(...)` → `const result = await swarmRead(...)` and assert `expect(result.messages).toEqual(SAMPLE_MESSAGES)`.
   - Line 112-119: change the call `swarmRead({...}, "msg_aaa")` → `swarmRead({...}, { since: "msg_aaa" })`.
   - Line 156-160: `const result = await swarmRead(...)` then `expect(result.messages).toEqual(SAMPLE_MESSAGES)`.

2. Add a `limit` forwarding test in the `swarmRead` describe block:

```ts
  test("forwards `limit` as a query param", async () => {
    const seenUrls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: [], total: 0, returned: 0, limit: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    await swarmRead(
      { daemonBaseUrl: "http://daemon.test", sessionId: "ses_target", fetchFn },
      { limit: 5 },
    )
    const url = new URL(seenUrls[0]!)
    expect(url.searchParams.get("limit")).toBe("5")
  })
```

3. Add breadcrumb tests to the `formatInbox` describe block:

```ts
  test("appends a truncation breadcrumb when total exceeds returned", () => {
    const out = formatInbox(SAMPLE_MESSAGES, { total: 340 })
    expect(out).toContain("most recent of 340")
    expect(out).toContain("338 older hidden")
    expect(out).toContain("limit=340")
    // newest shown msg_id is the second sample (chronological last)
    expect(out).toContain("Newest msg_id: msg_bbb")
  })

  test("omits the breadcrumb when total equals returned", () => {
    const out = formatInbox(SAMPLE_MESSAGES, { total: 2 })
    expect(out).not.toContain("older hidden")
  })
```

4. Update the `createSwarmReadTool` tests:
   - In the "builds a ToolDefinition" test, add: `expect(def.args).toHaveProperty("limit")`.
   - In the "execute()" test, the metadata assertion (lines 238-243) must change (title + fields). Replace with:

```ts
      expect(metadataCalls).toEqual([
        {
          title: "swarm inbox (2 of 2)",
          metadata: { count: 2, total: 2, since: null, limit: null },
        },
      ])
```

**Step 2: Run to verify it fails**

Run: `npm test -w opencode-plugin -- swarm-tool`
(If the workspace name differs, use `npm test -w packages/opencode-plugin -- swarm-tool`.)
Expected: FAIL — return shape, missing `limit` arg, no breadcrumb, metadata mismatch.

**Step 3: Implement**

In `swarm-tool.ts`:

(a) Fix the header docstring (`:15-18`) — replace the false retention claim:

```ts
 * Args:
 *   since: optional msg_id cursor; only messages newer than it are returned.
 *   limit: optional cap on how many of the most-recent messages to return
 *          (the daemon defaults to 25 when omitted).
```

(b) Add result/params types (after `SwarmInboxMessage`, ~`:44`):

```ts
export interface SwarmInboxResult {
  messages: SwarmInboxMessage[]
  total: number
  returned: number
  limit: number | null
}

export interface SwarmReadParams {
  since?: string
  limit?: number
}
```

(c) Replace `swarmRead` (`:51-67`):

```ts
export async function swarmRead(
  opts: SwarmReadOptions,
  params: SwarmReadParams = {},
): Promise<SwarmInboxResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const url = new URL("/swarm/inbox", opts.daemonBaseUrl)
  url.searchParams.set("session", opts.sessionId)
  if (params.since) url.searchParams.set("since", params.since)
  if (params.limit !== undefined) url.searchParams.set("limit", String(params.limit))

  const res = await fetchFn(url.toString())
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`swarm_read failed: ${res.status} ${body}`)
  }
  const body = (await res.json()) as {
    messages: SwarmInboxMessage[]
    total?: number
    returned?: number
    limit?: number | null
  }
  const messages = body.messages ?? []
  return {
    messages,
    total: body.total ?? messages.length,
    returned: body.returned ?? messages.length,
    limit: body.limit ?? null,
  }
}
```

(d) Replace `formatInbox` (`:74-87`) with the meta-aware version:

```ts
export function formatInbox(
  messages: SwarmInboxMessage[],
  meta?: { total?: number },
): string {
  if (messages.length === 0) {
    return "Inbox is empty."
  }
  const blocks = messages.map((m) => {
    const replyTo = m.reply_to ? ` reply_to=${m.reply_to}` : ""
    const ts = new Date(m.created_at).toISOString()
    return [
      `--- msg_id=${m.msg_id} from=${m.from} kind=${m.kind} priority=${m.priority}${replyTo} at=${ts} ---`,
      m.payload,
    ].join("\n")
  })
  let out = blocks.join("\n\n")
  const total = meta?.total
  if (total !== undefined && total > messages.length) {
    const hidden = total - messages.length
    const newest = messages[messages.length - 1]!.msg_id
    out +=
      `\n\n[showing the ${messages.length} most recent of ${total} delivered messages — ` +
      `${hidden} older hidden. Pass limit=${total} to include them. ` +
      `Newest msg_id: ${newest} — pass as since= next time to fetch only newer.]`
  }
  return out
}
```

(e) Replace `createSwarmReadTool` (`:94-119`):

```ts
export function createSwarmReadTool(daemonBaseUrl: string): ToolDefinition {
  return tool({
    description:
      "Read swarm messages addressed to the current session from the pigeon daemon. " +
      "Returns the most recent messages (default 25). " +
      "Use this to check for backlog or messages that weren't pushed via prompt_async (e.g. low-priority chatter). " +
      "Pass `since` to fetch only messages newer than a known msg_id, or `limit` to change how many recent messages are returned.",
    args: {
      since: tool.schema
        .string()
        .optional()
        .describe(
          "Optional msg_id cursor. When provided, only messages with msg_id > this value are returned.",
        ),
      limit: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max number of most-recent messages to return (default 25). Pass the `total` shown in a truncation note to fetch everything.",
        ),
    },
    async execute(args, ctx) {
      const result = await swarmRead(
        { daemonBaseUrl, sessionId: ctx.sessionID },
        { since: args.since, limit: args.limit },
      )
      ctx.metadata({
        title: `swarm inbox (${result.returned} of ${result.total})`,
        metadata: {
          count: result.returned,
          total: result.total,
          since: args.since ?? null,
          limit: args.limit ?? null,
        },
      })
      return formatInbox(result.messages, { total: result.total })
    },
  })
}
```

**Step 4: Run to verify it passes**

Run: `npm test -w opencode-plugin -- swarm-tool`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/swarm-tool.ts packages/opencode-plugin/test/swarm-tool.test.ts
git commit -m "feat(swarm): swarm_read limit arg + truncation breadcrumb, fix retention docstring"
```

---

### Task 4: Workstation — update the swarm-messaging skill doc

**Files:**
- Modify: `~/projects/workstation/assets/opencode/skills/swarm-messaging/SKILL.md` (the source; it deploys to `~/.config/opencode/skills/`)

**Step 1: Edit the Replay section**

Find the "## Replay" section. Update it to document the default and the new `limit` arg. Replace its body with:

```markdown
## Replay

If you suspect you missed messages (e.g. you were busy on a long tool call), call the **`swarm_read`** tool. By default it returns the **25 most recent** delivered messages — enough to catch up without flooding your context. When it truncates, the output ends with a breadcrumb telling you the total, how many are hidden, and the newest `msg_id` (use it as `since=` next time).

- Pass `since: <msg_id>` to fetch only messages newer than a known cursor (ideal right after a compaction/resume — persist the last-seen `msg_id` and resume from it).
- Pass `limit: <n>` to change how many recent messages you get; the breadcrumb shows the `total`, so pass `limit: <total>` to fetch everything.
```

Also note (no edit needed) that the `curl` example under "Verifying delivery" already uses `&limit=5` — that parameter is now honored by the daemon.

**Step 2: (No test — doc change.) Sanity-check the file renders**

Run: `git -C ~/projects/workstation diff --stat assets/opencode/skills/swarm-messaging/SKILL.md`
Expected: shows the modified skill file.

**Step 3: Commit (in the workstation repo)**

```bash
git -C ~/projects/workstation add assets/opencode/skills/swarm-messaging/SKILL.md
git -C ~/projects/workstation commit -m "docs(swarm): document swarm_read default limit + breadcrumb"
```

---

### Task 5: Full verification

**Step 1: Typecheck + full test suite (pigeon)**

Run:
```bash
cd ~/projects/pigeon && npm run --workspaces typecheck && npm test
```
Expected: typecheck clean; all tests pass (daemon + plugin). Pay attention to `swarm-routes.integration.test.ts` and `app.test.ts` — if either asserts a full `/swarm/inbox` body shape, update it for the added `total`/`returned`/`limit` fields.

**Step 2: Manual smoke (optional, if a daemon is running locally)**

```bash
curl -sf "http://127.0.0.1:4731/swarm/inbox?session=<some_ses>&limit=3" | jq '{total, returned, limit, n: (.messages|length)}'
```
Expected: `returned <= 3`, `total` = full count.

**Step 3: Final commit / status check**

```bash
cd ~/projects/pigeon && git status   # clean tree, commits from Tasks 1-3 present
```

---

## Deploy notes (post-merge, not part of TDD)

- **Daemon half** (Tasks 1-2) takes effect on `pigeon-daemon` restart → immediate context-bound for every caller, including the currently-deployed plugin that never sends `limit`.
- **Plugin half** (Task 3: `limit` arg + breadcrumb) only loads after a serve-pool reload (pool 4096–4099); until then old plugins get bounded `messages` but no breadcrumb. See `2026-06-24-swarm-send-sender-retry-design.md` "Deploy caveat".
- **Skill doc** (Task 4) deploys via `nix run home-manager -- switch` on the relevant host.

## Out of scope (follow-ups if desired)

- Wire `cleanupOlderThan` into a cleanup timer (real retention).
- Time-based (`hours`) narrowing param.
- Teach the compaction/resume protocol to persist the breadcrumb's newest `msg_id` and auto-resume with `since=`.

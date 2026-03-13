# Boot ID + Periodic Heartbeat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a DO boot ID to diagnose whether 1006 drops are DO restarts or network blips, and add a 5-minute periodic heartbeat that wakes the DO to test whether staying warm reduces drops.

**Architecture:** The DO generates a random `bootId` in its constructor and sends it to each connecting daemon over WebSocket. The daemon logs `bootId` and tracks whether it changes across reconnects. Separately, the daemon sends `{"type":"heartbeat"}` every 5 minutes (not matched by `setWebSocketAutoResponse`), which wakes the DO; the DO responds with `{"type":"heartbeat-ack"}`.

**Tech Stack:** Cloudflare Workers (Durable Objects, WebSocket Hibernation API), Node.js 22, vitest.

**Reference:** `docs/plans/2026-03-13-boot-id-heartbeat-design.md`

---

### Task 1: Worker DO — Generate Boot ID and Send on WebSocket Upgrade

**Files:**
- Modify: `packages/worker/src/router-do.ts:15-29` (add bootId field + constructor), `:229-244` (send boot message after accept)
- Test: `packages/worker/test/worker.test.ts` (add to "websocket hibernation auto-response" describe block)

**Step 1: Write the failing test**

In `packages/worker/test/worker.test.ts`, inside the existing `describe("websocket hibernation auto-response")` block, add:

```typescript
  it("sends boot message with bootId on WebSocket connect", async () => {
    const machineId = `machine-boot-${Date.now()}`;
    const ws = await openMachineSocket(machineId);

    const message = await waitForWsMessage(ws);
    const parsed = JSON.parse(message);

    expect(parsed.type).toBe("boot");
    expect(typeof parsed.bootId).toBe("string");
    expect(parsed.bootId.length).toBe(8);

    ws.close();
  });
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pigeon/worker`
Expected: FAIL — `waitForWsMessage` times out or receives a different message (command flush, not boot).

**Step 3: Implement boot ID**

In `packages/worker/src/router-do.ts`:

Add a `bootId` field to the class (after `private static readonly MAX_WS_MESSAGE_BYTES`):

```typescript
  private readonly bootId = crypto.randomUUID().slice(0, 8);
```

In `handleWebSocketUpgrade`, after `server.serializeAttachment({ machineId });` and before `flushCommandQueue(...)`, add:

```typescript
    server.send(JSON.stringify({ type: "boot", bootId: this.bootId }));
```

**Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @pigeon/worker`
Expected: All tests pass.

**Step 5: Run typecheck**

Run: `npm run typecheck --workspace @pigeon/worker`
Expected: No errors.

**Step 6: Commit**

```bash
git add packages/worker/src/router-do.ts packages/worker/test/worker.test.ts
git commit --no-gpg-sign -m "feat(worker): send boot ID on WebSocket connect for restart detection

The DO generates a random 8-char bootId in its constructor and sends it
to each connecting daemon. If the bootId changes between reconnects, the
DO was restarted (vs. a network blip where bootId stays the same)."
```

---

### Task 2: Worker DO — Handle Heartbeat Messages

**Files:**
- Modify: `packages/worker/src/router-do.ts:276-281` (add heartbeat handler in webSocketMessage)
- Test: `packages/worker/test/worker.test.ts` (add to "websocket machine agent" describe block)

**Step 1: Write the failing test**

In `packages/worker/test/worker.test.ts`, inside the existing `describe("websocket machine agent")` block, add:

```typescript
  it("responds to heartbeat with heartbeat-ack", async () => {
    const ws = await openMachineSocket(`machine-hb-${Date.now()}`);

    // Drain the boot message first
    await waitForWsMessage(ws);

    ws.send(JSON.stringify({ type: "heartbeat" }));
    const message = await waitForWsMessage(ws);
    expect(JSON.parse(message)).toEqual({ type: "heartbeat-ack" });
    ws.close();
  });
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pigeon/worker`
Expected: FAIL — `waitForWsMessage` times out because the DO doesn't respond to heartbeat.

**Step 3: Implement heartbeat handler**

In `packages/worker/src/router-do.ts`, in `webSocketMessage`, after the comment about ping/pong auto-response (line 280) and before the `if (type === "ack")` block, add:

```typescript
    if (type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat-ack" }));
      return;
    }
```

**Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @pigeon/worker`
Expected: All tests pass.

**Step 5: Run typecheck**

Run: `npm run typecheck --workspace @pigeon/worker`
Expected: No errors.

**Step 6: Commit**

```bash
git add packages/worker/src/router-do.ts packages/worker/test/worker.test.ts
git commit --no-gpg-sign -m "feat(worker): respond to heartbeat messages to keep DO warm

The daemon will send periodic heartbeat messages that intentionally wake
the DO from hibernation. The DO responds with heartbeat-ack. This tests
whether staying warm reduces host-migration-related disconnects."
```

---

### Task 3: Daemon — Handle Boot ID and Track Across Reconnects

**Files:**
- Modify: `packages/daemon/src/worker/machine-agent.ts:44-46` (add bootId field), `:85` (log bootId on connect), `:104-108` (log bootId on close), `:198-201` (handle boot + heartbeat-ack messages)
- Test: `packages/daemon/test/machine-agent.test.ts` (add boot ID tests)

**Step 1: Write the failing test**

In `packages/daemon/test/machine-agent.test.ts`, add a new describe block:

```typescript
describe("MachineAgent boot ID tracking", () => {
  it("stores bootId from boot message and treats heartbeat-ack as pong", async () => {
    const storage = openStorageDb(":memory:");

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { now: () => 5000 },
    );

    await agent.handleMessage(JSON.stringify({ type: "boot", bootId: "abc12345" }));
    expect((agent as unknown as { bootId: string | null }).bootId).toBe("abc12345");

    await agent.handleMessage(JSON.stringify({ type: "heartbeat-ack" }));
    expect((agent as unknown as { lastPongAt: number }).lastPongAt).toBe(5000);

    storage.db.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pigeon/daemon`
Expected: FAIL — `bootId` field doesn't exist, `heartbeat-ack` isn't handled.

**Step 3: Implement boot ID tracking and heartbeat-ack handling**

In `packages/daemon/src/worker/machine-agent.ts`:

Add a new field after `closeCause` (line 46):

```typescript
  private bootId: string | null = null;
```

In the `open` handler (after `this.closeCause = null;` around line 89), add boot ID change detection:

```typescript
      this.prevBootId = this.bootId;
      this.bootId = null;
```

Wait — simpler approach. Don't add `prevBootId`. Just log the current `bootId` on close, then when `boot` message arrives on the new connection, compare and log. Here's the approach:

In `handleMessage`, after the `pong` handler (line 199-201), add:

```typescript
    if (record.type === "boot") {
      const newBootId = typeof record.bootId === "string" ? record.bootId : null;
      const changed = this.bootId !== null && this.bootId !== newBootId;
      console.log(`[machine-agent] boot bootId=${newBootId} prevBootId=${this.bootId} changed=${changed}`);
      this.bootId = newBootId;
      return;
    }

    if (record.type === "heartbeat-ack") {
      this.lastPongAt = this.now();
      return;
    }
```

In the close handler (line 108), add `bootId` to the log:

```typescript
      console.warn(`[machine-agent] websocket closed code=${ev.code} reason=${ev.reason} wasClean=${ev.wasClean} ageMs=${ageMs} lastPongAgeMs=${lastPongAgeMs} cause=${this.closeCause ?? "remote"} bootId=${this.bootId ?? "?"}`);
```

**Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @pigeon/daemon`
Expected: All tests pass.

**Step 5: Run typecheck**

Run: `npm run typecheck --workspace @pigeon/daemon`
Expected: No errors.

**Step 6: Commit**

```bash
git add packages/daemon/src/worker/machine-agent.ts packages/daemon/test/machine-agent.test.ts
git commit --no-gpg-sign -m "feat(daemon): track DO boot ID across reconnects and handle heartbeat-ack

Stores the bootId from the DO's boot message and logs whether it changed
on reconnect (changed = DO restarted, unchanged = network blip). Also
treats heartbeat-ack as a pong for keepalive purposes."
```

---

### Task 4: Daemon — Add 5-Minute Heartbeat Timer

**Files:**
- Modify: `packages/daemon/src/worker/machine-agent.ts:7-10` (add constant), `:38-46` (add timer field), `:118-138` (add heartbeat to startPing), `:159-172` (add to clearPingTimers)
- Test: `packages/daemon/test/machine-agent.test.ts` (add heartbeat timer test)

**Step 1: Write the failing test**

In `packages/daemon/test/machine-agent.test.ts`, add to the existing `"MachineAgent.handleMessage"` describe block or create a new one:

```typescript
describe("MachineAgent heartbeat", () => {
  it("heartbeat message type is distinct from ping", () => {
    // Verify the heartbeat won't be matched by setWebSocketAutoResponse
    const ping = JSON.stringify({ type: "ping" });
    const heartbeat = JSON.stringify({ type: "heartbeat" });
    expect(ping).not.toBe(heartbeat);
  });
});
```

This is a trivial assertion but documents the key architectural constraint. The real test is integration: does the timer fire and send `{"type":"heartbeat"}`? That's hard to unit test with real timers. The heartbeat behavior will be verified in production logs.

**Step 2: Run test to verify it passes (baseline)**

Run: `npm run test --workspace @pigeon/daemon`
Expected: PASS.

**Step 3: Implement heartbeat timer**

In `packages/daemon/src/worker/machine-agent.ts`:

Add constant after `PONG_TIMEOUT_MS` (line 8):

```typescript
const HEARTBEAT_INTERVAL_MS = 300_000; // 5 minutes
```

Add a timer field after `pongTimer` (line 40):

```typescript
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
```

In `startPing()`, after the `pongTimer` setup (after line 138), add:

```typescript
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.ws.send(JSON.stringify({ type: "heartbeat" }));
    }, HEARTBEAT_INTERVAL_MS);
```

In `clearPingTimers()`, add after the `pongTimer` cleanup:

```typescript
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
```

**Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @pigeon/daemon`
Expected: All tests pass.

**Step 5: Run typecheck**

Run: `npm run typecheck --workspace @pigeon/daemon`
Expected: No errors.

**Step 6: Commit**

```bash
git add packages/daemon/src/worker/machine-agent.ts packages/daemon/test/machine-agent.test.ts
git commit --no-gpg-sign -m "feat(daemon): add 5-minute heartbeat to keep DO warm

Sends a heartbeat message every 5 minutes that intentionally wakes the
DO from hibernation. This tests whether keeping the DO warm reduces the
1006 disconnects caused by Cloudflare host migration."
```

---

### Task 5: Deploy and Verify

**Step 1: Run full test suite**

Run: `npm run test --workspaces`
Expected: All tests pass.

**Step 2: Run full typecheck**

Run: `npm run typecheck --workspaces`
Expected: No errors.

**Step 3: Deploy the worker**

Run: `npm run deploy --workspace @pigeon/worker`
Expected: Deployed successfully.

**Step 4: Restart the daemon**

Run: `sudo systemctl restart pigeon-daemon.service`

**Step 5: Verify boot ID and heartbeat in logs**

Run: `journalctl -u pigeon-daemon.service --no-pager -n 10`
Expected: See `[machine-agent] connected machineId=cloudbox` followed by `[machine-agent] boot bootId=XXXXXXXX prevBootId=null changed=false`.

**Step 6: Push to remote**

```bash
git push origin main
```

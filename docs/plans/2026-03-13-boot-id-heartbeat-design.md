# Boot ID Diagnostic + Periodic DO Wake-up Design

**Goal:** Determine whether 1006 drops correlate with DO restarts (boot ID), and test whether keeping the DO warm reduces drops (periodic heartbeat).

## Boot ID

- DO constructor generates `bootId = crypto.randomUUID().slice(0, 8)` (short hex, stored as instance field)
- After `ctx.acceptWebSocket`, the DO sends `{"type":"boot","bootId":"..."}` to the new WebSocket
- Daemon receives it in `handleMessage`, logs and stores `this.bootId`
- On close, daemon logs the bootId alongside existing telemetry
- On reconnect, daemon compares old vs new bootId and logs `bootChanged=true/false`

## Periodic Heartbeat

- Daemon sends `{"type":"heartbeat"}` every 5 minutes (300s), separate from the 30s pings
- `setWebSocketAutoResponse` only matches `{"type":"ping"}`, so heartbeats wake the DO
- DO's `webSocketMessage` handler responds with `{"type":"heartbeat-ack"}`
- Daemon updates `lastPongAt` on heartbeat-ack (same as pong, keeps the keepalive happy)

## What we'll learn

- **Boot ID changes on every disconnect** → drops = DO restarts. Nothing we can do except fast reconnect.
- **Boot ID stays the same across disconnects** → drops = network/proxy layer, not DO restarts. Different investigation needed.
- **Heartbeat reduces drops** → hibernation-path/placement interaction is the cause. Keep the heartbeat.
- **Heartbeat doesn't reduce drops** → infrastructure-level, remove the heartbeat to save cost.

# honkd Turn Hook v1 Contract

This document defines the wire contract between `honkd` and pigeon's `/goose/turn-event` endpoint, pigeon's processing semantics, and known gaps. The honk side is documented in the honk repo at `docs/turn-hook.md`.

## Wire Contract: `turn-hook v1`

honkd -> receiver, `POST <turn-hook-url>`, `Content-Type: application/json`, `Authorization: Bearer <token>` when a token file is configured. One event per request.

### `turn.started`

```json
{
  "v": 1,
  "type": "turn.started",
  "event_id": "<goose_sid>:<upstream_id>:started",
  "session_id": "<goose session id>",
  "upstream_id": "hk3_7-12",
  "run_id": "run_abc",
  "client_req_ids": ["crid-1"],
  "prompt_text": "user text of the prompt (capped)",
  "at_ms": 1792162675775
}
```

### `turn.ended`

```json
{
  "v": 1,
  "type": "turn.ended",
  "event_id": "<goose_sid>:<upstream_id>:ended",
  "session_id": "...",
  "upstream_id": "...",
  "run_id": "run_abc or null",
  "client_req_ids": [],
  "prompt_text": "...",
  "at_ms": 0,
  "stop_reason": "end_turn | cancelled | max_tokens | ... | null",
  "honk_reason": "upstream_restart | delivery_unknown | cancelled | synthesized | null",
  "final_text": "last assistant message text, or null",
  "final_text_truncated": false,
  "error": "JSON-RPC error message when goose answered the prompt with an error, else null",
  "usage": {
    "used": 53000,
    "size": 200000,
    "cost": {
      "amount": 0.045,
      "currency": "USD"
    }
  }
}
```

### Wire Rules

- `upstream_id` is honkd's id for the upstream `session/prompt` (`hk{boot}_{actor}-{n}`); unique per prompt across restarts. It is the turn key on both sides.
- `prompt_text` and `final_text` are capped at 256 KiB (UTF-8 bytes, cut on a char boundary); `final_text_truncated` is always present on `turn.ended` (boolean) and indicates whether `final_text` was cut by honkd. `prompt_text` is cut silently.
- honkd omits empty ended-only fields (`stop_reason`, `honk_reason`, `final_text`, `error`, `usage`) rather than sending `null`. Receivers must treat absent and `null` the same.
- `usage` is optional: latest `usage_update` goose sent before the turn ended; omitted when honkd has none. Fields: `used` (current context tokens, non-negative integer), `size` (model context limit, optional/0 when unknown), `cost` (cumulative session cost, optional; contains `amount` and `currency` e.g. "USD").
- `client_req_ids` are the deduplicated `_meta.honk.client_req_id`s of the turn's owners (pigeon's goose runner sends its `commandId` there). May be empty.
- honkd emits `turn.started` at most once per `upstream_id`, when goose announces the run (the point where honkd synthesizes the user-message echo). honkd may send `turn.started` immediately before `turn.ended` for a turn it never saw announced (e.g. quick completion or interrupt). A prompt that is never announced produces no `turn.started` otherwise.
- honkd emits `turn.ended` only for turns that ran or may have run: a reply from goose (result or error, except busy rejections), the synthesized gap reply, or an interrupt of an in-flight prompt that was announced or whose reason is `upstream_restart` / `delivery_unknown`. It emits nothing for parked prompts that never ran, busy rejections, send failures, `not_delivered`, and `cancelled` on an unannounced prompt.
- After a honkd restart, a persisted reply can be replayed, so the same `turn.ended` (same `event_id`) may arrive twice. Receivers must be idempotent on `event_id`.
- Receiver responses:
  - Any `2xx`: Accepted (including "ignored").
  - `4xx`: Permanent client error; honkd drops the event without retry.
  - `5xx` / connection error / timeout: Transient; honkd retries with exponential backoff until the retry window (default 20 min) expires.

---

## Pigeon's Handling (`POST /goose/turn-event`)

1. **Authentication**: Authenticated via the global daemon bearer token check (`checkAuth`). A wrong or missing token returns 401, which honkd treats as a permanent 4xx error, causing honkd to drop every turn event (visible only as warnings in honkd logs).
2. **Validation**: Rejects invalid JSON or non-object bodies with HTTP 400 (`{ error: ... }`). Requires `v === 1`, `type` in `turn.started` | `turn.ended`, and non-empty `session_id` and `upstream_id`.
3. **Session Resolution**: Looks up `storage.sessions.getByBackendSessionId(session_id)`. If missing or `backendKind !== "goose-acp"`, returns `200 { ok: true, ignored: "unregistered" }`. Legacy goose session rows with NULL `backend_session_id` are not matched and are treated as unregistered.
4. **Own-Turn Skip**: For each `crid` in `client_req_ids`, checks if `storage.gooseInflight.get(crid)` exists or an outbox entry `s:<sessionId>:<sanitiseIdPart(crid)>` exists. If either exists, the turn was initiated by pigeon's own goose runner, so pigeon returns `200 { ok: true, ignored: "own_turn" }` to prevent duplicate mirror/stop postings.
   - Note on stalled turns: When a runner turn is abandoned by pigeon as stalled (the runner emits a `s:<sessionId>:<crid>:stalled` notice and retires its in-flight row), the in-flight row is gone and no un-suffixed stop entry exists. When honkd later reports `turn.ended` for that turn, the hook does NOT skip it and posts the real reply under `s:<sessionId>:h-<id>`. This is intended: the eventual reply reaches the topic rather than being lost.
5. **Key Derivation**: Computes `id = sanitiseIdPart(upstream_id)` (where `sanitiseIdPart` restricts characters to `[A-Za-z0-9_.-]`, capped at 64 characters).
6. **`turn.started` Processing**: Checks for a swarm envelope close tag `</swarm_message>` on the uncapped text; if present, mirroring is skipped (`{ mirrored: false }`). Prompts are capped at 4096 UTF-16 code units for Telegram mirroring (appending `\n\n[... prompt truncated]` if cut). Invokes `handleMirrorBody({ sessionId: row.sessionId, messageId: \`h-${id}\`, text: prompt_text ?? "" }, { setAnchor: false })`. Passing `{ setAnchor: false }` leaves `lastHumanMsgId` untouched so human navigation anchors are not frozen by upstream turn IDs. Enqueues an outbox entry with `kind='mirror'` and `notificationId` `m:<sessionId>:h-<id>`.
7. **`turn.ended` Processing**: Renders notification message and status via `renderHookTurn(body)`. If `usage` is present and yields a footer (`used > 0`), pigeon appends `\n\n📊 <tokens> tokens · <pct>% · <cost>` to the final notification message for every outcome (Stop, Error, cancelled, synthesized). Invokes `handleStopBody({ session_id: row.sessionId, notification_id: \`s:${row.sessionId}:h-${id}\`, event: r.event, message: r.message, ...(r.errorKind ? { error_kind: r.errorKind } : {}), after_notification_id: \`m:${row.sessionId}:h-${id}\` })` without passing `title` or `label`. Setting `after_notification_id` guarantees that outbox delivery holds the stop reply until the prompt mirror row is sent, eliminating reply-before-prompt races within the turn.
8. **Idempotency**: Because outbox records are primary-keyed on `notificationId` (`m:<sessionId>:h-<id>` for mirror and `s:<sessionId>:h-<id>` for stop), duplicate delivery of `turn.started` or `turn.ended` events is idempotent and produces no duplicate Telegram messages.
9. **Deploy Order**: Deploy pigeon with this route enabled before starting honkd with `--turn-hook-url`. If honkd sends events before pigeon has this route deployed, pigeon returns 404, which honkd treats as a permanent 4xx error and drops without retrying.

---

## Known Gaps (Accepted)

- **Steer messages**: Steer messages typed into a running turn are not mirrored.
- **Bypassed runs**: Runs a client starts by talking to goose directly (bypassing honkd) are not seen by the turn hook.
- **Crash/downtime event loss**: An event can be lost if honkd crashes between a turn ending and the POST, or if pigeon is unreachable for longer than honkd's retry window (20 minutes).

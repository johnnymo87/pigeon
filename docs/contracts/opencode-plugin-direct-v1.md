# OpenCode Plugin-Direct Command Channel v1

Status: accepted for Phase 3 direct migration (no feature flag path).

This contract defines daemon <-> OpenCode plugin command transport for OpenCode sessions.

## Session Registration Contract

`POST /session-start` from plugin includes these additional fields:

- `backend_kind`: `"opencode-plugin-direct"`
- `backend_protocol_version`: `1`
- `backend_endpoint`: plugin-local command endpoint (`http://127.0.0.1:<port>/...` or unix socket proxy URL)
- `backend_auth_token`: bearer-like token for daemon -> plugin calls

For OpenCode sessions, daemon routes inbound Telegram commands to this backend.

## Execute Message (daemon -> plugin)

```json
{
  "type": "pigeon.command.execute",
  "version": 1,
  "requestId": "req-uuid",
  "commandId": "cmd-uuid",
  "sessionId": "session-id",
  "command": "echo hello",
  "source": "telegram-reply",
  "issuedAt": 1739383871000,
  "deadlineMs": 30000,
  "metadata": {
    "chatId": "8248645256",
    "replyToMessageId": "2912",
    "replyToken": "token"
  }
}
```

## Ack Message (plugin -> daemon)

```json
{
  "type": "pigeon.command.ack",
  "version": 1,
  "requestId": "req-uuid",
  "commandId": "cmd-uuid",
  "sessionId": "session-id",
  "accepted": true,
  "acceptedAt": 1739383871005
}
```

If rejected:

- `accepted: false`
- `rejectReason` in:
  - `INVALID_SESSION`
  - `UNAUTHORIZED`
  - `BUSY`
  - `UNAVAILABLE`
  - `UNSUPPORTED_VERSION`
  - `INVALID_PAYLOAD`

## Result Message (plugin -> daemon)

```json
{
  "type": "pigeon.command.result",
  "version": 1,
  "requestId": "req-uuid",
  "commandId": "cmd-uuid",
  "sessionId": "session-id",
  "success": false,
  "finishedAt": 1739383873010,
  "exitCode": 1,
  "errorCode": "EXECUTION_ERROR",
  "errorMessage": "spawn failed"
}
```

`errorCode` enum:

- `TIMEOUT`
- `EXECUTION_ERROR`
- `CANCELLED`
- `INVALID_SESSION`
- `UNAUTHORIZED`
- `INTERNAL`

## Versioning Rules

- `version` is required in every envelope.
- v1 peers reject unknown versions with `ack.accepted=false` and `rejectReason=UNSUPPORTED_VERSION`.
- Minor additive fields are allowed if receivers ignore unknown keys.

## Migration Policy

- No feature flag rollout for this channel.
- OpenCode sessions must use plugin-direct backend once implemented.

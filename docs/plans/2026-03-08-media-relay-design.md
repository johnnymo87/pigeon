# Media Relay: Bidirectional File Support via R2

## Problem

Pigeon handles only text messages. Users cannot send images, PDFs, or other files to Claude sessions via Telegram, and Claude cannot send images or file attachments back to Telegram. This limits the usefulness of remote sessions for visual debugging, document review, and any workflow that involves non-text content.

## Approach

R2 Media Relay: a Cloudflare R2 bucket acts as the universal media intermediary for both directions. The worker streams files between Telegram and R2 without buffering into memory. The daemon fetches from or uploads to R2 via authenticated worker endpoints. The plugin converts files to opencode `FilePartInput` for inbound and captures `FilePart` for outbound.

### Alternatives considered

**Inline base64**: Embed file data in JSON payloads. Simple but causes payload bloat (1.33x), WebSocket pressure, and D1 command_queue row size issues. Doesn't scale.

**Telegram file_id passthrough**: Pass file references without downloading. Requires daemon to have outbound HTTPS to api.telegram.org (new dependency). URLs expire after ~1 hour. Doesn't help outbound (daemon-produced files aren't on Telegram yet).

## Design

### R2 Infrastructure

Single R2 bucket `pigeon-media` bound to the worker as `MEDIA`.

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "pigeon-media"
```

No public bucket access needed. The worker proxies all access via two authenticated endpoints:

- `POST /media/upload` -- daemon uploads outbound files to R2
- `GET /media/:key+` -- daemon downloads inbound files from R2

Both use the existing `CCR_API_KEY` bearer auth.

Object key format: `<direction>/<timestamp>-<id>/<filename>` where direction is `inbound` or `outbound`, timestamp enables TTL cleanup, and id is `file_unique_id` (inbound) or UUID (outbound).

Objects expire after 24 hours via an hourly cron trigger that lists and deletes old keys.

### Inbound Flow (Telegram -> Claude)

1. Worker receives webhook with `photo`, `document`, `audio`, `video`, or `voice` field
2. Extracts `file_id` (for photos, uses largest size: `photo.at(-1)`)
3. Calls Telegram `getFile(file_id)` to get `file_path`
4. Streams from `https://api.telegram.org/file/bot<token>/<file_path>` directly to R2 (no buffering)
5. Preserves mime type and filename from the Telegram object (getFile may not preserve them)
6. Routes the message using existing logic (reply-to or /cmd TOKEN)
7. Sends WebSocket command to daemon with extended payload including `media` field
8. Daemon fetches file from `GET /media/<key>`, converts to data URI or temp file
9. Plugin builds `prompt_async` parts array with `FilePartInput` + optional `TextPartInput` (caption)

Files > 20MB are rejected at the worker with a Telegram error reply (matches Telegram's getFile limit).

### Outbound Flow (Claude -> Telegram)

1. Plugin's `MessageTail` captures `FilePart` from message parts and `ToolStateCompleted.attachments`
2. On `session.idle` or `question.asked`, captured files are included in the daemon notification
3. Daemon uploads each file to R2 via `POST /media/upload`
4. Daemon includes R2 keys in the notification POST to the worker
5. Worker fetches from R2, determines Telegram API method:
   - `image/*` -> `sendPhoto`
   - Everything else -> `sendDocument`
6. Text notification is always sent first via `sendMessage`
7. Media follows as replies to the text message (keeps them grouped, enables reply routing)

Text notifications are never blocked by media failures. Media is best-effort.

### Worker Media Endpoints

**`POST /media/upload`**

```
Authorization: Bearer <CCR_API_KEY>
Content-Type: multipart/form-data

Fields:
  file: <binary data>
  key: string
  mime: string
  filename: string
```

Streams file body directly to `env.MEDIA.put()`. Returns `{ ok: true, key }`.

**`GET /media/:key+`**

```
Authorization: Bearer <CCR_API_KEY>
```

Returns R2 object body with stored Content-Type and Content-Disposition headers. 404 if missing.

**Size limit**: 20MB max on upload.

**Cleanup**: Hourly cron trigger deletes objects older than 24h based on timestamp in key.

### Contract Changes

All changes are additive. The `media` field is optional everywhere. Existing text-only flows are unchanged.

**Shared type**:
```typescript
interface MediaRef {
  key: string;      // R2 object key
  mime: string;     // MIME type
  filename: string; // original filename
  size: number;     // bytes
}
```

**Worker TelegramMessage**: gains `caption?`, `photo?`, `document?`, `audio?`, `video?`, `voice?` fields.

**Worker -> Daemon WebSocket command**: gains `media?: MediaRef`.

**Daemon WorkerCommandMessage**: gains `media?: MediaRef`.

**Daemon -> Plugin ExecuteCommandEnvelope**: gains `media?: { mime, filename, url }`.

**Plugin -> Daemon NotificationInput**: gains `media?: Array<{ mime, filename, url }>`.

**Daemon -> Worker notification body**: gains `media?: Array<{ key, mime, filename }>`.

**Worker Env**: gains `MEDIA: R2Bucket`.

### Error Handling

**Inbound errors**:

| Scenario | Handling |
|----------|----------|
| File > 20MB | Worker replies to Telegram: "File too large (max 20MB)" |
| getFile fails | Worker replies: "Could not download file from Telegram" |
| R2 upload fails | Worker replies: "Media storage failed, please try again" |
| Daemon can't fetch from R2 | commandResult with success: false -> Telegram error |
| No session for media message | Same as text: "Could not find session" |
| Caption empty, file present | Send file part alone (valid for Claude) |

**Outbound errors**:

| Scenario | Handling |
|----------|----------|
| FilePart URL inaccessible | Skip file, send text notification. Log warning. |
| R2 upload fails | Send text notification without media. |
| Telegram sendPhoto/sendDocument fails | Text already sent. Log failure. |
| Unknown mime type | Fall back to sendDocument |
| Multiple files, one fails | Continue with remaining files |

**R2 cleanup edge cases**:

| Scenario | Handling |
|----------|----------|
| Daemon offline when file arrives | File waits in R2, command queued in D1. 24h TTL. |
| Cron deletes before daemon fetches | Command fails with 404. Unlikely given 24h TTL. |
| Duplicate file (same file_unique_id) | Same R2 key, overwrite is harmless. |

### Testing Strategy

**Worker tests**:
- Webhook media parsing (photo, document, audio, video, voice, caption)
- File relay to R2 (streaming upload, size rejection, key format)
- Media command dispatch (WebSocket payload shape)
- POST /media/upload (auth, multipart, R2 put, errors)
- GET /media/:key+ (auth, R2 get, 404, Content-Type)
- POST /notifications/send with media (sendPhoto vs sendDocument, multi-file, reply grouping)
- Cleanup cron (24h TTL enforcement)

**Daemon tests**:
- Command ingest with media (R2 fetch, data URI conversion, envelope construction)
- Notification with media (upload to /media/upload, R2 keys in notification POST)
- Error resilience (R2 failures don't block acks or text notifications)

**Plugin tests**:
- MessageTail file capture (FilePart, ToolPart attachments, mime filtering)
- Execute with media (FilePartInput in prompt_async parts)
- Notification with files (media array in daemon notification)

**Manual smoke tests**:
1. Send photo as reply to session notification -> Claude receives image
2. Send PDF document -> Claude reads it
3. Trigger tool that produces image -> image appears in Telegram
4. Send photo with no reply-to -> "could not find session" error
5. Send file > 20MB -> size limit error

# Media Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable bidirectional file transfer (images, PDFs, any file type) between Telegram and Claude sessions via an R2 media relay.

**Architecture:** Cloudflare R2 bucket as universal media intermediary. Worker streams files between Telegram and R2. Daemon fetches/uploads via authenticated worker endpoints. Plugin converts to/from opencode `FilePartInput`/`FilePart`. All changes are additive — `media` fields are optional throughout.

**Tech Stack:** Cloudflare R2 (object storage), Telegram Bot API (getFile, sendPhoto, sendDocument), opencode SDK (FilePartInput/FilePart), Bun (runtime).

**Reference:** `docs/plans/2026-03-08-media-relay-design.md`

---

### Task 1: R2 Bucket Binding and Env Type

**Files:**
- Modify: `packages/worker/wrangler.toml` (add R2 binding + cron trigger)
- Modify: `packages/worker/src/types.ts:4-12` (add MEDIA to Env)

**Step 1: Add R2 binding and cron trigger to wrangler.toml**

Add after line 12 (after `[[migrations]]` block):

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "pigeon-media"

[triggers]
crons = ["0 * * * *"]
```

**Step 2: Add MEDIA to Env interface**

In `packages/worker/src/types.ts`, add `MEDIA: R2Bucket;` inside the `Env` interface (after line 11):

```typescript
declare global {
  interface Env {
    ROUTER: DurableObjectNamespace;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    CCR_API_KEY: string;
    ALLOWED_CHAT_IDS: string;
    ALLOWED_USER_IDS?: string;
    MEDIA: R2Bucket;
  }
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (R2Bucket is a global Cloudflare Workers type)

**Step 4: Commit**

```bash
git add packages/worker/wrangler.toml packages/worker/src/types.ts
git commit -m "feat(worker): add R2 media bucket binding and cleanup cron"
```

---

### Task 2: Shared MediaRef Type and Worker Media Endpoints

**Files:**
- Create: `packages/worker/src/media.ts`
- Modify: `packages/worker/src/router-do.ts:145-187` (add routes)
- Test: `packages/worker/test/worker.test.ts` (add media endpoint tests)

**Step 1: Write failing tests for media endpoints**

Add tests to `packages/worker/test/worker.test.ts` for:

```typescript
// POST /media/upload — stores file in R2
// - Returns 401 without API key
// - Returns 400 if missing required fields (key, mime, filename)
// - Returns 200 with { ok: true, key } on success
// - Stores object in R2 with correct contentType metadata

// GET /media/{key} — retrieves file from R2
// - Returns 401 without API key
// - Returns 404 for nonexistent key
// - Returns 200 with correct Content-Type and Content-Disposition headers
// - Returns the stored binary data
```

Test shape — adjust to match the existing test patterns in `worker.test.ts`:

```typescript
describe("POST /media/upload", () => {
  it("rejects without API key", async () => {
    const form = new FormData();
    form.append("key", "inbound/test/photo.jpg");
    form.append("mime", "image/jpeg");
    form.append("filename", "photo.jpg");
    form.append("file", new Blob(["fake-image"], { type: "image/jpeg" }));

    const res = await routerDO.fetch(
      new Request("https://fake/media/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(401);
  });

  it("stores file and returns key", async () => {
    const form = new FormData();
    form.append("key", "inbound/test/photo.jpg");
    form.append("mime", "image/jpeg");
    form.append("filename", "photo.jpg");
    form.append("file", new Blob(["fake-image"], { type: "image/jpeg" }));

    const res = await routerDO.fetch(
      new Request("https://fake/media/upload", {
        method: "POST",
        body: form,
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, key: "inbound/test/photo.jpg" });
  });
});

describe("GET /media/{key}", () => {
  it("returns 404 for missing key", async () => {
    const res = await routerDO.fetch(
      new Request("https://fake/media/nonexistent/file.jpg", {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns stored file with correct headers", async () => {
    // First upload a file
    const form = new FormData();
    form.append("key", "inbound/test/photo.jpg");
    form.append("mime", "image/jpeg");
    form.append("filename", "photo.jpg");
    form.append("file", new Blob(["fake-image"], { type: "image/jpeg" }));

    await routerDO.fetch(
      new Request("https://fake/media/upload", {
        method: "POST",
        body: form,
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      }),
    );

    // Then fetch it
    const res = await routerDO.fetch(
      new Request("https://fake/media/inbound/test/photo.jpg", {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toContain("photo.jpg");
    const text = await res.text();
    expect(text).toBe("fake-image");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — routes don't exist yet

**Step 3: Create media.ts with MediaRef type and handlers**

Create `packages/worker/src/media.ts`:

```typescript
import { verifyApiKey, unauthorized, json } from "./notifications";

export interface MediaRef {
  key: string;
  mime: string;
  filename: string;
  size: number;
}

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB

export async function handleMediaUpload(
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const formData = await request.formData();
  const key = formData.get("key") as string | null;
  const mime = formData.get("mime") as string | null;
  const filename = formData.get("filename") as string | null;
  const file = formData.get("file") as File | null;

  if (!key || !mime || !filename || !file) {
    return json({ error: "key, mime, filename, and file are required" }, 400);
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    return json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }, 413);
  }

  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: mime },
    customMetadata: { filename },
  });

  return json({ ok: true, key }, 200);
}

export async function handleMediaGet(
  env: Env,
  request: Request,
  key: string,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const object = await env.MEDIA.get(key);
  if (!object) {
    return json({ error: "Not found" }, 404);
  }

  const filename = object.customMetadata?.filename ?? "file";
  const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
```

Note: The `verifyApiKey`, `unauthorized`, and `json` helpers are currently in `notifications.ts`. They may need to be extracted to a shared `utils.ts` if they aren't already exported. Check the actual exports before implementing — if they're not exported, extract them to a shared module or duplicate the helpers.

**Step 4: Add routes in router-do.ts**

In `packages/worker/src/router-do.ts`, add these routes in the `fetch` handler (around line 166, before the notifications route):

```typescript
    // Media endpoints
    if (url.pathname === "/media/upload" && method === "POST") {
      return handleMediaUpload(this.env, request);
    }
    if (url.pathname.startsWith("/media/") && method === "GET") {
      const key = url.pathname.slice("/media/".length);
      return handleMediaGet(this.env, request, key);
    }
```

Add the import at the top of `router-do.ts`:

```typescript
import { handleMediaUpload, handleMediaGet } from "./media";
```

**Step 5: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/worker/src/media.ts packages/worker/src/router-do.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add R2 media upload and download endpoints"
```

---

### Task 3: Telegram Media Type Parsing in Webhook

**Files:**
- Modify: `packages/worker/src/webhook.ts:63-82` (extend TelegramMessage and TelegramUpdate types)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Add tests for webhook handling of photo and document messages:

```typescript
describe("Telegram media webhook", () => {
  it("extracts photo file_id from largest photo size", async () => {
    // Send a webhook update with message.photo array
    // Verify the largest photo (last element) file_id is used
  });

  it("extracts document file_id and metadata", async () => {
    // Send a webhook update with message.document
    // Verify file_id, mime_type, file_name are extracted
  });

  it("uses caption as command text for media messages", async () => {
    // Send a photo with caption text
    // Verify caption is used as the command string
  });

  it("rejects files over 20MB", async () => {
    // Send a document with file_size > 20MB
    // Verify error reply to Telegram
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Extend Telegram types in webhook.ts**

Add these interfaces after the existing `TelegramMessage` interface (after line 69):

```typescript
interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}
```

Extend `TelegramMessage`:

```typescript
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  reply_to_message?: { message_id: number };
}
```

**Step 4: Add media extraction helper**

Add a helper function in `webhook.ts`:

```typescript
interface ExtractedMedia {
  fileId: string;
  fileUniqueId: string;
  mime: string;
  filename: string;
  size: number;
}

const MAX_FILE_SIZE = 20 * 1024 * 1024;

function extractMedia(message: TelegramMessage): ExtractedMedia | null {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      mime: "image/jpeg", // Telegram always converts photos to JPEG
      filename: `photo_${largest.file_unique_id}.jpg`,
      size: largest.file_size ?? 0,
    };
  }

  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      mime: message.document.mime_type ?? "application/octet-stream",
      filename: message.document.file_name ?? `file_${message.document.file_unique_id}`,
      size: message.document.file_size ?? 0,
    };
  }

  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      mime: message.audio.mime_type ?? "audio/mpeg",
      filename: message.audio.file_name ?? `audio_${message.audio.file_unique_id}`,
      size: message.audio.file_size ?? 0,
    };
  }

  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mime: message.video.mime_type ?? "video/mp4",
      filename: message.video.file_name ?? `video_${message.video.file_unique_id}`,
      size: message.video.file_size ?? 0,
    };
  }

  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      mime: message.voice.mime_type ?? "audio/ogg",
      filename: `voice_${message.voice.file_unique_id}.ogg`,
      size: message.voice.file_size ?? 0,
    };
  }

  return null;
}
```

**Step 5: Run tests**

Run: `bun run test`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/worker/src/webhook.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): parse Telegram media types in webhook handler"
```

---

### Task 4: Inbound Media Relay (Telegram -> R2 -> Command)

**Files:**
- Modify: `packages/worker/src/webhook.ts:350-368` (media relay in handleTelegramWebhook)
- Modify: `packages/worker/src/command-queue.ts:46-66` (extend command payload)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Test the full inbound flow: webhook with photo -> getFile -> R2 upload -> command with media field:

```typescript
describe("inbound media relay", () => {
  it("streams photo from Telegram to R2 and includes media in command", async () => {
    // Mock getFile response, mock Telegram file download
    // Send webhook with photo + caption as reply to a session notification
    // Verify: R2.put was called with streaming body
    // Verify: WebSocket command includes media field with correct MediaRef
    // Verify: command text is the caption
  });

  it("sends error for files exceeding 20MB", async () => {
    // Send webhook with document.file_size > 20MB
    // Verify: sendTelegramMessage called with size error
    // Verify: no R2 upload, no command sent
  });

  it("handles getFile API failure gracefully", async () => {
    // Mock getFile to return error
    // Verify: sendTelegramMessage called with download error
  });

  it("sends text-only command when message has no media", async () => {
    // Send webhook with text only (no photo/document)
    // Verify: command has no media field (backward compatible)
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Add Telegram getFile and R2 upload logic to webhook.ts**

Add a helper to download from Telegram and upload to R2:

```typescript
async function relayMediaToR2(
  env: Env,
  media: ExtractedMedia,
): Promise<{ key: string } | { error: string }> {
  // Size check
  if (media.size > MAX_FILE_SIZE) {
    return { error: `File too large (${(media.size / 1024 / 1024).toFixed(1)}MB, max 20MB)` };
  }

  // Call getFile
  const getFileRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: media.fileId }),
    },
  );

  const getFileResult = (await getFileRes.json()) as {
    ok: boolean;
    result?: { file_path: string };
  };

  if (!getFileResult.ok || !getFileResult.result?.file_path) {
    return { error: "Could not download file from Telegram" };
  }

  // Stream from Telegram to R2
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${getFileResult.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok || !fileRes.body) {
    return { error: "Could not download file from Telegram" };
  }

  const timestamp = Date.now();
  const key = `inbound/${timestamp}-${media.fileUniqueId}/${media.filename}`;

  await env.MEDIA.put(key, fileRes.body, {
    httpMetadata: { contentType: media.mime },
    customMetadata: { filename: media.filename },
  });

  return { key };
}
```

**Step 4: Modify the message handling section in handleTelegramWebhook**

Replace the block at lines 350-368 to handle media alongside text:

```typescript
  // Handle message (text, reply, media)
  if (update.message) {
    const media = extractMedia(update.message);
    const text = update.message.text ?? update.message.caption ?? "";

    // Check for media size limit before doing any work
    if (media && media.size > MAX_FILE_SIZE) {
      if (chatId) {
        await sendTelegramMessage(env, chatId,
          `File too large (${(media.size / 1024 / 1024).toFixed(1)}MB, max 20MB)`);
      }
      return OK();
    }

    // Route the message to a session
    const resolved = resolveMessageSession(sql, update.message);
    if (!resolved) {
      if (chatId) {
        await sendTelegramMessage(env, chatId,
          "Could not find session for this message. Please reply to a recent notification or use /cmd TOKEN command format.");
      }
      return OK();
    }

    // Override command text: use resolved.command for text, but fall back to caption for media
    const command = resolved.command || text;

    // Relay media to R2 if present
    let mediaRef: MediaRef | undefined;
    if (media) {
      const result = await relayMediaToR2(env, media);
      if ("error" in result) {
        if (chatId) {
          await sendTelegramMessage(env, chatId, result.error);
        }
        return OK();
      }
      mediaRef = {
        key: result.key,
        mime: media.mime,
        filename: media.filename,
        size: media.size,
      };
    }

    const machine = await resolveSessionMachine(sql, env, resolved.sessionId, command, chatId!);
    if (!machine) return OK();

    const commandId = await queueCommand(
      sql, env, machine.machineId, resolved.sessionId,
      command, String(chatId!), machine.label, mediaRef,
    );
    if (!commandId) return OK();

    deliverNow?.(machine.machineId);
    return OK();
  }
```

Note: `resolveMessageSession` currently only looks at `message.text` for `/cmd TOKEN` parsing. It needs to also check `message.caption` for media messages that include a `/cmd TOKEN` prefix. Check the implementation and extend if needed.

**Step 5: Extend queueCommand and sendCommand to accept optional media**

In `packages/worker/src/command-queue.ts`, modify `sendCommand` to accept and include `media`:

Add parameter `media?: MediaRef` to `sendCommand` and include it in the JSON:

```typescript
: JSON.stringify({ type: "command", commandId, sessionId, command, chatId, ...(media ? { media } : {}) });
```

Also extend `queueCommand` (in `webhook.ts` or wherever it's defined) to store and pass media through.

Note: `queueCommand` stores commands in SQLite (`command_queue` table). The media field should NOT be stored in SQLite (it's just a key reference to R2). Instead, add a `media_key`, `media_mime`, `media_filename`, and `media_size` columns to the command_queue table, or store the serialized MediaRef as a JSON string in a single `media_json` column. The simpler approach is a single `media_json TEXT` column.

**Step 6: Run tests**

Run: `bun run test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/worker/src/webhook.ts packages/worker/src/command-queue.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): relay inbound Telegram media to R2 and include in commands"
```

---

### Task 5: Daemon Command Ingest with Media

**Files:**
- Modify: `packages/daemon/src/worker/command-ingest.ts:14-21` (extend WorkerCommandMessage)
- Modify: `packages/daemon/src/opencode-direct/contracts.ts:44-59` (extend ExecuteCommandEnvelope)
- Modify: `packages/daemon/src/opencode-direct/adapter.ts:16-30,51-68` (extend input and envelope builder)
- Test: `packages/daemon/test/command-ingest.test.ts`
- Test: `packages/daemon/test/opencode-direct-adapter.test.ts`

**Step 1: Write failing tests**

In `command-ingest.test.ts`:

```typescript
describe("command with media", () => {
  it("fetches media from worker R2 and passes URL to adapter", async () => {
    // Send a WorkerCommandMessage with media: { key, mime, filename, size }
    // Mock the fetch to /media/{key} to return file bytes
    // Verify the adapter receives media URL (data URI or file path)
  });

  it("sends command result failure when R2 fetch fails", async () => {
    // Send WorkerCommandMessage with media
    // Mock fetch to /media/{key} to return 404
    // Verify commandResult with success: false is sent
  });

  it("works normally for text-only commands (backward compatible)", async () => {
    // Send WorkerCommandMessage without media field
    // Verify existing behavior unchanged
  });
});
```

In `opencode-direct-adapter.test.ts`:

```typescript
describe("execute with media", () => {
  it("includes media field in ExecuteCommandEnvelope", async () => {
    // Call executeViaOpencodeDirectChannel with media in input
    // Verify the POSTed envelope contains media field
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Extend WorkerCommandMessage**

In `packages/daemon/src/worker/command-ingest.ts`, add the media field:

```typescript
export interface WorkerCommandMessage {
  type: "command";
  commandId?: string;
  id?: string;
  sessionId: string;
  command: string;
  chatId?: string;
  media?: {
    key: string;
    mime: string;
    filename: string;
    size: number;
  };
}
```

**Step 4: Extend ExecuteCommandEnvelope in contracts.ts**

In `packages/daemon/src/opencode-direct/contracts.ts`, add to `ExecuteCommandEnvelope` (after line 58):

```typescript
export interface ExecuteCommandEnvelope {
  type: typeof OpencodeDirectMessageType.Execute;
  version: typeof OPENCODE_DIRECT_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  sessionId: string;
  command: string;
  source: OpencodeDirectSource;
  issuedAt: number;
  deadlineMs?: number;
  metadata?: {
    chatId?: string;
    replyToMessageId?: string;
    replyToken?: string;
  };
  media?: {
    mime: string;
    filename: string;
    url: string;
  };
}
```

Update `isExecuteCommandEnvelope` to allow (but not require) the media field — no changes needed since it doesn't reject unknown fields.

**Step 5: Extend OpencodeDirectExecuteInput in adapter.ts**

In `packages/daemon/src/opencode-direct/adapter.ts`, add media to the input:

```typescript
export interface OpencodeDirectExecuteInput {
  // ... existing fields ...
  media?: {
    mime: string;
    filename: string;
    url: string;
  };
}
```

Update `buildExecuteEnvelope` to include media:

```typescript
function buildExecuteEnvelope(input: OpencodeDirectExecuteInput, now: () => number): ExecuteCommandEnvelope {
  return {
    // ... existing fields ...
    ...(input.media ? { media: input.media } : {}),
  };
}
```

**Step 6: Add media fetch logic in command-ingest.ts**

In the `ingestWorkerCommand` function, after looking up the session and before calling the adapter, add media fetching:

```typescript
// Fetch media from R2 if present
let mediaPayload: { mime: string; filename: string; url: string } | undefined;
if (msg.media) {
  try {
    const workerUrl = /* get from config or options */;
    const apiKey = /* get from config or options */;
    const mediaRes = await fetch(`${workerUrl}/media/${msg.media.key}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!mediaRes.ok) {
      throw new Error(`R2 fetch failed: ${mediaRes.status}`);
    }
    const bytes = await mediaRes.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    mediaPayload = {
      mime: msg.media.mime,
      filename: msg.media.filename,
      url: `data:${msg.media.mime};base64,${base64}`,
    };
  } catch (err) {
    callbacks.send({
      type: "commandResult",
      commandId,
      success: false,
      error: `Failed to fetch media: ${err instanceof Error ? err.message : String(err)}`,
      chatId: msg.chatId,
    });
    return;
  }
}
```

Then pass `mediaPayload` through the adapter call to `executeViaOpencodeDirectChannel` via the input object.

Note: The `workerUrl` and `apiKey` need to be accessible in `ingestWorkerCommand`. Check how these are currently available — they may need to be added to `WorkerCommandIngestOptions` or `WorkerCommandIngestCallbacks`. The `MachineAgent` that calls `ingestWorkerCommand` has `this.config.workerUrl` and `this.config.apiKey` — these could be passed via options.

**Step 7: Run tests**

Run: `bun run test`
Expected: PASS

**Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 9: Commit**

```bash
git add packages/daemon/src/worker/command-ingest.ts packages/daemon/src/opencode-direct/contracts.ts packages/daemon/src/opencode-direct/adapter.ts packages/daemon/test/command-ingest.test.ts packages/daemon/test/opencode-direct-adapter.test.ts
git commit -m "feat(daemon): fetch inbound media from R2 and include in execute envelope"
```

---

### Task 6: Plugin Execute with Media (FilePartInput)

**Files:**
- Modify: `packages/opencode-plugin/src/direct-channel.ts` (pass media through)
- Modify: `packages/opencode-plugin/src/index.ts:50-92` (build FilePartInput in prompt_async)
- Test: `packages/opencode-plugin/test/direct-channel.test.ts`

**Step 1: Write failing tests**

In `direct-channel.test.ts`:

```typescript
describe("execute with media", () => {
  it("passes media field from envelope to onExecute callback", async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true, output: "queued" });
    // Send ExecuteCommandEnvelope with media field
    // Verify onExecute receives envelope with media
  });
});
```

Add a test for the plugin's `onExecute` building the correct parts array:

```typescript
describe("onExecute prompt_async parts", () => {
  it("includes FilePartInput when media is present", async () => {
    // Mock internalFetch to capture the prompt_async request body
    // Trigger onExecute with envelope containing media
    // Verify parts array contains both TextPartInput and FilePartInput
  });

  it("sends only TextPartInput when no media", async () => {
    // Trigger onExecute without media
    // Verify parts array contains only TextPartInput (existing behavior)
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Modify onExecute in index.ts to handle media**

In `packages/opencode-plugin/src/index.ts`, modify the `onExecute` callback (around line 50-92):

```typescript
async onExecute(request: ExecuteCommandEnvelope) {
  try {
    const promptUrl = new URL(
      `/session/${encodeURIComponent(request.sessionId)}/prompt_async`,
      ctx.serverUrl,
    )
    const headers: Record<string, string> = { "Content-Type": "application/json" }

    // Build parts array
    const parts: Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }> = []
    if (request.command) {
      parts.push({ type: "text", text: request.command })
    }
    if (request.media) {
      parts.push({
        type: "file",
        mime: request.media.mime,
        filename: request.media.filename,
        url: request.media.url,
      })
    }
    // If no text and no media, use empty text
    if (parts.length === 0) {
      parts.push({ type: "text", text: "" })
    }

    const res = await internalFetch(
      new Request(promptUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ parts, noReply: false }),
        signal: AbortSignal.timeout(10_000),
      }),
    )
    // ... existing error handling ...
  }
}
```

**Step 4: Run tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/index.ts packages/opencode-plugin/src/direct-channel.ts packages/opencode-plugin/test/direct-channel.test.ts
git commit -m "feat(plugin): include FilePartInput in prompt_async for media commands"
```

---

### Task 7: Plugin Outbound — Capture FileParts in MessageTail

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (capture file parts)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Write failing tests**

In `message-tail.test.ts`:

```typescript
describe("file capture", () => {
  it("captures FilePart with image mime type", () => {
    const tail = new MessageTail();
    tail.onMessageUpdated({ id: "msg1", sessionID: "s1", role: "assistant" });
    tail.onPartUpdated({
      id: "part1", sessionID: "s1", messageID: "msg1",
      type: "file", mime: "image/png", filename: "screenshot.png", url: "data:image/png;base64,abc",
    });
    const files = tail.getFiles("s1");
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      mime: "image/png",
      filename: "screenshot.png",
      url: "data:image/png;base64,abc",
    });
  });

  it("captures files from tool attachments", () => {
    const tail = new MessageTail();
    tail.onMessageUpdated({ id: "msg1", sessionID: "s1", role: "assistant" });
    tail.onToolAttachments("s1", "msg1", [
      { mime: "image/jpeg", filename: "result.jpg", url: "data:image/jpeg;base64,xyz" },
    ]);
    const files = tail.getFiles("s1");
    expect(files).toHaveLength(1);
  });

  it("does not capture files from non-assistant messages", () => {
    const tail = new MessageTail();
    tail.onMessageUpdated({ id: "msg1", sessionID: "s1", role: "user" });
    tail.onPartUpdated({
      id: "part1", sessionID: "s1", messageID: "msg1",
      type: "file", mime: "image/png", filename: "test.png", url: "data:...",
    });
    expect(tail.getFiles("s1")).toHaveLength(0);
  });

  it("clears files on clear()", () => {
    const tail = new MessageTail();
    tail.onMessageUpdated({ id: "msg1", sessionID: "s1", role: "assistant" });
    tail.onPartUpdated({
      id: "part1", sessionID: "s1", messageID: "msg1",
      type: "file", mime: "image/png", filename: "test.png", url: "data:...",
    });
    tail.clear("s1");
    expect(tail.getFiles("s1")).toHaveLength(0);
  });

  it("resets files on new assistant message", () => {
    const tail = new MessageTail();
    tail.onMessageUpdated({ id: "msg1", sessionID: "s1", role: "assistant" });
    tail.onPartUpdated({
      id: "part1", sessionID: "s1", messageID: "msg1",
      type: "file", mime: "image/png", filename: "old.png", url: "data:...",
    });
    tail.onMessageUpdated({ id: "msg2", sessionID: "s1", role: "assistant" });
    expect(tail.getFiles("s1")).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `getFiles` and `onToolAttachments` don't exist

**Step 3: Extend MessageTail to capture files**

In `packages/opencode-plugin/src/message-tail.ts`:

Add a `FileInfo` type:

```typescript
export type FileInfo = {
  mime: string;
  filename: string;
  url: string;
}
```

Extend `SessionTail` to include files:

```typescript
type SessionTail = {
  currentMessageId: string | undefined
  text: string
  files: FileInfo[]
  seenAnyMessage: boolean
  lastSeenAt: number
}
```

Initialize `files: []` in `getOrCreate`.

Reset `files` in `onMessageUpdated` when a new assistant message starts (alongside `tail.text = ""`).

Extend `onPartUpdated` to capture file parts:

```typescript
onPartUpdated(part: PartInfo & { mime?: string; filename?: string; url?: string }, delta?: string): void {
  if (part.type === "file" && part.mime && part.url) {
    const tail = this.getOrCreate(part.sessionID)
    if (tail.currentMessageId === part.messageID) {
      tail.files.push({
        mime: part.mime,
        filename: part.filename ?? "file",
        url: part.url,
      })
    }
    return
  }

  if (part.type !== "text") return
  // ... existing text logic unchanged ...
}
```

Add `onToolAttachments` method:

```typescript
onToolAttachments(sessionID: string, messageID: string, attachments: FileInfo[]): void {
  const tail = this.getOrCreate(sessionID)
  if (tail.currentMessageId === messageID) {
    tail.files.push(...attachments)
  }
}
```

Add `getFiles` method:

```typescript
getFiles(sessionID: string): FileInfo[] {
  const tail = this.sessions.get(sessionID)
  return tail?.files ?? []
}
```

Update `clear` to also reset files (already handled since we delete the session entry).

**Step 4: Run tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat(plugin): capture FileParts and tool attachments in MessageTail"
```

---

### Task 8: Plugin Outbound — Include Files in Notifications

**Files:**
- Modify: `packages/opencode-plugin/src/daemon-client.ts` (add media to notifyStop)
- Modify: `packages/opencode-plugin/src/index.ts:273-305` (pass files to notifyStop)
- Test: `packages/opencode-plugin/test/daemon-client.test.ts`

**Step 1: Write failing tests**

In `daemon-client.test.ts`:

```typescript
describe("notifyStop with media", () => {
  it("includes media array in POST body when files present", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    // Call notifyStop with media field
    // Verify the POST body includes media array
  });

  it("omits media field when no files", async () => {
    // Call notifyStop without media
    // Verify POST body has no media field (backward compatible)
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Extend NotifyStopOpts and notifyStop**

In `packages/opencode-plugin/src/daemon-client.ts`:

```typescript
type FileMedia = {
  mime: string;
  filename: string;
  url: string;
}

type NotifyStopOpts = {
  sessionId: string
  message: string
  label: string
  media?: FileMedia[]
  daemonUrl?: string
  log: LogFn
}
```

In the `notifyStop` function, include media in the POST body:

```typescript
body: JSON.stringify({
  session_id: opts.sessionId,
  event: "Stop",
  message: opts.message,
  label: opts.label,
  ...(opts.media && opts.media.length > 0 ? { media: opts.media } : {}),
}),
```

**Step 4: Pass files from plugin to notifyStop in index.ts**

In the `session.idle` handler (around line 291):

```typescript
const summary = messageTail.getSummary(sessionID) || "Task completed"
const files = messageTail.getFiles(sessionID)
log("sending notifyStop", { sessionID, summary: summary.slice(0, 100), fileCount: files.length })
notifyStop({
  sessionId: sessionID,
  message: summary,
  label,
  media: files.length > 0 ? files : undefined,
  daemonUrl,
  log,
}).catch((err) => { ... })
```

Do the same for the pre-question flush in the `question.asked` handler (around line 431-434).

**Step 5: Run tests**

Run: `bun run test`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/opencode-plugin/src/daemon-client.ts packages/opencode-plugin/src/index.ts packages/opencode-plugin/test/daemon-client.test.ts
git commit -m "feat(plugin): include captured files in stop notifications to daemon"
```

---

### Task 9: Daemon Outbound — Upload Media to R2 and Notify Worker

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (extend NotificationInput, format, and send)
- Modify: `packages/daemon/src/worker/machine-agent.ts:320-344` (extend sendNotification)
- Test: `packages/daemon/test/notification-service.test.ts`
- Test: `packages/daemon/test/machine-agent.test.ts`

**Step 1: Write failing tests**

In `notification-service.test.ts`:

```typescript
describe("notification with media", () => {
  it("passes media through to worker notification sender", async () => {
    // Create WorkerNotificationService with mock sender
    // Call sendStopNotification with input that has media
    // Verify sender.sendNotification receives media array
  });
});
```

In `machine-agent.test.ts`:

```typescript
describe("sendNotification with media", () => {
  it("includes media array in POST to worker /notifications/send", async () => {
    // Call sendNotification with media parameter
    // Verify fetch body includes media
  });

  it("uploads media files to R2 before sending notification", async () => {
    // Call sendNotification with media containing data URIs
    // Verify /media/upload called for each file
    // Verify /notifications/send called with R2 keys
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Extend daemon notification chain**

Add media to the daemon's `/stop` route handler — it needs to accept the `media` array from the plugin and pass it through to the notification service. Check the daemon's route handler for `/stop` and extend the request body parsing.

Extend `WorkerNotificationSender`:

```typescript
export interface WorkerNotificationSender {
  sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
    media?: Array<{ key: string; mime: string; filename: string }>,
  ): Promise<{ ok: boolean }>;
}
```

Extend `MachineAgent.sendNotification` to:
1. Accept media URLs from the daemon notification service
2. Upload each to R2 via `POST /media/upload`
3. Include the resulting keys in the POST to `/notifications/send`

```typescript
async sendNotification(
  sessionId: string,
  chatId: string,
  text: string,
  replyMarkup: { inline_keyboard?: unknown[] },
  media?: Array<{ key: string; mime: string; filename: string }>,
): Promise<{ ok: boolean }> {
  try {
    const response = await this.fetchFn(`${this.config.workerUrl}/notifications/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        chatId,
        text,
        replyMarkup,
        ...(media && media.length > 0 ? { media } : {}),
      }),
    });
    return await response.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}
```

The daemon notification service needs a `uploadMediaToR2` step before calling `sendNotification`. This involves:
1. For each media item (which has a `url` — could be data URI or file path), decode the data
2. POST to `workerUrl/media/upload` as multipart form data
3. Collect the R2 keys
4. Pass keys to `sendNotification`

This logic should live in the notification service (or a helper), not in the machine agent. The machine agent is just the transport layer.

**Step 4: Run tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/src/worker/machine-agent.ts packages/daemon/test/notification-service.test.ts packages/daemon/test/machine-agent.test.ts
git commit -m "feat(daemon): upload outbound media to R2 and include in worker notifications"
```

---

### Task 10: Worker Outbound — Send Media to Telegram

**Files:**
- Modify: `packages/worker/src/notifications.ts:3-8,121-209` (extend body, add sendPhoto/sendDocument)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

```typescript
describe("POST /notifications/send with media", () => {
  it("sends text via sendMessage, then each image via sendPhoto as reply", async () => {
    // POST notification with media array containing image/jpeg
    // Verify: sendMessage called first (text)
    // Verify: sendPhoto called with R2 file data, reply_to_message_id = text message ID
  });

  it("uses sendDocument for non-image files", async () => {
    // POST notification with media containing application/pdf
    // Verify: sendDocument called (not sendPhoto)
  });

  it("stores message mappings for both text and media messages", async () => {
    // POST notification with media
    // Verify: messages table has entries for both the text message and the media message
  });

  it("continues sending remaining files if one fails", async () => {
    // POST notification with 2 media items, mock first sendPhoto to fail
    // Verify: second sendPhoto still attempted
    // Verify: text notification was still sent successfully
  });

  it("works normally without media (backward compatible)", async () => {
    // POST notification without media field
    // Verify: only sendMessage called, existing behavior unchanged
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Extend SendNotificationBody**

```typescript
interface SendNotificationBody {
  sessionId: string;
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
  media?: Array<{
    key: string;
    mime: string;
    filename: string;
  }>;
}
```

**Step 4: Add Telegram media send helpers**

Add helpers in `notifications.ts` or a new `telegram-api.ts`:

```typescript
async function sendTelegramPhoto(
  env: Env,
  chatId: string | number,
  photo: Blob,
  filename: string,
  caption?: string,
  replyToMessageId?: number,
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", photo, filename);
  if (caption) form.append("caption", caption);
  if (replyToMessageId) form.append("reply_to_message_id", String(replyToMessageId));

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form },
  );
  return res.json() as Promise<{ ok: boolean; result?: { message_id: number } }>;
}

async function sendTelegramDocument(
  env: Env,
  chatId: string | number,
  document: Blob,
  filename: string,
  caption?: string,
  replyToMessageId?: number,
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", document, filename);
  if (caption) form.append("caption", caption);
  if (replyToMessageId) form.append("reply_to_message_id", String(replyToMessageId));

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form },
  );
  return res.json() as Promise<{ ok: boolean; result?: { message_id: number } }>;
}
```

**Step 5: Extend handleSendNotification**

After the existing `sendMessage` call succeeds and `messageId` is obtained, add media sending:

```typescript
// Send media as replies to the text message
if (body.media && body.media.length > 0) {
  for (const item of body.media) {
    try {
      const object = await env.MEDIA.get(item.key);
      if (!object?.body) continue;

      const blob = new Blob([await object.arrayBuffer()], { type: item.mime });
      const isImage = item.mime.startsWith("image/");

      const mediaResult = isImage
        ? await sendTelegramPhoto(env, chatId, blob, item.filename, undefined, messageId)
        : await sendTelegramDocument(env, chatId, blob, item.filename, undefined, messageId);

      // Store media message mapping for reply routing
      if (mediaResult.ok && mediaResult.result) {
        sql.exec(
          "INSERT INTO messages (chat_id, message_id, session_id, token, created_at) VALUES (?, ?, ?, ?, ?)",
          String(chatId),
          mediaResult.result.message_id,
          sessionId,
          token,
          Date.now(),
        );
      }
    } catch {
      // Log but don't fail — text notification already sent
      continue;
    }
  }
}
```

**Step 6: Run tests**

Run: `bun run test`
Expected: PASS

**Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add packages/worker/src/notifications.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): send media to Telegram via sendPhoto/sendDocument in notifications"
```

---

### Task 11: R2 Cleanup Cron Handler

**Files:**
- Create or modify: `packages/worker/src/index.ts` (add scheduled handler)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

```typescript
describe("R2 cleanup cron", () => {
  it("deletes objects older than 24 hours", async () => {
    // Upload objects with old timestamps in keys
    // Trigger scheduled handler
    // Verify old objects deleted, recent ones preserved
  });

  it("does nothing when bucket is empty", async () => {
    // Trigger scheduled handler with empty bucket
    // Verify no errors
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL

**Step 3: Implement scheduled handler**

Check how `packages/worker/src/index.ts` exports the worker. If it uses `export default { fetch, ... }`, add `scheduled`:

```typescript
export default {
  fetch: ...,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await cleanupExpiredMedia(env);
  },
};
```

Add the cleanup function (in `media.ts` or inline):

```typescript
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function cleanupExpiredMedia(env: Env): Promise<number> {
  const cutoff = Date.now() - MEDIA_TTL_MS;
  let deleted = 0;

  for (const prefix of ["inbound/", "outbound/"]) {
    let cursor: string | undefined;
    do {
      const listed = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
      const toDelete: string[] = [];

      for (const object of listed.objects) {
        // Key format: {prefix}{timestamp}-{id}/{filename}
        const afterPrefix = object.key.slice(prefix.length);
        const timestampStr = afterPrefix.split("-")[0];
        const timestamp = parseInt(timestampStr, 10);
        if (!isNaN(timestamp) && timestamp < cutoff) {
          toDelete.push(object.key);
        }
      }

      if (toDelete.length > 0) {
        await env.MEDIA.delete(toDelete);
        deleted += toDelete.length;
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  return deleted;
}
```

**Step 4: Run tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/worker/src/media.ts packages/worker/src/index.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add hourly R2 cleanup cron for expired media"
```

---

### Task 12: Full Integration Test and Typecheck

**Files:**
- All packages

**Step 1: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

**Step 2: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors

**Step 3: Fix any issues found**

Address any test failures or type errors.

**Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: resolve integration issues from media relay implementation"
```

---

## Deployment Notes

After all tasks are implemented and tests pass:

1. **Create R2 bucket** before deploying: `npx wrangler r2 bucket create pigeon-media`
2. **Deploy worker**: `bun run --filter '@pigeon/worker' deploy`
3. **Deploy daemon**: `git pull && bun install` on each machine, restart `pigeon-daemon`
4. **Deploy plugin**: Plugin is bundled with daemon, restarts pick it up
5. **Smoke test**: Send a photo to the bot as a reply to a session notification, verify Claude receives it

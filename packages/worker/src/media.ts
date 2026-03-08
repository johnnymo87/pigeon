import { verifyApiKey, unauthorized } from "./auth";

export interface MediaRef {
  key: string;
  mime: string;
  filename: string;
  size: number;
}

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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
        const timestampStr = afterPrefix.split("-")[0] ?? "";
        const timestamp = parseInt(timestampStr, 10);
        if (!isNaN(timestamp) && timestamp < cutoff) {
          toDelete.push(object.key);
        }
      }

      if (toDelete.length > 0) {
        await env.MEDIA.delete(toDelete);
        deleted += toDelete.length;
      }

      cursor = listed.truncated ? (listed as { cursor: string }).cursor : undefined;
    } while (cursor);
  }

  return deleted;
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

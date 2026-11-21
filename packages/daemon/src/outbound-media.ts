/**
 * Outbound media: files a session produced (a read-tool screenshot, a FilePart) that should be
 * posted beside its stop notification (pigeon-4ogz.23).
 *
 * The plugin sends them to `POST /stop` as data URIs. The handler cannot upload them to R2 itself:
 * the plugin gives /stop 3s, and a multi-megabyte upload would turn every stop with an image into
 * a timeout. So /stop only validates them and parks them in the outbox payload as `mediaPending`;
 * the outbox sender uploads them before the entry's first send and rewrites the payload to the R2
 * keys (`media`) the worker's `/notifications/send` already understands.
 */

/** A file waiting to be uploaded. `data` is the base64 body of the data URI. */
export interface PendingMedia {
  mime: string;
  filename: string;
  data: string;
}

/** An uploaded file, as `/notifications/send` takes it. */
export interface UploadedMedia {
  key: string;
  mime: string;
  filename: string;
}

/** Cap on files per stop. Matches the inbound cap for a Slack message. */
export const MAX_OUTBOUND_MEDIA_FILES = 10;
/** Per-file cap, decoded. The worker's `/media/upload` refuses anything larger. */
export const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024;
/** Cap on all files of one stop, decoded: the payload sits in a SQLite row until it is sent. */
export const MAX_OUTBOUND_MEDIA_TOTAL_BYTES = 30 * 1024 * 1024;

const DATA_URI = /^data:[^,]*;base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const MAX_FILENAME = 128;

export function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * The last path segment, without control characters, at most 128 characters. It becomes the
 * last segment of an R2 key and the name a chat shows, so it must not carry a path.
 */
export function sanitizeMediaFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "" || clean === "." || clean === "..") return "file";
  return [...clean].slice(0, MAX_FILENAME).join("");
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
};

/**
 * A read-tool attachment has no filename, so the plugin sends "file", and the chat would show a
 * file named `file`. Give a name without an extension one from its mime type.
 */
export function withMediaExtension(filename: string, mime: string): string {
  if (/\.[A-Za-z0-9]{1,8}$/.test(filename)) return filename;
  const ext = EXTENSIONS[mime.toLowerCase()];
  return ext ? `${filename}.${ext}` : filename;
}

export type MediaSkip = { index: number; reason: string; filename?: string };

/**
 * Validates `/stop`'s `media`. Never throws and never rejects the stop: a file that cannot be
 * posted is skipped and reported, because the text is the notification and must still go.
 * Only base64 data URIs are accepted; the plugin sends nothing else, and a URL would mean the
 * daemon fetching whatever a request names.
 */
export function parseStopMedia(raw: unknown): { media: PendingMedia[]; skipped: MediaSkip[] } {
  const media: PendingMedia[] = [];
  const skipped: MediaSkip[] = [];
  if (!Array.isArray(raw)) return { media, skipped };
  let total = 0;
  raw.forEach((item, index) => {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const filename = typeof rec?.filename === "string" ? sanitizeMediaFilename(rec.filename) : "file";
    const skip = (reason: string) => skipped.push({ index, reason, filename });
    if (!rec) return skip("not_an_object");
    if (media.length >= MAX_OUTBOUND_MEDIA_FILES) return skip("too_many_files");
    if (typeof rec.mime !== "string" || !MIME.test(rec.mime)) return skip("bad_mime");
    if (typeof rec.url !== "string") return skip("no_url");
    const prefix = DATA_URI.exec(rec.url);
    if (!prefix) return skip("not_a_base64_data_uri");
    const data = rec.url.slice(prefix[0].length);
    if (data.length === 0 || !BASE64.test(data)) return skip("bad_base64");
    const bytes = decodedBase64Bytes(data);
    if (bytes > MAX_OUTBOUND_MEDIA_BYTES) return skip("too_large");
    if (total + bytes > MAX_OUTBOUND_MEDIA_TOTAL_BYTES) return skip("total_too_large");
    total += bytes;
    media.push({ mime: rec.mime, filename: withMediaExtension(filename, rec.mime), data });
  });
  return { media, skipped };
}

/** Narrows a stored payload's `mediaPending` / `media`. Malformed items are dropped. */
export function readPendingMedia(raw: unknown): PendingMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is PendingMedia =>
      !!m &&
      typeof m === "object" &&
      typeof (m as PendingMedia).mime === "string" &&
      typeof (m as PendingMedia).filename === "string" &&
      typeof (m as PendingMedia).data === "string",
  );
}

export function readUploadedMedia(raw: unknown): UploadedMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is UploadedMedia =>
      !!m &&
      typeof m === "object" &&
      typeof (m as UploadedMedia).key === "string" &&
      typeof (m as UploadedMedia).mime === "string" &&
      typeof (m as UploadedMedia).filename === "string",
  );
}

/** The R2 key for one outbound file. The worker's TTL sweep parses the leading timestamp. */
export function outboundMediaKey(now: number, id: string, filename: string): string {
  return `outbound/${now}-${id}/${filename}`;
}

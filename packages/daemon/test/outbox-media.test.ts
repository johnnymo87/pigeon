import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { MEDIA_UPLOAD_TRIES, OutboxSender, type SendNotificationFn, type UploadMediaFn } from "../src/worker/outbox-sender";
import type { SendNotificationInput } from "../src/worker/poller";

/**
 * Outbound media (pigeon-4ogz.23): the sender uploads a stop's parked files to R2 before its first
 * send, persists the keys, and hands them to the worker on chunk 0.
 */
describe("OutboxSender outbound media", () => {
  let storage: StorageDb;
  let now = 5_000;
  const PNG = Buffer.from("png-bytes").toString("base64");
  const PDF = Buffer.from("pdf-bytes").toString("base64");
  const success = { ok: true, kind: "success", status: 200, body: { ok: true, messageId: 1 } } as const;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
    now = 5_000;
  });

  afterEach(() => {
    storage.db.close();
  });

  function seed(opts: { messages?: Array<{ text: string }>; mediaPending?: unknown; rich?: unknown } = {}): void {
    storage.outbox.upsert({
      notificationId: "stop-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "stop",
      payload: JSON.stringify({
        messages: opts.messages ?? [{ text: "hello" }],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "stop-1",
        ...(opts.rich ? { rich: opts.rich } : {}),
        mediaPending: opts.mediaPending ?? [
          { mime: "image/png", filename: "shot.png", data: PNG },
          { mime: "application/pdf", filename: "doc.pdf", data: PDF },
        ],
      }),
      token: "tok",
    }, 1_000);
  }

  function sender(sendFn: SendNotificationFn, uploadMedia?: UploadMediaFn, log = vi.fn()) {
    return new OutboxSender({ storage, sendNotification: sendFn, uploadMedia, chatId: "chat-1", nowFn: () => now, log });
  }

  const stored = () => JSON.parse(storage.outbox.getByNotificationId("stop-1")!.payload) as Record<string, unknown>;

  it("uploads each file, sends their keys with the text and persists the keys", async () => {
    seed();
    const sendFn = vi.fn().mockResolvedValue(success);
    const upload = vi.fn(async (key: string) => ({ ok: true as const, key }));
    await sender(sendFn as unknown as SendNotificationFn, upload).processOnce();

    expect(upload).toHaveBeenCalledTimes(2);
    const [key0, data0, mime0, name0] = upload.mock.calls[0]! as unknown as [string, Uint8Array, string, string];
    expect(key0).toMatch(/^outbound\/5000-[0-9a-f-]{36}\/shot\.png$/);
    expect(Buffer.from(data0).toString()).toBe("png-bytes");
    expect([mime0, name0]).toEqual(["image/png", "shot.png"]);

    const input = sendFn.mock.calls[0]![0] as SendNotificationInput;
    expect(input.media).toEqual([
      { key: key0, mime: "image/png", filename: "shot.png" },
      { key: (upload.mock.calls[1] as unknown as [string])[0], mime: "application/pdf", filename: "doc.pdf" },
    ]);
    expect(storage.outbox.getByNotificationId("stop-1")!.state).toBe("sent");
    expect(stored()).not.toHaveProperty("mediaPending");
    expect(stored().media).toEqual(input.media);
  });

  it("puts media on chunk 0 only", async () => {
    seed({ messages: [{ text: "a" }, { text: "b" }] });
    const sendFn = vi.fn().mockResolvedValue(success);
    await sender(sendFn as unknown as SendNotificationFn, async (key) => ({ ok: true, key })).processOnce();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media).toHaveLength(2);
    expect((sendFn.mock.calls[1]![0] as SendNotificationInput).media).toBeUndefined();
  });

  it("does not upload again on a retry after the send failed", async () => {
    seed();
    const sendFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: "http_error", status: 503, body: { error: "x" } })
      .mockResolvedValue(success);
    const upload = vi.fn(async (key: string) => ({ ok: true as const, key }));
    const s = sender(sendFn as unknown as SendNotificationFn, upload);
    await s.processOnce();
    expect(storage.outbox.getByNotificationId("stop-1")!.state).toBe("queued");
    now += 10 * 60_000;
    await s.processOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect((sendFn.mock.calls[1]![0] as SendNotificationInput).media).toEqual(
      (sendFn.mock.calls[0]![0] as SendNotificationInput).media,
    );
    expect(storage.outbox.getByNotificationId("stop-1")!.state).toBe("sent");
  });

  it("holds the text on a transient upload failure, keeps what uploaded, and retries the rest", async () => {
    seed();
    const sendFn = vi.fn().mockResolvedValue(success);
    const upload = vi
      .fn()
      .mockImplementationOnce(async (key: string) => ({ ok: true, key }))
      .mockImplementationOnce(async () => ({ ok: false, key: "", permanent: false, error: "HTTP 503" }))
      .mockImplementation(async (key: string) => ({ ok: true, key }));
    const s = sender(sendFn as unknown as SendNotificationFn, upload as unknown as UploadMediaFn);
    await s.processOnce();
    expect(sendFn).not.toHaveBeenCalled();
    const entry = storage.outbox.getByNotificationId("stop-1")!;
    expect(entry.state).toBe("queued");
    expect(entry.attempts).toBe(0);
    expect(stored().media).toHaveLength(1);
    expect(stored().mediaPending).toEqual([{ mime: "application/pdf", filename: "doc.pdf", data: PDF }]);

    now += 10 * 60_000;
    await s.processOnce();
    expect(upload).toHaveBeenCalledTimes(3);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media!.map((m) => m.filename)).toEqual([
      "shot.png",
      "doc.pdf",
    ]);
  });

  it(`sends the text without a file after ${MEDIA_UPLOAD_TRIES} transient failures`, async () => {
    seed({ mediaPending: [{ mime: "image/png", filename: "shot.png", data: PNG }] });
    const sendFn = vi.fn().mockResolvedValue(success);
    const upload = vi.fn(async () => ({ ok: false as const, key: "" as const, permanent: false, error: "timeout" }));
    const log = vi.fn();
    const s = sender(sendFn as unknown as SendNotificationFn, upload, log);
    for (let i = 0; i < MEDIA_UPLOAD_TRIES; i++) {
      await s.processOnce();
      now += 10 * 60_000;
    }
    expect(upload).toHaveBeenCalledTimes(MEDIA_UPLOAD_TRIES);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media).toBeUndefined();
    expect(storage.outbox.getByNotificationId("stop-1")!.state).toBe("sent");
    expect(stored()).not.toHaveProperty("mediaPending");
    expect(log.mock.calls.some(([m]) => String(m).includes("media dropped"))).toBe(true);
  });

  it("drops a file the worker refuses and sends the rest at once", async () => {
    seed();
    const sendFn = vi.fn().mockResolvedValue(success);
    const upload = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: false, key: "", permanent: true, error: "HTTP 413" }))
      .mockImplementation(async (key: string) => ({ ok: true, key }));
    await sender(sendFn as unknown as SendNotificationFn, upload as unknown as UploadMediaFn).processOnce();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media!.map((m) => m.filename)).toEqual(["doc.pdf"]);
  });

  it("sends the text without media when no uploader is configured", async () => {
    seed();
    const sendFn = vi.fn().mockResolvedValue(success);
    await sender(sendFn as unknown as SendNotificationFn).processOnce();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media).toBeUndefined();
    expect(storage.outbox.getByNotificationId("stop-1")!.state).toBe("sent");
  });

  it("rides with a rich chunk 0 that ends the entry", async () => {
    seed({ messages: [{ text: "a" }, { text: "b" }], rich: { markdown: "| a |\n|---|\n| 1 |" } });
    const sendFn = vi.fn().mockResolvedValue({ ...success, body: { ok: true, messageId: 1, rich: "sent" } });
    await sender(sendFn as unknown as SendNotificationFn, async (key) => ({ ok: true, key })).processOnce();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect((sendFn.mock.calls[0]![0] as SendNotificationInput).media).toHaveLength(2);
  });
});

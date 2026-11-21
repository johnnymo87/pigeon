import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

/**
 * A stop carrying `media` (data URIs from the plugin) parks the files in its outbox payload as
 * `mediaPending`, for the outbox sender to upload (pigeon-4ogz.23). /stop itself never uploads:
 * the plugin gives it 3s.
 */
describe("POST /stop media payload", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  async function stop(extra: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000, machineId: "devbox" });
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-m", notify: true, label: "lbl" }),
    }));
    const res = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-m", event: "Stop", message: "Here it is", notification_id: "s:sess-m:m.0", ...extra }),
    }));
    return { status: res.status, payload: JSON.parse(storage.outbox.getByNotificationId("s:sess-m:m.0")!.payload) };
  }

  it("parks valid media as mediaPending", async () => {
    const data = Buffer.from("png").toString("base64");
    const { status, payload } = await stop({
      media: [{ mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${data}` }],
    });
    expect(status).toBe(202);
    expect(payload.mediaPending).toEqual([{ mime: "image/png", filename: "shot.png", data }]);
    expect(payload).not.toHaveProperty("media");
  });

  it("adds no media field to a stop without media", async () => {
    const { payload } = await stop({});
    expect(payload).not.toHaveProperty("mediaPending");
    expect(payload).not.toHaveProperty("media");
  });

  it("still queues the text when every file is unusable", async () => {
    const { status, payload } = await stop({
      media: [{ mime: "image/png", filename: "a.png", url: "https://example.com/a.png" }],
    });
    expect(status).toBe(202);
    expect(payload).not.toHaveProperty("mediaPending");
    expect((payload.messages as Array<{ text: string }>)[0]!.text).toContain("Here it is");
  });
});

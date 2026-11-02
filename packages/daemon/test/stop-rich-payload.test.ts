import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

/**
 * A stop whose body contains a pipe table carries `rich: {markdown}` in its outbox payload, so
 * the outbox can ask the worker for one Telegram rich message (pigeon-p909). Everything else
 * stays exactly as it was: no `rich` field at all.
 */
describe("POST /stop rich payload", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  async function stopPayload(message: string): Promise<Record<string, unknown>> {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000, chatId: "chat-1", machineId: "devbox" });
    await app(new Request("http://localhost/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-r", notify: true, label: "my_label" }),
    }));
    const res = await app(new Request("http://localhost/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-r", event: "Stop", message, notification_id: "s:sess-r:m.0" }),
    }));
    expect(res.status).toBe(202);
    return JSON.parse(storage.outbox.getByNotificationId("s:sess-r:m.0")!.payload);
  }

  it("adds rich markdown when the message contains a table", async () => {
    const payload = await stopPayload("Costs:\n| tag | $ |\n|---|---|\n| a | $5 |");
    const rich = payload.rich as { markdown: string };
    expect(rich.markdown).toContain("| tag | \\$ |\n|---|---|\n| a | \\$5 |");
    expect(rich.markdown).toContain("Costs:\n\n| tag");
    // Footer converted with code spans, session id included.
    expect(rich.markdown).toContain("🆔 `sess-r`");
    // The plain chunks are still there, unchanged, for the fallback.
    const messages = payload.messages as Array<{ text: string }>;
    expect(messages[0]!.text).toContain("| tag | $ |");
  });

  it("adds no rich field when the message has no table", async () => {
    const payload = await stopPayload("Done, **all** good");
    expect(payload).not.toHaveProperty("rich");
  });
});

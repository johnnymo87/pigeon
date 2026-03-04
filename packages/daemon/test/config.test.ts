import { describe, expect, it } from "vitest";
import { loadConfig, parsePort } from "../src/config";

describe("parsePort", () => {
  it("uses default when unset", () => {
    expect(parsePort(undefined)).toBe(4731);
    expect(parsePort("")).toBe(4731);
  });

  it("accepts valid integer ports", () => {
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects invalid ports", () => {
    expect(() => parsePort("0")).toThrow("Invalid PIGEON_DAEMON_PORT");
    expect(() => parsePort("65536")).toThrow("Invalid PIGEON_DAEMON_PORT");
    expect(() => parsePort("nope")).toThrow("Invalid PIGEON_DAEMON_PORT");
  });
});

describe("loadConfig", () => {
  it("loads port from env", () => {
    const config = loadConfig({ PIGEON_DAEMON_PORT: "6123" });
    expect(config.port).toBe(6123);
    expect(config.dbPath).toContain("data/pigeon-daemon.db");
  });

  it("loads db path override from env", () => {
    const config = loadConfig({ PIGEON_DAEMON_DB_PATH: "/tmp/daemon.db" });
    expect(config.dbPath).toBe("/tmp/daemon.db");
  });

  it("loads telegram env vars", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "bot",
      TELEGRAM_CHAT_ID: "123",
    });
    expect(config.telegramBotToken).toBe("bot");
    expect(config.telegramChatId).toBe("123");
  });

  it("loads opencode env vars when OPENCODE_URL and OPENCODE_PASSWORD are set", () => {
    const config = loadConfig({
      OPENCODE_URL: "http://localhost:4320",
      OPENCODE_PASSWORD: "hunter2",
    });
    expect(config.opencodeUrl).toBe("http://localhost:4320");
    expect(config.opencodePassword).toBe("hunter2");
  });

  it("returns undefined for opencodeUrl and opencodePassword when env vars are not set", () => {
    const config = loadConfig({});
    expect(config.opencodeUrl).toBeUndefined();
    expect(config.opencodePassword).toBeUndefined();
  });
});

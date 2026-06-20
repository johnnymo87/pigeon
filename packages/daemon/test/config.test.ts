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

  it("loads opencode env vars when OPENCODE_URL is set", () => {
    const config = loadConfig({
      OPENCODE_URL: "http://localhost:4320",
    });
    expect(config.opencodeUrl).toBe("http://localhost:4320");
  });

  it("returns undefined for opencodeUrl when env var is not set", () => {
    const config = loadConfig({});
    expect(config.opencodeUrl).toBeUndefined();
  });

  it("loads routing fields with defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.serveEndpoints).toEqual([]);
    expect(config.leaseTtlMs).toBe(30000);
    expect(config.staleServeMs).toBe(15000);
    expect(config.healthPollMs).toBe(5000);
    expect(config.activeTurnCap).toBe(25);
    expect(config.idleMigrateMs).toBe(60000);
    expect(config.dormantTtlMs).toBe(300000);
  });

  it("loads routing fields from env", () => {
    const config = loadConfig({
      PIGEON_SERVE_ENDPOINTS: "http://endpoint1, http://endpoint2 ",
      PIGEON_LEASE_TTL_MS: "10000",
      PIGEON_SERVE_STALE_MS: "5000",
      PIGEON_HEALTH_POLL_MS: "2000",
      PIGEON_ACTIVE_TURN_CAP: "10",
      PIGEON_IDLE_MIGRATE_MS: "12000",
      PIGEON_DORMANT_TTL_MS: "15000",
    });
    expect(config.serveEndpoints).toEqual(["http://endpoint1", "http://endpoint2"]);
    expect(config.leaseTtlMs).toBe(10000);
    expect(config.staleServeMs).toBe(5000);
    expect(config.healthPollMs).toBe(2000);
    expect(config.activeTurnCap).toBe(10);
    expect(config.idleMigrateMs).toBe(12000);
    expect(config.dormantTtlMs).toBe(15000);
  });

  it("falls back to default if parsing numbers results in NaN or empty", () => {
    const config = loadConfig({
      PIGEON_LEASE_TTL_MS: "nope",
      PIGEON_SERVE_STALE_MS: "",
      PIGEON_HEALTH_POLL_MS: "  ",
    });
    expect(config.leaseTtlMs).toBe(30000);
    expect(config.staleServeMs).toBe(15000);
    expect(config.healthPollMs).toBe(5000);
  });

  it("falls back to opencodeUrl for serveEndpoints when PIGEON_SERVE_ENDPOINTS is empty and OPENCODE_URL is set", () => {
    const config = loadConfig({
      OPENCODE_URL: "http://localhost:4096"
    });
    expect(config.serveEndpoints).toEqual(["http://localhost:4096"]);
  });
});

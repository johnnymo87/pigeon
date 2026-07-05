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
    expect(config.serveLiveness).toBe("http");
  });

  it("loads serveLiveness from env", () => {
    const configSelf = loadConfig({ PIGEON_SERVE_LIVENESS: "self" });
    expect(configSelf.serveLiveness).toBe("self");

    const configHttp = loadConfig({ PIGEON_SERVE_LIVENESS: "http" });
    expect(configHttp.serveLiveness).toBe("http");

    const configInvalid = loadConfig({ PIGEON_SERVE_LIVENESS: "other" });
    expect(configInvalid.serveLiveness).toBe("http");
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

  it("parses PIGEON_ALLOWED_PROVIDERS into a list", () => {
    const config = loadConfig({
      PIGEON_ALLOWED_PROVIDERS: "anthropic, openai ,google-vertex,google-vertex-anthropic",
    });
    expect(config.allowedProviders).toEqual([
      "anthropic",
      "openai",
      "google-vertex",
      "google-vertex-anthropic",
    ]);
  });

  it("leaves allowedProviders undefined when PIGEON_ALLOWED_PROVIDERS is unset or empty", () => {
    expect(loadConfig({}).allowedProviders).toBeUndefined();
    expect(loadConfig({ PIGEON_ALLOWED_PROVIDERS: "" }).allowedProviders).toBeUndefined();
    expect(loadConfig({ PIGEON_ALLOWED_PROVIDERS: "  " }).allowedProviders).toBeUndefined();
  });

  it("loads delivery watchdog fields with defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.watchdogIntervalMs).toBe(60_000);
    expect(config.verifyAfterMs).toBe(300_000);
    expect(config.stuckAlertMs).toBe(900_000);
    expect(config.stuckAbortSilenceMs).toBe(3_600_000);
    expect(config.maxRequeues).toBe(3);
  });

  it("loads delivery watchdog fields from env", () => {
    const config = loadConfig({
      WATCHDOG_INTERVAL_MS: "30000",
      VERIFY_AFTER_MS: "60000",
      STUCK_ALERT_MS: "120000",
      STUCK_ABORT_SILENCE_MS: "180000",
      MAX_REQUEUES: "5",
    });
    expect(config.watchdogIntervalMs).toBe(30000);
    expect(config.verifyAfterMs).toBe(60000);
    expect(config.stuckAlertMs).toBe(120000);
    expect(config.stuckAbortSilenceMs).toBe(180000);
    expect(config.maxRequeues).toBe(5);
  });

  it("falls back to delivery watchdog defaults if parsing numbers results in NaN or empty", () => {
    const config = loadConfig({
      WATCHDOG_INTERVAL_MS: "nope",
      VERIFY_AFTER_MS: "",
      STUCK_ALERT_MS: "  ",
    });
    expect(config.watchdogIntervalMs).toBe(60_000);
    expect(config.verifyAfterMs).toBe(300_000);
    expect(config.stuckAlertMs).toBe(900_000);
  });
});

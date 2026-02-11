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
});

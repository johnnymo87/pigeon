import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveServeAuthHeader,
  invalidateServeAuthHeader,
} from "../src/serve-auth";

describe("serve-auth", () => {
  const origEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD_FILE;
    delete process.env.OPENCODE_SERVER_USERNAME;
    invalidateServeAuthHeader();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-auth-test-"));
  });

  afterEach(() => {
    process.env = origEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("returns undefined when OPENCODE_SERVER_PASSWORD and secret file are unset", () => {
    const dummyPath = path.join(tmpDir, "nonexistent");
    expect(resolveServeAuthHeader({ passwordFilePath: dummyPath })).toBeUndefined();
  });

  it("returns undefined when OPENCODE_SERVER_PASSWORD is empty or whitespace-only", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "   ";
    const dummyPath = path.join(tmpDir, "nonexistent");
    expect(resolveServeAuthHeader({ passwordFilePath: dummyPath })).toBeUndefined();
  });

  it("returns Basic header using process.env.OPENCODE_SERVER_PASSWORD and default username opencode", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "secretpassword";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:secretpassword").toString("base64")}`,
    );
  });

  it("matches known vector opencode:hunter2 -> Basic b3BlbmNvZGU6aHVudGVyMg==", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "hunter2";
    expect(resolveServeAuthHeader()).toBe("Basic b3BlbmNvZGU6aHVudGVyMg==");
  });

  it("trims whitespace from password and username", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "  mypassword \n";
    process.env.OPENCODE_SERVER_USERNAME = "  myuser  ";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("myuser:mypassword").toString("base64")}`,
    );
  });

  it("falls back to opencode when OPENCODE_SERVER_USERNAME is whitespace-only", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "mypassword";
    process.env.OPENCODE_SERVER_USERNAME = "   \t";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:mypassword").toString("base64")}`,
    );
  });

  it("uses password from secret file when env variable is not set", () => {
    const secretFile = path.join(tmpDir, "secret");
    fs.writeFileSync(secretFile, "filepassword\n");
    expect(resolveServeAuthHeader({ passwordFilePath: secretFile })).toBe(
      `Basic ${Buffer.from("opencode:filepassword").toString("base64")}`,
    );
  });

  it("env OPENCODE_SERVER_PASSWORD takes precedence over secret file", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "envpass";
    const secretFile = path.join(tmpDir, "secret");
    fs.writeFileSync(secretFile, "filepass\n");
    expect(resolveServeAuthHeader({ passwordFilePath: secretFile })).toBe(
      `Basic ${Buffer.from("opencode:envpass").toString("base64")}`,
    );
  });

  it("trims trailing newline from secret file", () => {
    const secretFile = path.join(tmpDir, "secret");
    fs.writeFileSync(secretFile, "filepass\r\n\n");
    expect(resolveServeAuthHeader({ passwordFilePath: secretFile })).toBe(
      `Basic ${Buffer.from("opencode:filepass").toString("base64")}`,
    );
  });

  it("returns undefined when secret file is empty or whitespace-only", () => {
    const secretFile = path.join(tmpDir, "secret");
    fs.writeFileSync(secretFile, "   \n");
    expect(resolveServeAuthHeader({ passwordFilePath: secretFile })).toBeUndefined();
  });

  it("handles missing or unreadable secret file gracefully", () => {
    const secretFile = path.join(tmpDir, "nonexistent");
    expect(resolveServeAuthHeader({ passwordFilePath: secretFile })).toBeUndefined();
  });

  it("caches resolved value until invalidateServeAuthHeader() is called", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "firstpass";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:firstpass").toString("base64")}`,
    );

    // Change env variable without invalidating
    process.env.OPENCODE_SERVER_PASSWORD = "secondpass";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:firstpass").toString("base64")}`,
    );

    // Now invalidate
    invalidateServeAuthHeader();
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:secondpass").toString("base64")}`,
    );
  });

  it("forceRefresh option clears cache and re-evaluates", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "firstpass";
    expect(resolveServeAuthHeader()).toBe(
      `Basic ${Buffer.from("opencode:firstpass").toString("base64")}`,
    );

    process.env.OPENCODE_SERVER_PASSWORD = "secondpass";
    expect(resolveServeAuthHeader({ forceRefresh: true })).toBe(
      `Basic ${Buffer.from("opencode:secondpass").toString("base64")}`,
    );
  });
});

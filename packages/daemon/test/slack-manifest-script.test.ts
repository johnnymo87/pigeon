/**
 * packages/worker/scripts/slack-manifest.mjs and packages/worker/slack/manifest.template.json
 * (pigeon-4ogz.2). Lives in the daemon suite for the same reason machine-key-script.test.ts
 * does: the worker suite runs inside workerd, which cannot touch the filesystem or spawn node.
 *
 * Spec: docs/plans/2026-11-20-slack-transport-design.md §2. The scope, event and command lists
 * below are the spec's, written out again on purpose: a change to the template must be a change
 * to this test too, so a scope cannot be added or dropped by accident.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs, no declarations
import * as script from "../../worker/scripts/slack-manifest.mjs";

const SCRIPT = join(__dirname, "../../worker/scripts/slack-manifest.mjs");
const TEMPLATE = join(__dirname, "../../worker/slack/manifest.template.json");
const BASE = "https://ccr-router.jonathan-mohrbacher.workers.dev";

const BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "incoming-webhook",
];
const COMMANDS = ["/compact", "/interrupt", "/kill", "/launch", "/mcp", "/model", "/retitle", "/tag"];

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: e.status, stdout: e.stdout.toString(), stderr: e.stderr.toString() };
  }
}

describe("manifest template", () => {
  it("is valid JSON whose only placeholders are {{MACHINE}} and {{BASE_URL}}", () => {
    const raw = readFileSync(TEMPLATE, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const placeholders = new Set(raw.match(/\{\{[^}]*\}\}/g));
    expect([...placeholders].sort()).toEqual(["{{BASE_URL}}", "{{MACHINE}}"]);
  });
});

describe("render", () => {
  const m = script.render("devbox", BASE);

  it("names the app after the workspace and leaves no placeholder behind", () => {
    expect(m.display_information.name).toBe("pigeon devbox");
    expect(m.display_information.name.length).toBeLessThanOrEqual(35);
    expect(JSON.stringify(m)).not.toContain("{{");
  });

  it("points all three request URLs at the machine's own paths", () => {
    expect(m.settings.event_subscriptions.request_url).toBe(`${BASE}/slack/devbox/events`);
    expect(m.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: `${BASE}/slack/devbox/interactivity`,
    });
    for (const c of m.features.slash_commands) {
      expect(c.url).toBe(`${BASE}/slack/devbox/commands`);
    }
  });

  it("requests exactly the spec's scopes", () => {
    expect([...m.oauth_config.scopes.bot].sort()).toEqual(BOT_SCOPES);
    expect(m.oauth_config.scopes.user).toEqual(["channels:write"]);
  });

  it("subscribes to message.channels only, as a bot event", () => {
    expect(m.settings.event_subscriptions.bot_events).toEqual(["message.channels"]);
    expect(m.settings.event_subscriptions.user_events).toBeUndefined();
  });

  it("registers exactly the eight commands, with /retitle instead of /rename", () => {
    const names = m.features.slash_commands.map((c: { command: string }) => c.command).sort();
    expect(names).toEqual(COMMANDS);
    expect(names).not.toContain("/rename");
    expect(names).not.toContain("/title");
    for (const c of m.features.slash_commands) {
      // Escaping would turn a typed #channel or @user into <#C…> markup inside a prompt.
      expect(c.should_escape).toBe(false);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("is an HTTP app with non-rotating tokens and incoming webhooks on", () => {
    // Rotating tokens expire every 12 h, and nothing in the worker refreshes them.
    expect(m.settings.token_rotation_enabled).toBe(false);
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.settings.org_deploy_enabled).toBe(false);
    expect(m.settings.incoming_webhooks).toEqual({ incoming_webhooks_enabled: true });
    expect(m.features.bot_user.display_name).toBe("pigeon");
  });

  it("renders a different machine into different paths", () => {
    const c = script.render("cloudbox", BASE);
    expect(c.display_information.name).toBe("pigeon cloudbox");
    expect(c.settings.event_subscriptions.request_url).toBe(`${BASE}/slack/cloudbox/events`);
  });

  it("drops one trailing slash from the base URL", () => {
    expect(script.render("devbox", `${BASE}/`).settings.interactivity.request_url).toBe(
      `${BASE}/slack/devbox/interactivity`,
    );
  });

  it.each(["Devbox", "dev box", "../x", "", "a".repeat(33)])("refuses machine id %j", (id) => {
    expect(() => script.render(id, BASE)).toThrow(/machine id/);
  });

  it.each([
    "http://ccr-router.jonathan-mohrbacher.workers.dev",
    "https://ccr-router.jonathan-mohrbacher.workers.dev/api",
    "https://x.dev?q=1",
    "not a url",
  ])("refuses base URL %j", (url) => {
    expect(() => script.render("devbox", url)).toThrow(/base URL/);
  });
});

const GOOD = {
  teamId: "T0123ABCD",
  appId: "A0123ABCD",
  domain: "pigeon-devbox",
  botToken: "xoxb-1111-2222-abcdefSECRETbot",
  userToken: "xoxp-1111-2222-3333-abcdefSECRETuser",
  signingSecret: "0123456789abcdef0123456789abcdef",
  ownerUserId: "U0123ABCD",
};

describe("checkConfig", () => {
  it("accepts a well-formed config", () => {
    expect(script.checkConfig({ ...GOOD })).toEqual([]);
  });

  it.each([
    ["teamId", "0123"],
    ["appId", "T0123ABCD"],
    ["domain", "pigeon-devbox.slack.com"],
    ["domain", "https://pigeon-devbox.slack.com"],
    ["botToken", "xoxp-1-2-3"],
    ["userToken", "xoxb-1-2"],
    ["signingSecret", "not-hex"],
    ["ownerUserId", "B0123ABCD"],
  ])("rejects a malformed %s", (field, value) => {
    const problems = script.checkConfig({ ...GOOD, [field]: value });
    expect(problems.join("\n")).toContain(field);
  });

  it.each(["xoxc-1-2-3", "xoxd-abc"])("rejects a client token %j and says why", (tok) => {
    const problems = script.checkConfig({ ...GOOD, userToken: tok });
    expect(problems.join("\n")).toMatch(/client.*token/i);
  });

  it("rejects missing and unknown fields", () => {
    const { ownerUserId: _drop, ...rest } = GOOD;
    expect(script.checkConfig(rest).join("\n")).toContain("ownerUserId");
    const extra = script.checkConfig({ ...GOOD, alarmWebhookUrl: "https://hooks.slack.com/x" });
    expect(extra.join("\n")).toContain("alarmWebhookUrl");
  });

  it("never echoes a value in a problem", () => {
    const problems = script.checkConfig({
      ...GOOD,
      botToken: "xoxq-LEAKME",
      userToken: "xoxc-LEAKME",
      signingSecret: "LEAKME",
      alarmWebhookUrl: "https://hooks.slack.com/LEAKME",
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain("LEAKME");
  });

  it("rejects a non-object", () => {
    expect(script.checkConfig([])).not.toEqual([]);
    expect(script.checkConfig(null)).not.toEqual([]);
  });
});

describe("CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("render prints the manifest as JSON", () => {
    const r = run(["render", "devbox"]);
    expect(r.code).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.settings.event_subscriptions.request_url).toBe(`${BASE}/slack/devbox/events`);
  });

  it("render honours --base-url", () => {
    const r = run(["render", "devbox", "--base-url", "https://example.test"]);
    expect(JSON.parse(r.stdout).settings.interactivity.request_url).toBe(
      "https://example.test/slack/devbox/interactivity",
    );
  });

  it("render with a bad machine fails without output", () => {
    const r = run(["render", "Dev Box"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("check-config passes a good 0600 file and prints no secret", () => {
    const f = join(dir, "cfg.json");
    writeFileSync(f, JSON.stringify(GOOD));
    chmodSync(f, 0o600);
    const r = run(["check-config", f]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("T0123ABCD");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
    expect(r.stdout + r.stderr).not.toContain(GOOD.signingSecret);
  });

  it("check-config refuses a file other users can read", () => {
    const f = join(dir, "cfg.json");
    writeFileSync(f, JSON.stringify(GOOD));
    chmodSync(f, 0o644);
    const r = run(["check-config", f]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/0600/);
  });

  it("check-config reports problems, exits 1, and does not echo the file", () => {
    const f = join(dir, "cfg.json");
    writeFileSync(f, JSON.stringify({ ...GOOD, userToken: "xoxc-SECRETclient" }));
    chmodSync(f, 0o600);
    const r = run(["check-config", f]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("userToken");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });

  function stage(file: string, field: string, value: string) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, "stage-field", file, field], {
        input: value + "\n",
        stdio: ["pipe", "pipe", "pipe"],
      }).toString();
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number; stdout: Buffer; stderr: Buffer };
      return { code: e.status, stdout: e.stdout.toString(), stderr: e.stderr.toString() };
    }
  }

  it("stage-field builds a config one field at a time, 0600, printing no secret", () => {
    const f = join(dir, "cfg.json");
    let out = "";
    for (const [k, v] of Object.entries(GOOD)) {
      const r = stage(f, k, v);
      expect(r.code).toBe(0);
      out += r.stdout + r.stderr;
    }
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain(GOOD.signingSecret.slice(0, 8));
    expect(out).toContain("xoxb-…");
    expect(out).toContain("T0123ABCD");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(GOOD);
    expect(run(["check-config", f]).code).toBe(0);
  });

  it("stage-field writes the webhook URL as a one-line file of its own", () => {
    const f = join(dir, "hook");
    const url = "https://hooks.slack.com/services/T0123/B0456/SECRETpart";
    const r = stage(f, "alarmWebhookUrl", url);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("SECRET");
    expect(r.stdout).not.toContain("T0123");
    expect(readFileSync(f, "utf8")).toBe(url + "\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("stage-field refuses a bad value without echoing it, and leaves the file alone", () => {
    const f = join(dir, "cfg.json");
    stage(f, "teamId", GOOD.teamId);
    const r = stage(f, "userToken", "xoxc-SECRETclient");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/client/);
    expect(r.stdout + r.stderr).not.toContain("SECRET");
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ teamId: GOOD.teamId });
    expect(stage(join(dir, "h"), "alarmWebhookUrl", "https://evil.test/SECRET").stderr).not.toContain("SECRET");
  });

  it("stage-field refuses unknown fields, loose permissions and git work trees", () => {
    const f = join(dir, "cfg.json");
    expect(stage(f, "clientToken", "x").code).toBe(1);
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);
    expect(stage(f, "teamId", GOOD.teamId).stderr).toMatch(/0600/);
    execFileSync("git", ["init", "-q", dir]);
    const g = join(dir, "inside.json");
    const r = stage(g, "teamId", GOOD.teamId);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/git work tree/);
  });

  it("check-config on unparseable JSON does not echo its content", () => {
    const f = join(dir, "cfg.json");
    writeFileSync(f, '{"botToken": "xoxb-SECRET"');
    chmodSync(f, 0o600);
    const r = run(["check-config", f]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });
});

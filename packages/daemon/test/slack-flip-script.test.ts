/**
 * packages/worker/scripts/slack-flip.mjs (pigeon-4ogz.6). Lives in the daemon suite, like
 * machine-key-script.test.ts, because the worker suite runs inside workerd, which cannot spawn
 * processes. Every side effect (sudo, sops, wrangler, the worker) is a fake here; the worker half
 * (POST /topics/named/rehome) is tested against D1 in packages/worker/test/slack-flip.test.ts.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error -- plain .mjs, no declarations
import * as script from "../../worker/scripts/slack-flip.mjs";

const CFG = {
  teamId: "T0CLL1EQAM6",
  appId: "A0CKTHXA7Q9",
  domain: "pigeon-devbox",
  botToken: "xoxb-1-2-abcdefghijklmnop",
  userToken: "xoxp-1-2-3-abcdefghijklmnop",
  signingSecret: "0123456789abcdef0123456789abcdef",
  ownerUserId: "U0CKTGLSULR",
};
const SECRET_BITS = [CFG.botToken, CFG.userToken, CFG.signingSecret];

interface Call {
  cmd: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

type RehomeReply = { status: number; body: unknown };

function fakeDeps(opts: {
  rehome: (body: Record<string, unknown>) => RehomeReply;
  tables?: string[];
  config?: string;
  secretDeleteFails?: string;
  secrets?: string[];
}) {
  const calls: Call[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const log: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const deps = {
    run(cmd: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}) {
      calls.push({ cmd, args, input: o.input, env: o.env });
      if (cmd === "sudo") return { status: 0, stdout: "AGE-SECRET-KEY-1FAKE\n", stderr: "" };
      if (cmd === "nix") return { status: 0, stdout: (opts.config ?? JSON.stringify(CFG)) + "\n", stderr: "" };
      if (args[1] === "d1") {
        const names = opts.tables ?? ["slack_conversations", "slack_posts", "named_topic_bindings"];
        return { status: 0, stdout: JSON.stringify([{ results: names.map((name) => ({ name })) }]), stderr: "" };
      }
      if (args[1] === "secret" && args[2] === "list") {
        const names = opts.secrets ?? ["SLACK_WORKSPACE_DEVBOX", "CCR_API_KEY"];
        return { status: 0, stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))), stderr: "" };
      }
      if (args[1] === "secret" && args[2] === "delete" && opts.secretDeleteFails) {
        return { status: 1, stdout: "", stderr: opts.secretDeleteFails };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    async fetch(url: string, init: { headers: Record<string, string>; body: string }) {
      expect(url).toBe("https://worker.test/topics/named/rehome");
      expect(init.headers.Authorization).toBe("Bearer pgk_runner");
      const body = JSON.parse(init.body);
      posts.push(body);
      const r = opts.rehome(body);
      return { status: r.status, json: async () => r.body };
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    readFile: (path: string) => {
      if (path === "/keys/worker") return "pgk_runner\n";
      if (path === "/cfg.json") return JSON.stringify(CFG);
      throw new Error(`unexpected read ${path}`);
    },
    fileMode: () => 0o100600,
    readStdin: () => JSON.stringify(CFG),
    log: (line: string) => log.push(line),
  };
  return { deps, calls, posts, log, sleeps };
}

const base = (argv: string[]) =>
  script.parseArgs([...argv, "--worker-url", "https://worker.test", "--key-file", "/keys/worker"]);

const moved = (sessionId: string, key: string) => ({ sessionId, key, outcome: "moved", chatId: "slack:T0CLL1EQAM6", messageThreadId: 2 ** 40 + 1, created: true });

describe("slack-flip.mjs", () => {
  it("parses its arguments strictly", () => {
    expect(() => script.parseArgs([])).toThrow(/usage/);
    expect(() => script.parseArgs(["devbox", "sideways"])).toThrow(/usage/);
    expect(() => script.parseArgs(["Dev Box", "on"])).toThrow(/usage/);
    expect(() => script.parseArgs(["devbox", "on", "--bogus"])).toThrow(/unknown argument/);
    // There is no way back to Telegram: `off` and `--telegram-chat` are gone.
    expect(() => script.parseArgs(["devbox", "off"])).toThrow(/usage/);
    expect(() => script.parseArgs(["devbox", "on", "--telegram-chat", "123"])).toThrow(/unknown argument/);
    expect(script.parseArgs(["devbox", "on", "--config", "-", "--dry-run"])).toMatchObject({
      machine: "devbox",
      config: "-",
      dryRun: true,
    });
    expect(script.secretName("devbox")).toBe("SLACK_WORKSPACE_DEVBOX");
  });

  it("on: decrypts from sops, checks tables, puts the secret on stdin, then pages the bindings to Slack", async () => {
    let page = 0;
    const f = fakeDeps({
      rehome: (b) => {
        if (b.dryRun) return { status: 200, body: { workspace: true, pending: 0, results: [], next: null } };
        page++;
        if (page === 1) return { status: 409, body: { error: "no_workspace" } };
        if (page === 2) return { status: 200, body: { workspace: true, pending: 1, results: [moved("gse_a", "stallwatch:a")], next: "gse_a" } };
        return { status: 200, body: { workspace: true, pending: 0, results: [moved("gse_b", "stallwatch:b")], next: null } };
      },
    });
    const code = await script.flip(base(["devbox", "on"]), f.deps);
    expect(code).toBe(0);

    // The age key travels by env, the workspace key name by argv, the config only on stdin.
    const sops = f.calls.find((c) => c.cmd === "nix")!;
    expect(sops.args).toContain('["pigeon_slack_workspace_devbox"]');
    expect(sops.env?.SOPS_AGE_KEY).toBe("AGE-SECRET-KEY-1FAKE");
    const put = f.calls.find((c) => c.args[1] === "secret")!;
    expect(put.args).toEqual(["wrangler", "secret", "put", "SLACK_WORKSPACE_DEVBOX"]);
    expect(JSON.parse(put.input!)).toEqual(CFG);
    for (const c of f.calls) for (const s of SECRET_BITS) expect(c.args.join(" ")).not.toContain(s);
    // Tables are checked before the secret goes in.
    expect(f.calls.findIndex((c) => c.args[1] === "d1")).toBeLessThan(f.calls.indexOf(put));

    expect(f.posts.filter((p) => !p.dryRun).map((p) => p.after ?? null)).toEqual([null, null, "gse_a"]);
    expect(f.posts.every((p) => p.machine === "devbox" && !("expect" in p))).toBe(true);
    // Nothing secret is ever logged.
    for (const line of f.log) for (const s of SECRET_BITS) expect(line).not.toContain(s);
    expect(f.log.at(-1)).toMatch(/devbox is on slack: 2 binding\(s\) moved, 0 not, 0 still pending/);
  });

  it("on: refuses before touching the secret when D1 lacks the Slack tables", async () => {
    const f = fakeDeps({ tables: ["named_topic_bindings"], rehome: () => ({ status: 500, body: null }) });
    await expect(script.flip(base(["devbox", "on", "--config", "-"]), f.deps)).rejects.toThrow(/missing slack_conversations, slack_posts/);
    expect(f.calls.some((c) => c.args[1] === "secret")).toBe(false);
    expect(f.posts).toHaveLength(0);
  });

  it("on: a bad config is refused without printing it", async () => {
    const f = fakeDeps({ rehome: () => ({ status: 500, body: null }), config: JSON.stringify({ ...CFG, botToken: "nope-secret" }) });
    const err = await script.flip(base(["devbox", "on"]), f.deps).catch((e: Error) => e);
    expect(String(err)).toMatch(/botToken/);
    expect(String(err)).not.toContain("nope-secret");
    expect(f.calls.some((c) => c.args[1] === "secret")).toBe(false);
  });

  it("on --dry-run previews and changes nothing", async () => {
    const f = fakeDeps({
      rehome: (b) => {
        expect(b.dryRun).toBe(true);
        return { status: 200, body: { workspace: false, pending: 1, results: [{ sessionId: "gse_a", key: "stallwatch:a", outcome: "pending" }], next: null } };
      },
    });
    expect(await script.flip(base(["devbox", "on", "--config", "-", "--dry-run"]), f.deps)).toBe(0);
    expect(f.calls.some((c) => c.args[1] === "secret")).toBe(false);
    expect(f.log.join("\n")).toMatch(/would put SLACK_WORKSPACE_DEVBOX.*does not yet see a workspace for devbox; 1 binding/);
  });

  it("honours a Slack backoff and gives up waiting for propagation after the timeout", async () => {
    let n = 0;
    const f = fakeDeps({
      rehome: (b) => {
        if (b.dryRun) return { status: 200, body: { workspace: true, pending: 0, results: [], next: null } };
        n++;
        if (n === 1) return { status: 200, body: { workspace: true, pending: 1, results: [], next: null, retryAfter: 30 } };
        return { status: 200, body: { workspace: true, pending: 0, results: [moved("gse_a", "stallwatch:a")], next: null } };
      },
    });
    expect(await script.flip(base(["devbox", "on", "--config", "-"]), f.deps)).toBe(0);
    expect(f.sleeps).toContain(30_000);

    const stuck = fakeDeps({ rehome: () => ({ status: 409, body: { error: "no_workspace" } }) });
    await expect(script.flip(base(["devbox", "on", "--config", "-"]), stuck.deps)).rejects.toThrow(/still sees no workspace for devbox/);
  });

  it("exits 1 when a binding is left behind", async () => {
    const f = fakeDeps({
      rehome: (b) =>
        b.dryRun
          ? { status: 200, body: { workspace: true, pending: 1, results: [], next: null } }
          : { status: 200, body: { workspace: true, pending: 1, results: [{ sessionId: "gse_a", key: "stallwatch:a", outcome: "failed", reason: "create_failed" }], next: null } },
    });
    expect(await script.flip(base(["devbox", "on", "--config", "-"]), f.deps)).toBe(1);
    expect(f.log.join("\n")).toMatch(/Re-run to retry/);
  });

  it("sweeps again after the settle wait when a binding moved back", async () => {
    let previews = 0;
    let sweeps = 0;
    const f = fakeDeps({
      rehome: (b) => {
        if (b.dryRun) {
          previews++;
          // After the settle wait a stale-isolate re-bind has moved one back; the re-sweep fixes it.
          return { status: 200, body: { workspace: true, pending: previews === 1 ? 1 : 0, results: [], next: null } };
        }
        sweeps++;
        return { status: 200, body: { workspace: true, pending: 0, results: [moved("gse_a", "stallwatch:a")], next: null } };
      },
    });
    expect(await script.flip(base(["devbox", "on", "--config", "-"]), f.deps)).toBe(0);
    expect(f.sleeps).toContain(script.SETTLE_MS);
    expect(sweeps).toBe(2);
    expect(f.log.at(-1)).toMatch(/1 binding\(s\) moved, 0 not, 0 still pending/);
  });

  it("the propagation timeout counts only consecutive 409s, not time spent in Slack backoffs", async () => {
    let n = 0;
    const f = fakeDeps({
      rehome: (b) => {
        if (b.dryRun) return { status: 200, body: { workspace: true, pending: 0, results: [], next: null } };
        n++;
        // Five long Slack backoffs, then one stale-isolate 409, then done.
        if (n <= 5) return { status: 200, body: { workspace: true, pending: 1, results: [], next: null, retryAfter: 60 } };
        if (n === 6) return { status: 409, body: { error: "no_workspace" } };
        return { status: 200, body: { workspace: true, pending: 0, results: [moved("gse_a", "stallwatch:a")], next: null } };
      },
    });
    expect(await script.flip(base(["devbox", "on", "--config", "-"]), f.deps)).toBe(0);
  });
});

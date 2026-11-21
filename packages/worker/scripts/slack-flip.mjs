#!/usr/bin/env node
/**
 * Put one machine on its Slack workspace (bead pigeon-4ogz.6). Spec:
 * docs/plans/2026-11-20-slack-transport-design.md §3; runbook docs/runbooks/slack-workspace-setup.md
 * "At the flip". Slack is the only transport (pigeon-4ogz.13): there is no direction to choose and
 * no way back to Telegram.
 *
 *   node packages/worker/scripts/slack-flip.mjs <machine> on [--dry-run] [--config <file>|-]
 *
 *   check the D1 Slack tables exist, put the worker secret SLACK_WORKSPACE_<MACHINE>, then move
 *   every named-topic binding of that machine's sessions (the stall-watch coordinators) into the
 *   workspace, creating each coordinator's channel now (POST /topics/named/rehome). Also the way to
 *   move a machine to a different workspace.
 *
 * Idempotent: re-run one that stopped part-way. The worker has nothing to move a binding to until
 * it sees the secret, so a run that starts before the secret change has reached the worker just
 * waits (up to two minutes).
 *
 * Runs on devbox for every machine, because all three workspace configs live in devbox's sops
 * (workstation secrets/devbox.yaml, key pigeon_slack_workspace_<machine>). The config is
 * decrypted with the devbox age key (sudo) unless --config gives a 0600 file or "-" (stdin).
 * It goes to wrangler on stdin, never argv, and is never printed: only its ids are.
 *
 * Options: --sops-file <path> (default ~/projects/workstation/secrets/devbox.yaml),
 * --worker-url <url>, --key-file <path> (this machine's worker key, default
 * /run/secrets/pigeon_worker_key; any machine's key may rehome any machine).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MACHINE_ID_PATTERN } from "./machine-key.mjs";
import { DEFAULT_BASE_URL, checkConfig } from "./slack-manifest.mjs";

export const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const D1_DATABASE = "pigeon-router";
export const DEFAULT_SOPS_FILE = join(homedir(), "projects/workstation/secrets/devbox.yaml");
export const DEFAULT_KEY_FILE = "/run/secrets/pigeon_worker_key";
export const AGE_KEY_FILE = "/persist/sops-age-key.txt";
/** How long to wait for a secret change to reach the worker before giving up. */
export const PROPAGATION_TIMEOUT_MS = 120_000;
export const PROPAGATION_POLL_MS = 5_000;
/**
 * After the first pass, wait this long and sweep again. Isolates can disagree about a secret for
 * minutes, and a daemon re-bind that lands on one still seeing the old transport moves a binding
 * back. The second sweep catches it (and a later re-bind on an up-to-date isolate would too).
 */
export const SETTLE_MS = 120_000;
/** Pause between pages, on top of any Slack backoff the worker reports. */
export const PAGE_PAUSE_MS = 1_000;
/** Pages after which the loop gives up (a cursor that never advances would otherwise spin). */
export const MAX_PAGES = 200;

export const secretName = (machine) => `SLACK_WORKSPACE_${machine.toUpperCase().replace(/-/g, "_")}`;
export const sopsKey = (machine) => `pigeon_slack_workspace_${machine}`;

export const USAGE =
  "usage: slack-flip.mjs <machine> on [--dry-run] [--config <file>|-] " +
  "[--sops-file <path>] [--worker-url <url>] [--key-file <path>]";

export function parseArgs(argv) {
  const [machine, direction, ...rest] = argv;
  if (!machine || !MACHINE_ID_PATTERN.test(machine)) throw new Error(USAGE);
  if (direction !== "on") throw new Error(USAGE);
  const opts = {
    machine,
    dryRun: false,
    config: null,
    sopsFile: DEFAULT_SOPS_FILE,
    workerUrl: DEFAULT_BASE_URL,
    keyFile: DEFAULT_KEY_FILE,
  };
  const valued = { "--config": "config", "--sops-file": "sopsFile", "--worker-url": "workerUrl", "--key-file": "keyFile" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a in valued) {
      const v = rest[++i];
      if (v === undefined || (v.startsWith("--") && v !== "-")) throw new Error(`${a} needs a value`);
      opts[valued[a]] = v;
    } else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  return opts;
}

/** Real side effects, replaced in tests. `run` never uses a shell. */
export const realDeps = {
  run(cmd, args, { input, cwd, env } = {}) {
    const r = spawnSync(cmd, args, {
      input,
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
  },
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  readFile: (path) => readFileSync(path, "utf8"),
  fileMode: (path) => statSync(path).mode,
  readStdin: () => readFileSync(0, "utf8"),
  log: (line) => console.log(line),
};

/** The last line of a failed command's stderr: enough to act on, never a whole log. */
const lastLine = (s) => String(s).trim().split("\n").filter(Boolean).pop() ?? "";

function parseConfig(text, source) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    // JSON.parse's message can quote its input, which is a token.
    throw new Error(`${source} is not valid JSON`);
  }
  const problems = checkConfig(cfg);
  if (problems.length) throw new Error(`${source}:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  return cfg;
}

/** The workspace config for `machine`, as a validated object. Never printed. */
export function loadConfig(opts, deps) {
  if (opts.config === "-") return parseConfig(deps.readStdin().trim(), "stdin");
  if (opts.config !== null) {
    if ((deps.fileMode(opts.config) & 0o077) !== 0) throw new Error(`${opts.config} is readable by other users: chmod 0600 it first`);
    return parseConfig(deps.readFile(opts.config).trim(), opts.config);
  }
  const age = deps.run("sudo", ["-n", "cat", AGE_KEY_FILE]);
  if (age.status !== 0) throw new Error(`cannot read the devbox age key (${AGE_KEY_FILE}) with sudo -n: ${lastLine(age.stderr)}`);
  const dec = deps.run(
    "nix",
    ["shell", "nixpkgs#sops", "-c", "sops", "-d", "--extract", `["${sopsKey(opts.machine)}"]`, opts.sopsFile],
    { env: { SOPS_AGE_KEY: age.stdout.trim() } },
  );
  if (dec.status !== 0) throw new Error(`sops could not decrypt ${sopsKey(opts.machine)} from ${opts.sopsFile}: ${lastLine(dec.stderr)}`);
  return parseConfig(dec.stdout.trim(), `${opts.sopsFile} ${sopsKey(opts.machine)}`);
}

/** The worker serves Slack only once these tables exist (AGENTS.md: apply the schema first). */
export function checkSlackTables(deps) {
  const r = deps.run(
    "npx",
    [
      "wrangler", "d1", "execute", D1_DATABASE, "--remote", "--json", "--command",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('slack_conversations', 'slack_posts', 'named_topic_bindings')",
    ],
    { cwd: WORKER_DIR },
  );
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${lastLine(r.stderr)}`);
  let names = [];
  try {
    names = JSON.parse(r.stdout).flatMap((x) => (x.results ?? []).map((row) => row.name));
  } catch {
    throw new Error("could not read wrangler d1 execute --json output");
  }
  const missing = ["slack_conversations", "slack_posts", "named_topic_bindings"].filter((t) => !names.includes(t));
  if (missing.length) {
    throw new Error(`D1 is missing ${missing.join(", ")}: apply packages/worker/src/d1-schema.sql before any Slack secret`);
  }
}

function putSecret(machine, cfg, deps) {
  const r = deps.run("npx", ["wrangler", "secret", "put", secretName(machine)], {
    cwd: WORKER_DIR,
    input: JSON.stringify(cfg),
  });
  if (r.status !== 0) throw new Error(`wrangler secret put ${secretName(machine)} failed: ${lastLine(r.stderr)}`);
}

async function callRehome(opts, deps, body) {
  const key = deps.readFile(opts.keyFile).trim();
  const res = await deps.fetch(`${opts.workerUrl.replace(/\/+$/, "")}/topics/named/rehome`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ machine: opts.machine, ...body }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // reported below
  }
  return { status: res.status, body: json };
}

/**
 * Page through the rehome route until every binding has been tried once. Returns the results.
 * 409 no_workspace = the secret change has not reached the worker yet: wait and retry.
 */
export async function rehomeAll(opts, deps) {
  let waitingSince = null; // start of the current run of 409s, so Slack backoffs do not count
  const results = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRehome(opts, deps, after ? { after } : {});
    if (r.status === 409 && r.body?.error === "no_workspace") {
      waitingSince ??= deps.now();
      if (deps.now() - waitingSince > PROPAGATION_TIMEOUT_MS) {
        throw new Error(
          `the worker still sees no workspace for ${opts.machine} after ${PROPAGATION_TIMEOUT_MS / 1000}s; ` +
            "check the secret (npx wrangler secret list) and re-run",
        );
      }
      deps.log("  worker does not see the workspace yet; waiting for the secret change to propagate");
      await deps.sleep(PROPAGATION_POLL_MS);
      page--; // not a page
      continue;
    }
    waitingSince = null;
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.results)) {
      throw new Error(`POST /topics/named/rehome answered ${r.status}: ${JSON.stringify(r.body?.error ?? r.body)}`);
    }
    for (const x of r.body.results) {
      results.push(x);
      const where = x.chatId ? ` -> ${x.chatId} #${x.messageThreadId}${x.created ? " (created)" : ""}` : "";
      deps.log(`  ${x.outcome.padEnd(8)} ${x.key}  ${x.sessionId}${where}${x.reason ? `  (${x.reason})` : ""}`);
    }
    if (r.body.retryAfter !== undefined) {
      deps.log(`  Slack rate limit: waiting ${r.body.retryAfter}s`);
      await deps.sleep(r.body.retryAfter * 1000);
    }
    if (r.body.next === null && r.body.retryAfter === undefined) return results;
    after = r.body.next;
    await deps.sleep(PAGE_PAUSE_MS);
  }
  throw new Error(`gave up after ${MAX_PAGES} pages; re-run (it is idempotent)`);
}

async function preview(opts, deps) {
  const r = await callRehome(opts, deps, { dryRun: true });
  if (r.status !== 200 || !r.body) throw new Error(`dry-run rehome answered ${r.status}: ${JSON.stringify(r.body?.error ?? r.body)}`);
  return r.body;
}

/** Runs the flip. Returns the process exit code: 0 ok, 1 something left for a human. */
export async function flip(opts, deps = realDeps) {
  const { machine } = opts;

  const cfg = loadConfig(opts, deps);
  deps.log(`${machine}: workspace team ${cfg.teamId}, app ${cfg.appId}, https://${cfg.domain}.slack.com, owner ${cfg.ownerUserId}`);
  checkSlackTables(deps);
  if (opts.dryRun) {
    const p = await preview(opts, deps);
    deps.log(
      `dry run: would put ${secretName(machine)}; worker ${p.workspace ? "already sees" : "does not yet see"} a workspace for ${machine}; ` +
        `${p.pending} binding(s) would move to Slack:`,
    );
    for (const x of p.results) deps.log(`  ${x.key}  ${x.sessionId}`);
    return 0;
  }
  putSecret(machine, cfg, deps);
  deps.log(`put ${secretName(machine)}`);

  deps.log(`moving ${machine}'s named-topic bindings to Slack:`);
  const results = await rehomeAll(opts, deps);
  deps.log(`waiting ${SETTLE_MS / 1000}s for every worker isolate to see the change, then checking again`);
  await deps.sleep(SETTLE_MS);
  if ((await preview(opts, deps)).pending > 0) {
    deps.log("some bindings moved back or were left; sweeping again:");
    const again = await rehomeAll(opts, deps);
    // The second sweep's outcome supersedes the first's for the same binding.
    for (const x of again) {
      const i = results.findIndex((y) => y.sessionId === x.sessionId);
      if (i >= 0) results[i] = x;
      else results.push(x);
    }
  }
  const left = (await preview(opts, deps)).pending;
  const bad = results.filter((x) => x.outcome !== "moved");
  deps.log(
    `${machine} is on slack: ${results.length - bad.length} binding(s) moved, ${bad.length} not, ${left} still pending.`,
  );
  if (bad.length || left) {
    deps.log(
      "Re-run to retry (it is idempotent); a binding left behind posts its coordinator's messages to #alerts.",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  flip(opts).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`slack-flip: ${err.message}`);
      process.exit(1);
    },
  );
}

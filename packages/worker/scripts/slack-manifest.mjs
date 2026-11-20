#!/usr/bin/env node
/**
 * Render the Slack app manifest for one machine's workspace, and check a staged workspace
 * config before it goes into sops (pigeon-4ogz.2). Runbook: docs/runbooks/slack-workspace-setup.md.
 * Spec: docs/plans/2026-11-20-slack-transport-design.md §2.
 *
 *   node packages/worker/scripts/slack-manifest.mjs render <machine> [--base-url <url>]
 *       Prints the manifest for workspace "pigeon <machine>" as JSON on stdout. All three
 *       request URLs are <base-url>/slack/<machine>/{events,interactivity,commands}.
 *   node packages/worker/scripts/slack-manifest.mjs check-config <file>
 *       Checks the shape of a worker config file (what becomes SLACK_WORKSPACE_<MACHINE>):
 *       exactly {teamId, appId, domain, botToken, userToken, signingSecret, ownerUserId}.
 *       Refuses a file other users can read. Prints the non-secret ids only.
 *   <value on stdin> | node packages/worker/scripts/slack-manifest.mjs stage-field <file> <field>
 *       Merges one field into the staging config <file> (created 0600, outside any git work
 *       tree), or with field alarmWebhookUrl writes the #alerts webhook URL as <file>. Takes the
 *       value on stdin so a browser driver can pipe it in without the value ever reaching argv,
 *       stdout or the agent's transcript; prints only a prefix and length for secrets.
 *
 * Neither command talks to Slack, and NEITHER EVER PRINTS A TOKEN OR THE SIGNING SECRET:
 * problems name the field, never its value.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MACHINE_ID_PATTERN } from "./machine-key.mjs";

export const DEFAULT_BASE_URL = "https://ccr-router.jonathan-mohrbacher.workers.dev";
export const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../slack/manifest.template.json");

/** The worker config's fields, each with its shape. Secret fields are never printed. */
export const CONFIG_FIELDS = {
  teamId: { pattern: /^T[A-Z0-9]{6,}$/, secret: false, hint: "a team id, T…" },
  appId: { pattern: /^A[A-Z0-9]{6,}$/, secret: false, hint: "an app id, A…" },
  domain: {
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
    secret: false,
    hint: "the workspace subdomain only (pigeon-devbox, not pigeon-devbox.slack.com)",
  },
  botToken: { pattern: /^xoxb-[A-Za-z0-9-]+$/, secret: true, hint: "a bot token, xoxb-…" },
  userToken: { pattern: /^xoxp-[A-Za-z0-9-]+$/, secret: true, hint: "a user token, xoxp-…" },
  signingSecret: { pattern: /^[0-9a-f]{32}$/, secret: true, hint: "32 hex characters" },
  ownerUserId: { pattern: /^U[A-Z0-9]{6,}$/, secret: false, hint: "a user id, U…" },
};

function checkBaseUrl(baseUrl) {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`bad base URL (not a URL): ${baseUrl}`);
  }
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
    throw new Error(`bad base URL (want https://<host> with no path or query): ${baseUrl}`);
  }
  return u.origin;
}

/** Fill every string in the parsed template, so no value can break out of its JSON string. */
function fill(node, vars) {
  if (typeof node === "string") {
    return node.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => {
      if (!(name in vars)) throw new Error(`template has an unknown placeholder ${whole}`);
      return vars[name];
    });
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, vars));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  }
  return node;
}

export function render(machineId, baseUrl = DEFAULT_BASE_URL, templatePath = TEMPLATE_PATH) {
  if (typeof machineId !== "string" || !MACHINE_ID_PATTERN.test(machineId)) {
    throw new Error(`bad machine id: ${JSON.stringify(machineId)} (as in CCR_MACHINE_ID)`);
  }
  const base = checkBaseUrl(baseUrl);
  const manifest = fill(JSON.parse(readFileSync(templatePath, "utf8")), { MACHINE: machineId, BASE_URL: base });
  const name = manifest.display_information?.name ?? "";
  if (name.length > 35) throw new Error(`app name over Slack's 35 characters: ${name}`);
  return manifest;
}

/** Returns a list of problems (empty = good). Never includes a field's value. */
export function checkConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return ["config must be a JSON object"];
  const problems = [];
  for (const key of Object.keys(cfg)) {
    if (!(key in CONFIG_FIELDS)) {
      problems.push(
        `unknown field "${key}" (the worker config holds only ${Object.keys(CONFIG_FIELDS).join(", ")}; ` +
          "the #alerts webhook URL belongs in the machine's own secrets)",
      );
    }
  }
  for (const [key, spec] of Object.entries(CONFIG_FIELDS)) {
    const v = cfg[key];
    if (v === undefined) {
      problems.push(`missing field "${key}" (${spec.hint})`);
    } else if (typeof v !== "string") {
      problems.push(`field "${key}" must be a string (${spec.hint})`);
    } else if (/^xox[cd]-/.test(v)) {
      problems.push(
        `field "${key}" holds a Slack client token (xoxc/xoxd). Those must never be stored: ` +
          "discard it and use the app's own token from OAuth & Permissions",
      );
    } else if (!spec.pattern.test(v)) {
      problems.push(`field "${key}" is not ${spec.hint}`);
    }
  }
  return problems;
}

/** Pseudo-field for stage-field: the #alerts incoming-webhook URL, kept in its own file. */
export const WEBHOOK_FIELD = "alarmWebhookUrl";
const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+$/;

function insideGitWorkTree(dir) {
  try {
    return (
      execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true"
    );
  } catch {
    return false;
  }
}

function describe(field, value) {
  const spec = CONFIG_FIELDS[field];
  if (spec && !spec.secret) return value;
  // Only the fixed, non-secret part of the shape: "xoxb-", the webhook host, nothing of the rest.
  const prefix =
    field === WEBHOOK_FIELD ? "https://hooks.slack.com/…" : /^xox[bp]-/.test(value) ? `${value.slice(0, 5)}…` : "…";
  return `${prefix}, ${value.length} chars`;
}

/**
 * Write one value into a staging file without it ever being printed: a config field is merged
 * into the JSON object in <file>; alarmWebhookUrl makes <file> a one-line file of its own. The
 * file is created 0600 and must stay 0600, outside any git work tree. Returns what may be shown.
 */
export function stageField(file, field, value) {
  if (field !== WEBHOOK_FIELD && !(field in CONFIG_FIELDS)) {
    throw new Error(`unknown field "${field}" (want one of ${Object.keys(CONFIG_FIELDS).join(", ")}, ${WEBHOOK_FIELD})`);
  }
  if (field === WEBHOOK_FIELD) {
    if (!WEBHOOK_PATTERN.test(value)) throw new Error(`value is not an incoming-webhook URL (https://hooks.slack.com/services/…)`);
  } else {
    const problems = checkConfig({ ...placeholderConfig(), [field]: value });
    if (problems.length) throw new Error(problems.join("\n"));
  }
  const abs = resolve(file);
  if (insideGitWorkTree(dirname(abs))) throw new Error(`refusing to write inside a git work tree: ${abs}`);
  let cfg = {};
  if (existsSync(abs)) {
    if ((statSync(abs).mode & 0o077) !== 0) throw new Error(`${abs} is readable by other users: chmod 0600 it first`);
    if (field !== WEBHOOK_FIELD) {
      try {
        cfg = JSON.parse(readFileSync(abs, "utf8"));
      } catch {
        throw new Error(`${abs} is not valid JSON`);
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${abs} is not a JSON object`);
    }
  }
  const body = field === WEBHOOK_FIELD ? value + "\n" : JSON.stringify({ ...cfg, [field]: value }, null, 2) + "\n";
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  renameSync(tmp, abs);
  return { shown: describe(field, value) };
}

function placeholderConfig() {
  return {
    teamId: "T0000000",
    appId: "A0000000",
    domain: "x",
    botToken: "xoxb-0",
    userToken: "xoxp-0",
    signingSecret: "0".repeat(32),
    ownerUserId: "U0000000",
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "render") {
    const machineId = rest[0];
    if (!machineId) throw new Error("usage: render <machine> [--base-url <url>]");
    const i = rest.indexOf("--base-url");
    const baseUrl = i >= 0 ? rest[i + 1] : DEFAULT_BASE_URL;
    if (i >= 0 && !baseUrl) throw new Error("--base-url needs a value");
    process.stdout.write(JSON.stringify(render(machineId, baseUrl), null, 2) + "\n");
    return;
  }
  if (cmd === "check-config") {
    const file = rest[0];
    if (!file) throw new Error("usage: check-config <file>");
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by other users: chmod 0600 it first`);
    }
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // JSON.parse's message can quote the input, which here is a token.
      throw new Error(`${file} is not valid JSON`);
    }
    const problems = checkConfig(cfg);
    if (problems.length) throw new Error(problems.map((p) => `- ${p}`).join("\n"));
    console.log(
      `ok: team ${cfg.teamId}, app ${cfg.appId}, https://${cfg.domain}.slack.com, owner ${cfg.ownerUserId}. ` +
        "Tokens and signing secret have the right shape (not printed, not tested against Slack).",
    );
    return;
  }
  if (cmd === "stage-field") {
    const [file, field] = rest;
    if (!file || !field) throw new Error("usage: stage-field <file> <field>   (value on stdin)");
    const value = readFileSync(0, "utf8").trim();
    const { shown } = stageField(file, field, value);
    console.log(`staged ${field} in ${file}: ${shown}`);
    return;
  }
  throw new Error(
    "usage: slack-manifest.mjs render <machine> [--base-url <url>] | check-config <file> | stage-field <file> <field>",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

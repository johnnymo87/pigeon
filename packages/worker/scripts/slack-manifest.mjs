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
 *
 * Neither command talks to Slack, and NEITHER EVER PRINTS A TOKEN OR THE SIGNING SECRET:
 * problems name the field, never its value.
 */
import { readFileSync, statSync } from "node:fs";
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
  throw new Error("usage: slack-manifest.mjs render <machine> [--base-url <url>] | check-config <file>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

#!/usr/bin/env node
/**
 * Mint and hash per-machine worker credentials (pigeon-k0qn.8). Runbook:
 * docs/runbooks/per-machine-credentials.md.
 *
 *   node packages/worker/scripts/machine-key.mjs mint <machine> --out <file>
 *       Writes a new key to <file> (must not exist, mode 0600, outside any git work tree)
 *       and prints its SHA-256 and the wrangler command that registers it.
 *   node packages/worker/scripts/machine-key.mjs hash <file>
 *       Prints the SHA-256 of the key in <file>, e.g. to find its row before revoking it.
 *
 * NEITHER COMMAND EVER PRINTS A KEY. Run `mint` on the machine whose secret store will hold
 * the key (or where you run `sops` for it), so only the hash travels.
 *
 * The two patterns below must match packages/worker/src/credentials.ts; the daemon test
 * test/machine-key-script.test.ts checks that they do.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MACHINE_KEY_PATTERN = /^pgk_[A-Za-z0-9_-]{43}$/;
export const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function newKey() {
  return "pgk_" + randomBytes(32).toString("base64url");
}

export function sha256Hex(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function registerCommand(hash, machineId, now, note) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("bad hash");
  if (!MACHINE_ID_PATTERN.test(machineId)) throw new Error(`bad machine id: ${machineId}`);
  const safeNote = note.replace(/[^A-Za-z0-9 :._-]/g, "");
  const sql =
    "INSERT INTO machine_credentials (key_sha256, machine_id, created_at, note) " +
    `VALUES ('${hash}', '${machineId}', ${Math.trunc(now)}, '${safeNote}')`;
  return `npx wrangler d1 execute pigeon-router --remote --command "${sql}"`;
}

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

export function mint(machineId, outPath, { now = Date.now(), host = hostname() } = {}) {
  if (!MACHINE_ID_PATTERN.test(machineId)) {
    throw new Error(`machine id must match ${MACHINE_ID_PATTERN}: ${machineId}`);
  }
  const out = resolve(outPath);
  if (insideGitWorkTree(dirname(out))) {
    throw new Error(`refusing to write a key inside a git work tree: ${out}`);
  }
  const key = newKey();
  // "wx": fail if the file exists, so a re-run can never overwrite a key that is in use.
  const fd = openSync(out, "wx", 0o600);
  try {
    writeSync(fd, key + "\n");
  } finally {
    closeSync(fd);
  }
  const hash = sha256Hex(key);
  const note = `minted ${new Date(now).toISOString()} on ${host}`;
  return { path: out, hash, command: registerCommand(hash, machineId, now, note) };
}

export function hashFile(path) {
  const key = readFileSync(path, "utf8").trim();
  if (!MACHINE_KEY_PATTERN.test(key)) throw new Error(`not a pigeon machine key: ${path}`);
  return sha256Hex(key);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "mint") {
    const machineId = rest[0];
    const outIdx = rest.indexOf("--out");
    const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;
    if (!machineId || !outPath) throw new Error("usage: mint <machine> --out <file>");
    const r = mint(machineId, outPath);
    console.log(`key written to ${r.path} (mode 0600). It is not printed here.`);
    console.log(`sha256: ${r.hash}`);
    console.log("register it (run from packages/worker; --remote is required):");
    console.log(`  ${r.command}`);
    console.log("delete the file once the key is in sops or the Keychain.");
    return;
  }
  if (cmd === "hash") {
    if (!rest[0]) throw new Error("usage: hash <file>");
    console.log(hashFile(rest[0]));
    return;
  }
  throw new Error("usage: machine-key.mjs mint <machine> --out <file> | hash <file>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * End-to-end check of the li6 fix against a LIVE goose serve, at TOOL level.
 *
 * The client's own post-create check verifies EXTENSIONS, which is the right
 * granularity for the client but not the thing the bead is actually about --
 * the hazard is the `delegate` TOOL reaching a model. Extensions and tools are
 * different instruments, and conflating them is the mistake this bead already
 * recorded once (a missing scheduler TOOL was read as a missing scheduler
 * EXTENSION; the extension was loaded the whole time).
 *
 * So this runs a real turn through the real client and then reads the tool list
 * goose actually sent to the model, from ~/.local/state/goose/logs/llm_request.*.
 * That log is ground truth: it is what the provider received.
 *
 * Needs GOOSE_ACP_URL and PIGEON_GOOSE_ACP_TOKEN. Costs one cheap turn.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GooseAcpClient } from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";

const LOG_DIR = join(homedir(), ".local/state/goose/logs");
const BANNED = ["delegate", "extensionmanager", "scheduler", "summon"];

/**
 * Unions the tools across EVERY log written since the turn started, rather than
 * reading the newest one.
 *
 * Learned the hard way, and the reason this function is shaped like this: a
 * turn writes MORE THAN ONE llm_request. goose also makes a separate
 * session-naming call, on a different small model, with no tools at all. That
 * call finishes last, so "newest file" selected a log containing zero tools and
 * the check reported "banned capabilities: NONE" -- a pass that would have been
 * produced just as happily by a completely unfixed session. The union cannot be
 * fooled that way, and the zero-tools guard in the caller catches the remaining
 * case where the parse finds nothing at all.
 */
function toolsInLogsSince(since: number): { files: string[]; tools: string[] } | null {
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("llm_request."))
    .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
    .filter((x) => x.m >= since)
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) return null;
  const names = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if ((k === "tools" || k === "functionDeclarations") && Array.isArray(v)) {
          for (const t of v) {
            const n = (t as any)?.name ?? (t as any)?.function?.name;
            if (typeof n === "string") names.add(n);
          }
        }
        walk(v);
      }
    }
  };
  for (const { f } of files) {
    for (const line of readFileSync(join(LOG_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { walk(JSON.parse(line)); } catch { /* partial line */ }
    }
  }
  return { files: files.map((x) => x.f), tools: [...names].sort() };
}

const started = Date.now();
const client = new GooseAcpClient({
  url: process.env.GOOSE_ACP_URL!,
  transportFactory: webSocketTransport(process.env.PIGEON_GOOSE_ACP_TOKEN),
  permissionPolicy: () => "allow_always",
  log: () => {},
});

await client.connect();
const sid = await client.newSession("/tmp/opencode");
console.log(`session/new accepted and VERIFIED by the client: ${sid}`);

await client.prompt(sid, "Reply with exactly the word OK. Do not call any tools.");
client.close();

// The log is written as the request goes out, but give the flush a moment.
await new Promise((r) => setTimeout(r, 1500));

const found = toolsInLogsSince(started);
if (!found) {
  console.error("INCONCLUSIVE: no llm_request log written since the turn started");
  process.exit(1);
}
console.log(`\nlogs read: ${found.files.join(", ")}`);
console.log(`tool list actually sent to the model: ${found.tools.length}`);
for (const t of found.tools) console.log(`   ${t}`);

// An empty tool list is NOT a pass. Every goose session has at least the
// floor's tools, so finding none means this probe failed to read the right
// thing -- and "no banned tools found" would then be true of a parse failure
// exactly as it is true of a contained session. Refusing to conclude is the
// only honest outcome.
if (found.tools.length === 0) {
  console.error("\nINCONCLUSIVE: found 0 tools, which cannot be right -- the floor alone ships several.");
  console.error("This probe did not read what it thinks it read; it is NOT evidence of containment.");
  process.exit(1);
}

const leaked = found.tools.filter((t) => BANNED.some((b) => t.toLowerCase().includes(b)));
console.log(`\nbanned capabilities present: ${leaked.length ? leaked.join(", ") : "NONE"}`);
process.exit(leaked.length === 0 ? 0 : 1);

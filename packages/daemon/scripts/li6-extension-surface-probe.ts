/**
 * li6: does `_meta.enabledExtensions` actually narrow a goose session, and is
 * `_meta.extensionResults` trustworthy enough to VERIFY that it did?
 *
 * Deliberately raw JSON-RPC over the socket rather than GooseAcpClient: the
 * thing under test is the wire contract, and routing it through the abstraction
 * that is about to change would make the probe a claim about pigeon rather than
 * about goose.
 *
 * Runs three session/new calls against the LIVE serve and prints, for each, the
 * full `_meta` of the response:
 *
 *   A. no `_meta`               -- today's behaviour, expected to take goose's
 *                                  fall-back-to-host-config branch (the bug)
 *   B. `enabledExtensions: []`  -- proposed default; expected floor only
 *   C. `enabledExtensions: [analyze]` -- expected floor + analyze, proving the
 *                                  field is genuinely additive and not ignored
 *
 * C is the control that stops B from being a false pass: if goose ignored the
 * field entirely, A and B would differ for some unrelated reason and B alone
 * could not tell us. C must differ from B in exactly one name.
 *
 * Read-only apart from creating sessions (no prompt is ever sent, so no turn
 * runs and no model is billed).
 */
import { WebSocket } from "ws";

const URL_ = process.env.GOOSE_ACP_URL!;
const TOKEN = process.env.PIGEON_GOOSE_ACP_TOKEN!;
const CWD = "/tmp/opencode";

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`${URL_}?token=${encodeURIComponent(TOKEN)}`);
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

function rpc(ws: WebSocket, id: number, method: string, params: unknown): Promise<any> {
  return new Promise((res, rej) => {
    const onMsg = (raw: Buffer) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== id) return;              // ignore notifications and other ids
      ws.off("message", onMsg);
      if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
      else res(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function newSession(label: string, meta: Record<string, unknown> | undefined) {
  const ws = await connect();
  try {
    await rpc(ws, 1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const params: Record<string, unknown> = { cwd: CWD, mcpServers: [] };
    if (meta) params._meta = meta;
    const result = await rpc(ws, 2, "session/new", params);

    const rmeta = result?._meta ?? {};
    const results = rmeta.extensionResults;
    console.log(`\n=== ${label} ===`);
    console.log(`  params._meta      : ${meta ? JSON.stringify(meta) : "(absent)"}`);
    console.log(`  sessionId         : ${result?.sessionId}`);
    console.log(`  _meta keys        : ${Object.keys(rmeta).join(", ") || "(none)"}`);
    if (Array.isArray(results)) {
      const names = results.map((r: any) => `${r.name}${r.success === false ? "!FAILED" : ""}`).sort();
      console.log(`  extensionResults  : ${results.length} -> ${names.join(", ")}`);
    } else {
      console.log(`  extensionResults  : ABSENT (cannot verify from the response)`);
      console.log(`  raw _meta         : ${JSON.stringify(rmeta).slice(0, 400)}`);
    }
    return Array.isArray(results) ? results.map((r: any) => r.name).sort() : null;
  } finally {
    ws.close();
  }
}

const a = await newSession("A. no _meta (today's behaviour = the bug)", undefined);
const b = await newSession("B. enabledExtensions: [] (proposed default)", { enabledExtensions: [] });
const c = await newSession("C. enabledExtensions: [analyze] (additivity control)", {
  enabledExtensions: [{ type: "platform", name: "analyze" }],
});

console.log("\n=== VERDICT ===");
if (!a || !b || !c) {
  console.log("  extensionResults missing somewhere -> the planned runtime check CANNOT be built on it.");
} else {
  const only = (x: string[], y: string[]) => x.filter((n) => !y.includes(n));
  console.log(`  A only (dropped by the fix): ${only(a, b).join(", ") || "(none)"}`);
  console.log(`  B (floor)                  : ${b.join(", ") || "(empty)"}`);
  console.log(`  C minus B (proves additive): ${only(c, b).join(", ") || "(NONE -- field may be ignored!)"}`);
  console.log(`  B minus A                  : ${only(b, a).join(", ") || "(none)"}`);
}
process.exit(0);

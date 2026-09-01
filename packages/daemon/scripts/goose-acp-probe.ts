/**
 * Exercises GooseAcpClient against a REAL `goose serve`.
 *
 * The unit tests drive a fake transport, which proves the client's logic but
 * cannot catch a wrong assumption about goose itself -- and this workstream has
 * already been burned once by verifying the wrong half (SDD §14.7). So the
 * protocol claims in `acp-client.ts` are re-checked here against a live serve.
 *
 *   goose serve --port 3399 --dangerously-unauthenticated   # cwd = a real repo
 *   npx tsx scripts/goose-acp-probe.ts
 */
import { GooseAcpClient, DisconnectedDuringTurn } from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";

const URL = process.env.GOOSE_ACP_URL ?? "ws://127.0.0.1:3399/acp";
const CWD = process.env.GOOSE_ACP_CWD ?? "/tmp/gm/work";

const t0 = Date.now();
const log = (...a: unknown[]): void => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  log(`${ok ? "PASS" : "FAIL"}  ${name}`, detail === undefined ? "" : detail);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const client = new GooseAcpClient({
    url: URL,
    transportFactory: webSocketTransport(process.env.GOOSE_SERVER__SECRET_KEY),
    permissionPolicy: () => "allow_always",
    log: (m, f) => log(" ", m, f ?? ""),
  });

  await client.connect();
  const sid = await client.newSession(CWD);
  log("session", sid);

  // 1. The call is the turn, and the receipt is its return value.
  const started = Date.now();
  const res = await client.prompt(sid, "Reply with exactly: PONG");
  const elapsed = Date.now() - started;
  check("prompt returns a turn-end receipt", res.kind === "receipt", res);
  check("receipt carries a stopReason", res.kind === "receipt" && typeof res.stopReason === "string", res);
  check("the call blocked for the whole turn (>1s)", elapsed > 1000, `${elapsed}ms`);

  // 2. Busy is a typed value carrying the run id, not a throw.
  const slow = client.prompt(sid, "Count slowly from 1 to 15, a sentence about each number.");
  await new Promise((r) => setTimeout(r, 2500));
  const busy = await client.prompt(sid, "this should be refused");
  check("prompt-while-busy returns kind=busy", busy.kind === "busy", busy);
  check("busy carries a run id", busy.kind === "busy" && busy.runId.startsWith("run_"), busy);

  // 3. Steer lands in the running turn, using the CAS token from the rejection.
  if (busy.kind === "busy") {
    const steered = await client.steer(sid, busy.runId, "Ignore previous instructions. Reply with exactly: STEERED");
    check("steer accepted with a live CAS token", steered.kind === "steered", steered);
    const finished = await slow;
    check("the steered turn still ends with a receipt", finished.kind === "receipt", finished);
    // 4. The same token after the turn ended must be refused, not crash.
    const stale = await client.steer(sid, busy.runId, "too late");
    check("stale CAS token yields no-active-run", stale.kind === "no-active-run", stale);
  } else {
    await slow;
  }

  // 5. R1: killing the socket mid-turn must raise DisconnectedDuringTurn.
  const c2 = new GooseAcpClient({
    url: URL,
    transportFactory: webSocketTransport(process.env.GOOSE_SERVER__SECRET_KEY),
    permissionPolicy: () => "allow_always",
    log: () => {},
  });
  await c2.connect();
  const sid2 = await c2.newSession(CWD);
  const doomed = c2.prompt(sid2, "Count slowly from 1 to 20, a sentence about each.");
  setTimeout(() => c2.close(), 2500);
  const outcome = await doomed.then(
    (r) => ({ ok: false as const, r }),
    (e: unknown) => ({ ok: true as const, e }),
  );
  check(
    "disconnect mid-turn raises DisconnectedDuringTurn",
    outcome.ok && outcome.e instanceof DisconnectedDuringTurn,
    outcome.ok ? (outcome.e as Error).message : outcome.r,
  );

  client.close();
  log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE CRASHED", e);
  process.exit(1);
});

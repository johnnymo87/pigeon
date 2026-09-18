/**
 * Exercises the goose ADAPTER AND RUNNER against a REAL `goose serve`.
 *
 * Why this exists, separately from goose-acp-probe.ts: the unit tests drive a
 * fake ACP client, which proves the lifecycle logic and is blind to every
 * assumption about goose itself. That blindness has already cost this workstream
 * a merged bug -- the preflight was verified entirely against `http://` urls and
 * mocked `fetch`, so nothing in two layers of green evidence touched the `ws://`
 * url that real code passes, and `fetch` cannot speak `ws:`.
 *
 * So the claims this probe checks are the ones a mock CANNOT check:
 *   1. the real ws transport, with real `?token=` auth, reaches a real serve
 *   2. delivery RETURNS while the turn is still running (the 60s-lease property)
 *   3. real `session/update` frames produce the transcript we report
 *   4. the run id really does arrive via `session_info_update`, enabling steer
 *   5. a second message mid-turn really steers instead of being rejected as busy
 *   6. a bad token is classified as auth-failed, not as a dead server
 *
 *   GOOSE_SERVER__SECRET_KEY=k goose serve --port 38910     # cwd = a real dir
 *   PIGEON_GOOSE_PROBE_TOKEN=k npx tsx scripts/goose-runner-probe.ts
 */
import { GooseAcpClient } from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import { GooseSessionRunner } from "../src/goose/session-runner.js";
import { GooseAcpAdapter } from "../src/goose/adapter.js";
import { classifyReachability } from "../src/goose/preflight.js";
import type { SessionRecord } from "../src/storage/types.js";

const URL_ = process.env.GOOSE_ACP_URL ?? "ws://127.0.0.1:38910/acp";
const TOKEN = process.env.PIGEON_GOOSE_PROBE_TOKEN ?? "";
const CWD = process.env.GOOSE_ACP_CWD ?? "/tmp/gm/ad";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main(): Promise<void> {
  // --- 0. the preflight, over the NATURAL ws:// url (the bug that got through).
  console.log("0. preflight against the ws:// url a caller actually has");
  const good = await classifyReachability(URL_, TOKEN);
  check("correct token classifies as ok", good.kind === "ok", good.kind);
  const bad = await classifyReachability(URL_, "definitely-not-the-token");
  check("wrong token classifies as auth-failed", bad.kind === "auth-failed", bad.kind);
  const dead = await classifyReachability("ws://127.0.0.1:38999/acp", TOKEN);
  check("dead port classifies as unreachable", dead.kind === "unreachable", dead.kind);

  // --- 1. a real session over the real transport.
  console.log("\n1. open a real ACP session over the real websocket");
  const stops: Array<Record<string, unknown>> = [];
  let runner: GooseSessionRunner | undefined;
  const client = new GooseAcpClient({
    url: URL_,
    transportFactory: webSocketTransport(TOKEN),
    permissionPolicy: (p) => p.options[0]?.optionId,
    log: () => {},
    onSessionUpdate: (_sid, update) => runner?.onUpdate(update),
  });
  await client.connect();
  const gooseSessionId = await client.newSession(CWD);
  check("session/new returned an id", typeof gooseSessionId === "string", gooseSessionId);

  const session = {
    sessionId: gooseSessionId,
    cwd: CWD,
    notify: true,
    backendKind: "goose-acp",
    backendEndpoint: URL_,
    backendAuthToken: TOKEN,
  } as unknown as SessionRecord;

  runner = new GooseSessionRunner({
    session,
    client,
    postStop: async (body) => {
      stops.push(body);
    },
    touch: () => {},
    log: (m, f) => console.log(`      [runner] ${m}`, f ?? ""),
  });

  const adapter = new GooseAcpAdapter({ runnerFor: () => runner! });

  // --- 2. THE lease property: delivery returns while the turn runs.
  console.log("\n2. deliver a slow turn and check we return before it finishes");
  const t0 = Date.now();
  const res = await adapter.deliverCommand(
    session,
    "Count from 1 to 15, one line each, with a short sentence about each number.",
    { commandId: "probe-1" },
  );
  const returnedAfter = Date.now() - t0;
  check("delivery reported ok", res.ok === true, JSON.stringify(res.meta));
  check(
    "delivery returned while the turn was still running",
    runner.isBusy() && stops.length === 0,
    `busy=${runner.isBusy()} stops=${stops.length}`,
  );
  check(
    `returned fast (${returnedAfter}ms), well inside the 60s worker lease`,
    returnedAfter < 15_000,
    `${returnedAfter}ms`,
  );

  // --- 3. the run id arrives from notifications, without a busy rejection.
  await new Promise((r) => setTimeout(r, 2500));
  const runId = client.activeRunId(gooseSessionId);
  check("learned the active run id from session_info_update", typeof runId === "string", String(runId));

  // --- 4. a second message mid-turn steers rather than being rejected.
  if (runner.isBusy()) {
    const steered = await adapter.deliverCommand(session, "Also mention the number's parity.", {
      commandId: "probe-2",
    });
    check(
      "a second message mid-turn steered the live turn",
      steered.ok === true && steered.meta?.mode === "steered",
      JSON.stringify(steered.meta),
    );
  } else {
    check("turn was still running to steer into", false, "turn finished too fast to test steering");
  }

  // --- 5. the turn completes and reports a real transcript.
  console.log("\n3. wait for the turn to finish and inspect what we would report");
  await runner.settled();
  check("exactly one /stop was reported", stops.length === 1, `got ${stops.length}`);
  const stop = stops[0] ?? {};
  check("reported as a Stop, not an Error", stop.event === "Stop", String(stop.event));
  const message = String(stop.message ?? "");
  check("transcript is non-empty real model output", message.length > 20, `${message.length} chars`);
  check(
    "notification id matches the /stop route's required shape",
    String(stop.notification_id).startsWith(`s:${gooseSessionId}:`)
      && /^[A-Za-z0-9_:.-]+$/.test(String(stop.notification_id)),
    String(stop.notification_id),
  );
  check("runner is no longer busy", runner.isBusy() === false);
  console.log(`\n      transcript head: ${JSON.stringify(message.slice(0, 160))}`);

  // --- 6. a wrong token must be a permanent refusal, never a throw.
  console.log("\n4. a wrong token is a permanent refusal, not a retryable throw");
  const badAdapter = new GooseAcpAdapter({ runnerFor: () => runner! });
  const badSession = { ...session, backendAuthToken: "definitely-not-the-token" } as SessionRecord;
  let threw = false;
  let outcome: { ok?: boolean; error?: string } = {};
  try {
    outcome = await badAdapter.deliverCommand(badSession, "hello", { commandId: "probe-3" });
  } catch (err) {
    threw = true;
    outcome = { error: err instanceof Error ? err.message : String(err) };
  }
  check("did not throw (a throw would retry a bad token every 60s)", threw === false);
  check("returned ok:false", outcome.ok === false, String(outcome.error).slice(0, 80));

  // --- 7. a REAL socket drop must be survivable, not a permanent wedge.
  // This is the one a fake transport cannot honestly test: a closed WebSocket's
  // send() does not throw, so the bug it guards against is silent by nature.
  console.log("\n5. survive a real socket drop (reconnect, not wedge)");
  client.close();
  check("client reports itself closed", client.isClosed() === true);
  const afterDrop = await adapter.deliverCommand(session, "Say exactly: recovered.", {
    commandId: "probe-4",
  });
  check("delivery after a real drop succeeded", afterDrop.ok === true, JSON.stringify(afterDrop.meta ?? afterDrop.error));
  await runner.settled();
  const recovered = stops[stops.length - 1] ?? {};
  check(
    "the reconnected turn reported a real transcript",
    stops.length === 2 && String(recovered.message ?? "").length > 0,
    `stops=${stops.length} msg=${JSON.stringify(String(recovered.message ?? "").slice(0, 60))}`,
  );

  // --- 8. the idle watchdog, against a REAL turn on a REAL socket.
  //
  // A genuinely half-open socket needs packet-dropping and root, so what is
  // driven here is the half that is reachable: the watchdog fires against a real
  // in-flight goose turn, reports, and unwedges the runner -- and the real turn
  // then lands as a SECOND notification rather than being swallowed. That last
  // part is the one that matters, because it is what a false positive costs.
  console.log("\n6. the liveness probe tells a quiet turn from a dead socket");
  // This is the check the first version of this section got WRONG, and the
  // reason it is worth having: with a 1.5s idle timeout and no liveness probe,
  // the watchdog abandoned a perfectly healthy turn, closed the socket, and the
  // real answer never arrived at all -- a total loss that every unit test missed
  // because their fake client's close() was a no-op. Silence is not evidence.
  const stalls: Array<Record<string, unknown>> = [];
  const impatient = new GooseSessionRunner({
    session,
    client,
    postStop: async (body) => { stalls.push(body); },
    touch: () => {},
    log: () => {},
    // Aggressively short: goose takes seconds to answer even a trivial prompt,
    // so this expires repeatedly INSIDE a live run. Nothing may be abandoned.
    turnIdleTimeoutMs: 1_000,
  });
  const quietStart = Date.now();
  await impatient.deliver("probe-5", "Count slowly to twenty, one number per line, with a sentence about each.");
  await impatient.settled();
  const elapsed = Date.now() - quietStart;

  check(
    "a healthy turn survived repeated idle expiries",
    stalls.length === 1 && stalls[0]?.event === "Stop",
    `stalls=${stalls.length} events=${stalls.map((s) => s.event).join(",")}`,
  );
  check(
    "and it was the real answer, not a stall notice",
    !String(stalls[0]?.notification_id ?? "").endsWith(":stalled")
      && String(stalls[0]?.message ?? "").length > 50,
    `id=${stalls[0]?.notification_id} len=${String(stalls[0]?.message ?? "").length}`,
  );
  check("the turn actually ran long enough to expire the timer", elapsed > 2_000, `${elapsed}ms`);
  check("the runner ended clean", impatient.isBusy() === false);

  // The other half -- a socket that dies mid-turn -- and an honest note about
  // which half of it is reachable from here.
  //
  // A GRACEFUL close (this one) fires onClose, which rejects the pending turn
  // and reports it immediately: that path predates the watchdog and is what the
  // checks below pin. A genuinely HALF-OPEN socket emits no close event at all,
  // and producing one requires dropping packets with iptables as root, so it is
  // not driven here -- it is covered by unit tests whose liveness probe hangs.
  // The distinction matters: if this section ever starts reporting a STALL
  // rather than a failure, something has broken in onClose.
  console.log("\n7. a socket that dies mid-turn is reported, not left hanging");
  const deadStalls: Array<Record<string, unknown>> = [];
  const onDead = new GooseSessionRunner({
    session,
    client,
    postStop: async (body) => { deadStalls.push(body); },
    touch: () => {},
    log: () => {},
    turnIdleTimeoutMs: 1_000,
  });
  await onDead.deliver("probe-6", "Count slowly to forty with a sentence about each.");
  // Kill the transport underneath the runner without settling its turn: the
  // pending prompt stays outstanding and the liveness probe can never answer.
  await new Promise((r) => setTimeout(r, 1_000));
  client.close();
  await new Promise((r) => setTimeout(r, 15_000));

  check(
    "the lost turn was reported to the human",
    deadStalls.length === 1,
    `n=${deadStalls.length}`,
  );
  check(
    "as a turn failure via onClose, NOT as a watchdog stall",
    String(deadStalls[0]?.error_kind) === "goose-turn-failed",
    String(deadStalls[0]?.error_kind),
  );
  check(
    "naming the disconnect so the human knows the prompt may be orphaned",
    String(deadStalls[0]?.message ?? "").includes("connection closed"),
    String(deadStalls[0]?.message ?? "").slice(0, 90),
  );
  check("and the runner is no longer wedged", onDead.isBusy() === false);

  client.close();
  console.log(failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} LIVE CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});

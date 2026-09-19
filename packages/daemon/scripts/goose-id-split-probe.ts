/**
 * Exercises the PIGEON-ID / GOOSE-ID SPLIT against a REAL `goose serve`.
 *
 * Why this exists separately from goose-runner-probe.ts: that probe gives the
 * runner a session whose `sessionId` is the one goose minted, so it cannot see
 * the distinction this change introduces. Here pigeon's id and goose's id are
 * deliberately DIFFERENT, which is what every session launched through
 * `/launch --backend goose` will look like.
 *
 * The unit tests pin the split against a FAKE client that records which id it
 * was called with. That fake is a claim about goose, and this is where the claim
 * is checked. Two things in particular cannot be checked anywhere else:
 *
 *   - `index.ts` routes inbound `session/update` frames by GOOSE's id
 *     (`peekByBackendId`). That wiring has no unit test -- the file has none at
 *     all -- and getting it wrong is SILENT: the turn runs to completion and the
 *     human simply sees nothing.
 *   - that goose genuinely does not know pigeon's id. If goose happened to
 *     accept anything, the whole split would be unnecessary and this probe
 *     would say so.
 *
 * The claims:
 *   1. a session minted on a THROWAWAY connection is promptable from the
 *      runner's own, later, independent connection (the launch path's shape)
 *   2. inbound update frames for goose's id reach the runner registered under
 *      pigeon's id, through the same registry wiring index.ts uses
 *   3. the reported transcript is non-empty -- i.e. updates actually arrived,
 *      rather than the turn merely ending
 *   4. NEGATIVE CONTROL: prompting goose with PIGEON's id fails. This is what
 *      makes claims 1-3 meaningful rather than vacuous.
 *
 *   GOOSE_SERVER__SECRET_KEY=k goose serve --port 38910     # cwd = a real dir
 *   PIGEON_GOOSE_PROBE_TOKEN=k npx tsx scripts/goose-id-split-probe.ts
 */
import { GooseAcpClient } from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import { GooseSessionRunner, GooseRunnerRegistry } from "../src/goose/session-runner.js";
import type { SessionRecord } from "../src/storage/types.js";

const URL_ = process.env.GOOSE_ACP_URL ?? "ws://127.0.0.1:38910/acp";
const TOKEN = process.env.PIGEON_GOOSE_PROBE_TOKEN ?? "";
const CWD = process.env.GOOSE_ACP_CWD ?? "/tmp";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

function sessionRecord(over: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: "gse_probe", ppid: null, pid: null, startTime: null, cwd: CWD,
    label: null, title: null, lastHumanMsgId: null, notify: true, state: "idle",
    ptyPath: null, nvimSocket: null, backendKind: "goose-acp",
    backendProtocolVersion: 1, backendEndpoint: URL_, backendAuthToken: TOKEN,
    backendSessionId: null, createdAt: 0, updatedAt: 0, lastSeen: 0, expiresAt: 0,
    ...over,
  } as SessionRecord;
}

async function main(): Promise<void> {
  // --- 1. Mint on a throwaway connection, exactly as the launch path will.
  const minter = new GooseAcpClient({
    url: URL_,
    transportFactory: webSocketTransport(TOKEN),
    log: () => {},
  });
  await minter.connect();
  const gooseId = await minter.newSession(CWD);
  console.log(`  minted on throwaway connection: gooseId=${gooseId}`);
  minter.close();

  check("goose mints a per-machine, non-global id", /^\d{8}_\d+$/.test(gooseId), gooseId);

  const pigeonId = `gse_probe_${Date.now()}`;
  check("pigeon's id differs from goose's", pigeonId !== gooseId, `${pigeonId} != ${gooseId}`);

  // --- 2. The registry + runner wiring, built the way index.ts builds it.
  const stops: Array<Record<string, unknown>> = [];
  let registry: GooseRunnerRegistry | undefined;
  registry = new GooseRunnerRegistry({
    createRunner: (session) =>
      new GooseSessionRunner({
        session,
        client: new GooseAcpClient({
          url: URL_,
          transportFactory: webSocketTransport(TOKEN),
          permissionPolicy: (params) => params.options[0]?.optionId,
          log: () => {},
          // THE LINE UNDER TEST, mirroring index.ts: frames arrive keyed by
          // GOOSE's id and must be routed by it, not by pigeon's.
          onSessionUpdate: (incomingId, update) =>
            registry?.peekByBackendId(incomingId)?.onUpdate(update),
        }),
        postStop: async (body) => { stops.push(body); },
        touch: () => {},
        log: () => {},
      }),
  });

  const record = sessionRecord({ sessionId: pigeonId, backendSessionId: gooseId });
  const runner = registry.get(record);

  check("registry indexes the runner under goose's id", registry.peekByBackendId(gooseId) === runner);
  check("registry does NOT index it under pigeon's id", registry.peekByBackendId(pigeonId) === undefined);

  // --- 3. Drive a real turn across the two different ids.
  await runner.deliver("probe-cmd-1", "Reply with exactly: SPLITOK");
  await runner.settled();

  const stop = stops[0];
  check("the turn was reported at all", stop !== undefined);
  if (stop) {
    check(
      "reported under PIGEON's id (what the worker looks up)",
      stop.session_id === pigeonId,
      String(stop.session_id),
    );
    const message = String(stop.message ?? "");
    // Claim 3, and the assertion here has to be the CONTENT, not merely a
    // non-empty string. A turn whose updates were routed nowhere still ends and
    // still reports -- with the runner's "goose finished the turn with no
    // message" placeholder, which is non-empty. An earlier version of this
    // probe checked only for emptiness and PASSED when the routing was
    // deliberately mutated to the wrong lookup: the placeholder satisfied it.
    // The model was asked for a specific token precisely so this can tell a
    // delivered transcript from a manufactured one.
    check(
      "the model's actual words arrived, so update frames really were routed",
      message.includes("SPLITOK"),
      JSON.stringify(message.slice(0, 80)),
    );
  }
  registry.closeAll();

  // --- 4. Negative control: does goose actually reject pigeon's id?
  const control = new GooseAcpClient({
    url: URL_, transportFactory: webSocketTransport(TOKEN), log: () => {},
  });
  await control.connect();
  let rejected = false;
  let detail = "";
  try {
    await Promise.race([
      control.prompt(pigeonId, "this should not be accepted"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 30_000)),
    ]);
  } catch (err) {
    rejected = true;
    detail = err instanceof Error ? err.message.slice(0, 90) : String(err);
  }
  control.close();
  check("goose REJECTS pigeon's id, so the split is load-bearing", rejected, detail);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});

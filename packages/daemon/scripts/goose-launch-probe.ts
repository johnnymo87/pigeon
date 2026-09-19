/**
 * Exercises `/launch --backend goose` END TO END against a REAL `goose serve`.
 *
 * The unit tests fake BOTH ends of this path -- the minting client and the
 * runner -- so between them they assert only that the module calls the fakes in
 * the right order. Every claim about goose itself is untested there, and the
 * two that matter cannot be checked any other way:
 *
 *   - a session minted on a THROWAWAY connection can then be driven by the
 *     runner's own, separate connection. If goose scoped sessions to the
 *     connection that created them, this whole design would be wrong and every
 *     unit test would still pass.
 *   - the first turn's output actually comes BACK -- through the real registry,
 *     the real ACP client, and the real update routing -- rather than the turn
 *     merely ending.
 *
 * Runs the real ingestGooseLaunchCommand with real clients against real goose,
 * faking only Telegram (there is nobody to message) and the worker registration
 * (there is no worker here).
 *
 *   GOOSE_SERVER__SECRET_KEY=k goose serve --port 38910     # cwd = a real dir
 *   PIGEON_GOOSE_PROBE_TOKEN=k npx tsx scripts/goose-launch-probe.ts
 */
import { ingestGooseLaunchCommand } from "../src/goose/launch-ingest.js";
import { GooseAcpClient } from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import { GooseSessionRunner, GooseRunnerRegistry } from "../src/goose/session-runner.js";
import { openStorageDb } from "../src/storage/database.js";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind.js";

const URL_ = process.env.GOOSE_ACP_URL ?? "ws://127.0.0.1:38910/acp";
const TOKEN = process.env.PIGEON_GOOSE_PROBE_TOKEN ?? "";
const CWD = process.env.GOOSE_ACP_CWD ?? "/tmp";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main(): Promise<void> {
  const storage = openStorageDb(":memory:");
  const replies: string[] = [];
  const registered: string[] = [];
  const stops: Array<Record<string, unknown>> = [];

  let registry: GooseRunnerRegistry | undefined;
  registry = new GooseRunnerRegistry({
    createRunner: (session) =>
      new GooseSessionRunner({
        session,
        client: new GooseAcpClient({
          url: session.backendEndpoint ?? URL_,
          transportFactory: webSocketTransport(session.backendAuthToken ?? TOKEN),
          permissionPolicy: (params) => params.options[0]?.optionId,
          log: () => {},
          onSessionUpdate: (backendId, update) =>
            registry?.peekByBackendId(backendId)?.onUpdate(update),
        }),
        postStop: async (body) => { stops.push(body); },
        touch: () => {},
        log: () => {},
      }),
  });

  await ingestGooseLaunchCommand({
    commandId: "probe-launch-1",
    directory: CWD,
    prompt: "Reply with exactly: LAUNCHOK",
    chatId: "probe-chat",
    machineId: "probe-machine",
    acpUrl: URL_,
    acpToken: TOKEN,
    sessions: storage.sessions,
    runnerFor: (session) => registry!.get(session),
    createMintClient: (url, token) =>
      new GooseAcpClient({ url, transportFactory: webSocketTransport(token), log: () => {} }),
    onSessionStart: async (sessionId) => { registered.push(sessionId); },
    sendTelegramReply: async (_c, text) => { replies.push(text); },
  });

  const rows = storage.sessions.list({}).filter((s) => s.backendKind === GOOSE_BACKEND_KIND);
  check("exactly one goose session row was created", rows.length === 1, `got ${rows.length}`);
  const row = rows[0];
  if (!row) { console.log("\nno session row; aborting"); process.exit(1); }

  check("pigeon minted its own id", row.sessionId.startsWith("gse_"), row.sessionId);
  check(
    "goose's own id was stored, and differs",
    typeof row.backendSessionId === "string" && row.backendSessionId !== row.sessionId,
    String(row.backendSessionId),
  );
  check("the session was announced under pigeon's id", registered[0] === row.sessionId);
  check("the human was told", replies.length >= 1 && replies[0]!.includes(row.sessionId));

  // The decisive one: the runner's SEPARATE connection drove a session minted
  // on a throwaway connection, and the model's words came back through the real
  // update routing. A mis-wired path still ends the turn -- it just reports the
  // "no message" placeholder -- so this asserts the CONTENT, not mere presence.
  await registry.get(row).settled();
  const transcript = String(stops[0]?.message ?? "");
  check("the first turn ran and its output came back", transcript.includes("LAUNCHOK"), JSON.stringify(transcript.slice(0, 90)));
  check("the turn reported under pigeon's id", stops[0]?.session_id === row.sessionId, String(stops[0]?.session_id));

  registry.closeAll();
  storage.db.close();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});

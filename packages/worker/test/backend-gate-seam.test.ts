/**
 * The worker/daemon wire, driven from BOTH real ends.
 *
 * WHY THIS FILE EXISTS. `LaunchMessage` crosses the worker boundary as a
 * hand-built JSON body with no shared schema and no validation, and until now
 * each side was tested only against its own BELIEF about the other: the
 * daemon's poller tests fake `fetchFn` (`packages/daemon/test/poller.test.ts`),
 * and the worker's tests hand-build a `Request` and call `handlePollNext`
 * directly (`worker.test.ts`). Two independent fakes, neither touching the real
 * wire -- so the capability header could be spelled one way in the daemon and
 * another in the worker and BOTH suites would stay green while the gate
 * silently never matched. A gate that never matches is indistinguishable from a
 * gate that always passes.
 *
 * So these tests use the REAL `Poller` from the daemon package, its real header
 * construction, and route its real outgoing fetch through `SELF.fetch` into the
 * real worker router -- which exercises routing and auth too, rather than
 * calling the handler directly.
 *
 * WHAT IT STILL DOES NOT COVER, named so nobody mistakes it for covered:
 * node undici's actual header serialization over TCP, workerd's parsing of real
 * bytes, and any normalisation the Cloudflare edge performs. The `none`
 * sentinel exists precisely so the last of those cannot matter, and the first
 * two want a `wrangler dev` script rather than vitest.
 */
import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
// The REAL schema, not a copy of it. `worker.test.ts` inlines its own
// transcription; that is a second source of truth which can drift from
// production without failing anything, so this file reads the shipped file.
import d1Schema from "../src/d1-schema.sql?raw";
import { Poller } from "../../daemon/src/worker/poller";
import type { PollerCallbacks } from "../../daemon/src/worker/poller";
import { advertisedBackends, BACKENDS_HEADER as DAEMON_BACKENDS_HEADER } from "../../daemon/src/worker/backends";
import { BACKENDS_HEADER as WORKER_BACKENDS_HEADER } from "../src/poll";

const MACHINE = "seam-machine";
const CHAT_ID = "8248645256";
const WORKER_URL = "https://example.com";

/** `poll()` touches no callback; a launch is never dispatched here. */
const NO_CALLBACKS = {} as unknown as PollerCallbacks;

function makePoller(backends: string | undefined) {
  return new Poller(
    {
      workerUrl: WORKER_URL,
      apiKey: "test-api-key",
      machineId: MACHINE,
      ...(backends === undefined ? {} : { backends }),
    },
    NO_CALLBACKS,
    // Nearly not our own code: the poller's real Request goes straight into the
    // real router. The only thing this shim does is hand over the arguments.
    { fetchFn: ((url: string, init?: RequestInit) => SELF.fetch(url, init)) as unknown as typeof fetch },
  );
}

/**
 * `createdAt` is explicit because `pollNextCommand` orders by it: seeding a
 * burst with a bare `Date.now()` ties every row and leaves the order to
 * whatever the index happens to return, which would make the drain test pass or
 * fail for reasons unrelated to draining.
 */
let seedClock = Date.now();
async function seedLaunch(commandId: string, metadataJson: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO commands (command_id, machine_id, session_id, command_type, command,
                           chat_id, directory, metadata_json, status, created_at)
     VALUES (?, ?, NULL, 'launch', 'do the thing', ?, '/home/dev/projects/pigeon', ?, 'pending', ?)`,
  )
    .bind(commandId, MACHINE, CHAT_ID, metadataJson, seedClock++)
    .run();
}

async function statusOf(commandId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM commands WHERE command_id = ?")
    .bind(commandId)
    .first<{ status: string }>();
  return row?.status;
}

/**
 * Captures the refusal text so we can assert the human is told what to DO.
 *
 * Recording happens in the REPLY callback, never in a `body` matcher: undici
 * may evaluate a matcher predicate more than once while deciding whether a
 * request matches, so a side effect there double-counts. And `.persist()` is
 * required because an interceptor otherwise answers exactly one request, which
 * makes the second send of a burst fail as an unmatched request -- surfacing as
 * a 500 from the worker rather than as anything resembling its cause.
 */
function interceptTelegram(sent: string[], reply: { code: number; body: unknown }) {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/sendMessage/ })
    .reply(reply.code, (opts: { body?: unknown }) => {
      try {
        sent.push((JSON.parse(String(opts.body)) as { text: string }).text);
      } catch {
        sent.push(String(opts.body));
      }
      return JSON.stringify(reply.body);
    }, { headers: { "Content-Type": "application/json" } })
    .persist();
}

describe("backend capability gate, across the real wire", () => {
  beforeAll(async () => {
    // Storage is shared across files (isolatedStorage: false), so this may or
    // may not already exist depending on file order; every statement is
    // IF NOT EXISTS.
    for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM commands WHERE machine_id = ?").bind(MACHINE).run();
  });

  afterEach(() => {
    try {
      fetchMock.get("https://api.telegram.org").cleanMocks();
    } catch {
      /* no interceptor was registered */
    }
  });

  it("refuses a goose launch to a daemon advertising only opencode, and tells the human", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 200, body: { ok: true, result: { message_id: 1 } } });
    await seedLaunch("cmd-refuse", JSON.stringify({ backend: "goose" }));

    const poller = makePoller(advertisedBackends({ opencode: true, goose: false }));
    const msg = await poller.poll();

    // The daemon must never be handed a command it cannot serve.
    expect(msg).toBeNull();
    // ...and the command must be consumed, not left to retry for 24h.
    expect(await statusOf("cmd-refuse")).toBe("acked");
    // ...and the human must hear about it, with something actionable.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Cannot launch goose");
    expect(sent[0]).toContain("does not have the goose backend configured");
    expect(sent[0]).toContain("nothing was started");
  });

  it("delivers a goose launch to a daemon that advertises goose", async () => {
    await seedLaunch("cmd-allow", JSON.stringify({ backend: "goose" }));

    const poller = makePoller(advertisedBackends({ opencode: true, goose: true }));
    const msg = await poller.poll();

    expect(msg).not.toBeNull();
    expect(msg).toMatchObject({ commandType: "launch", backend: "goose" });
  });

  /**
   * THE ACTUAL SKEW CASE, and the one the imports above cannot reach: this test
   * can only construct TODAY's Poller, never the one deployed five days ago.
   * But the legacy request is fully knowable -- before this PR the poller sent
   * exactly one header, `Authorization`, and nothing else (poller.ts at
   * c2a8b3c, the sha deployed on 2026-09-18). So it is built by hand here.
   */
  it("refuses a goose launch to a pre-gate daemon, which sends no header at all", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 200, body: { ok: true, result: { message_id: 1 } } });
    await seedLaunch("cmd-legacy", JSON.stringify({ backend: "goose" }));

    const res = await SELF.fetch(`${WORKER_URL}/machines/${MACHINE}/next`, {
      headers: { Authorization: "Bearer test-api-key" },
    });

    expect(res.status).toBe(204);
    expect(await statusOf("cmd-legacy")).toBe("acked");
    expect(sent[0]).toContain("predates backend selection");
  });

  it("serves an ordinary launch to a pre-gate daemon, unchanged", async () => {
    await seedLaunch("cmd-plain", null);

    const res = await SELF.fetch(`${WORKER_URL}/machines/${MACHINE}/next`, {
      headers: { Authorization: "Bearer test-api-key" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.commandType).toBe("launch");
    // The wire shape of an untagged, un-backended launch must be byte-identical
    // to what it was before the gate existed, or every deployed daemon is a
    // skew case.
    expect("backend" in body).toBe(false);
  });

  /**
   * A daemon with neither backend configured. Its header is non-empty by
   * construction (the `none` sentinel), so this cannot be confused with the
   * legacy case above -- which is the entire reason the sentinel exists.
   */
  it("refuses even an ordinary launch when the daemon advertises nothing", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 200, body: { ok: true, result: { message_id: 1 } } });
    await seedLaunch("cmd-none", null);

    const poller = makePoller(advertisedBackends({ opencode: false, goose: false }));
    expect(await poller.poll()).toBeNull();
    expect(await statusOf("cmd-none")).toBe("acked");
    // Not the legacy wording: the daemon spoke, it just had nothing to offer.
    expect(sent[0]).toContain("does not have the opencode backend configured");
  });

  /**
   * A refusal that could not be delivered must NOT be acked. Acking an
   * undelivered refusal destroys the command silently, which is the exact
   * failure this gate was built to eliminate -- so a transient Telegram failure
   * has to leave the row leased for the ordinary 60s-lease retry.
   */
  it("leaves the command leased when the refusal cannot be delivered", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } } });
    await seedLaunch("cmd-transient", JSON.stringify({ backend: "goose" }));

    const poller = makePoller(advertisedBackends({ opencode: true, goose: false }));
    expect(await poller.poll()).toBeNull();
    expect(await statusOf("cmd-transient")).toBe("leased");
  });

  /**
   * ...but a PERMANENT failure must ack anyway. A deleted topic will not start
   * existing, and holding the row buys 24h of retries nobody can see.
   */
  it("acks the command when the refusal fails permanently", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 200, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } });
    await seedLaunch("cmd-permanent", JSON.stringify({ backend: "goose" }));

    const poller = makePoller(advertisedBackends({ opencode: true, goose: false }));
    expect(await poller.poll()).toBeNull();
    expect(await statusOf("cmd-permanent")).toBe("acked");
  });

  /**
   * Head-of-line blocking: the daemon sleeps ~5s between polls and
   * `pollNextCommand` is LIMIT 1, so without draining several refusals per poll
   * a burst of unservable launches would hold up the ordinary command queued
   * behind them for N*5s.
   */
  it("drains several refusals in one poll so real work is not held up", async () => {
    const sent: string[] = [];
    interceptTelegram(sent, { code: 200, body: { ok: true, result: { message_id: 1 } } });
    for (let i = 0; i < 3; i++) {
      await seedLaunch(`cmd-burst-${i}`, JSON.stringify({ backend: "goose" }));
    }
    await seedLaunch("cmd-burst-real", null);

    const poller = makePoller(advertisedBackends({ opencode: true, goose: false }));
    const msg = await poller.poll();

    // The ordinary launch behind the burst is served in the SAME poll.
    expect(msg).toMatchObject({ commandId: "cmd-burst-real", commandType: "launch" });
    expect(sent).toHaveLength(3);
  });

  /**
   * The two sides name the same header. This is the ONLY assertion that
   * compares the daemon's constant to the worker's rather than to itself, and
   * without it a rename on one side is caught only indirectly, via the wording
   * of a refusal message.
   */
  it("spells the header identically on both sides of the wire", () => {
    expect(DAEMON_BACKENDS_HEADER).toBe(WORKER_BACKENDS_HEADER);
  });

  /** The header the daemon actually puts on the wire, byte-exact. */
  it("sends the capability header under its pinned name", async () => {
    let seen: string | null = null;
    const poller = new Poller(
      { workerUrl: WORKER_URL, apiKey: "test-api-key", machineId: MACHINE, backends: "opencode,goose" },
      NO_CALLBACKS,
      {
        fetchFn: ((url: string, init?: RequestInit) => {
          // Read back through the WORKER's spelling: this is the side that has
          // to find it.
          seen = new Headers(init?.headers).get(WORKER_BACKENDS_HEADER);
          return SELF.fetch(url, init);
        }) as unknown as typeof fetch,
      },
    );
    await poller.poll();
    expect(seen).toBe("opencode,goose");
  });
});

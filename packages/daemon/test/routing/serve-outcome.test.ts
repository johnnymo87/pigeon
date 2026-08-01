/**
 * Serve outcome classification + shadow-mode sensor (bead pigeon-f2a, the second
 * half of increment 1; the sensor for the verdict that lands in pigeon-886).
 *
 * This file is where the two BINDING rules from
 * docs/plans/2026-07-27-serve-serviceability-design.md 5.1 become executable:
 *
 *   C. TIMEOUTS MUST NEVER COUNT. A CPU-pegged main loop mid-heavy-turn delays
 *      even the cheap prompt_async accept. Counting timeouts marks BUSY serves
 *      unserviceable — the precise false positive behind the June 2026 lease
 *      flapping that killed four in-flight turns. Accept-but-hang is covered by
 *      the systemd canary instead. The split is: hangs -> canary, refused and
 *      fast-5xx -> this verdict.
 *
 *   B. SERVE-DIRECTED HTTP OUTCOMES ONLY. 4xx is not serve ill-health (a
 *      404-session-gone says the session is gone, not that the serve is sick),
 *      and the plugin direct-channel signal is excluded entirely because it
 *      targets an ephemeral port the PLUGIN binds — it reports plugin death, so
 *      counting it would mark the whole pool suspect every morning after the
 *      nightly workspace reset.
 *
 * SHADOW MODE. Nothing here feeds routing. The sensor counts and logs so that
 * increment 2 can pick thresholds from a real base rate instead of a guess —
 * nobody currently knows how many refused/5xx a healthy serve emits per day,
 * because nothing has ever recorded it. Any change that makes this file's output
 * influence placement belongs in pigeon-886, and must respect amendment A
 * (never ANDed into isServeHealthy — placeSession has no live-lease guard, so
 * that path steals live leases and kills in-flight turns).
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyServeOutcome,
  countsTowardVerdict,
  RequestTimeoutError,
  ServeOutcomeSensor,
  TransportError,
} from "../../src/routing/serve-outcome";

/** Shape Node's fetch uses: a TypeError wrapping a cause carrying `code`. */
function transportError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe("classifyServeOutcome", () => {
  it("classifies 2xx as success", () => {
    expect(classifyServeOutcome({ status: 200 })).toBe("success");
    expect(classifyServeOutcome({ status: 204 })).toBe("success");
  });

  it("classifies 5xx as server_error", () => {
    // The signature class this whole arc exists for: a serve that answers fast
    // and wrongly. 500-in-15ms passes every probe we have.
    expect(classifyServeOutcome({ status: 500 })).toBe("server_error");
    expect(classifyServeOutcome({ status: 503 })).toBe("server_error");
  });

  it("classifies connection-refused as refused", () => {
    expect(classifyServeOutcome({ error: transportError("ECONNREFUSED") })).toBe("refused");
  });

  it("classifies a TransportError-WRAPPED connection-refused as refused", () => {
    // Regression guard (W2). OpencodeClient wraps transport throws in
    // TransportError so the swarm arbiter can distinguish "never reached the
    // serve" (don't charge the retry budget) from "the serve answered badly".
    // That wrap buries the TypeError one level down. If transportCode stops
    // unwrapping it, this degrades to `unknown`, which never counts toward the
    // verdict — so a serve with a closed port would silently never be evicted
    // from the routing pool. The bug would be invisible: no test failed when
    // the wrap was first introduced, because every existing case passes the
    // raw error.
    expect(
      classifyServeOutcome({ error: new TransportError(transportError("ECONNREFUSED")) }),
    ).toBe("refused");
  });

  it("classifies a timeout as timeout, NOT as refused or server_error", () => {
    // Rule C. If this ever regresses, busy serves get marked unserviceable and
    // we reproduce the June incident.
    const out = classifyServeOutcome({ error: new RequestTimeoutError(30_000, "http://x/y") });
    expect(out).toBe("timeout");
    expect(out).not.toBe("refused");
    expect(out).not.toBe("server_error");
  });

  it("classifies 4xx as client_error", () => {
    expect(classifyServeOutcome({ status: 404 })).toBe("client_error");
    expect(classifyServeOutcome({ status: 401 })).toBe("client_error");
  });

  it("classifies an unrecognised transport failure as unknown rather than guessing", () => {
    // Conservative on purpose: an unclassified error must not manufacture
    // suspicion. Over-suspicion is the expensive direction here.
    expect(classifyServeOutcome({ error: transportError("ECONNRESET") })).toBe("unknown");
    expect(classifyServeOutcome({ error: new Error("something odd") })).toBe("unknown");
  });
});

describe("countsTowardVerdict", () => {
  it("counts exactly refused and server_error, and nothing else", () => {
    expect(countsTowardVerdict("refused")).toBe(true);
    expect(countsTowardVerdict("server_error")).toBe(true);

    expect(countsTowardVerdict("timeout")).toBe(false);
    expect(countsTowardVerdict("client_error")).toBe(false);
    expect(countsTowardVerdict("success")).toBe(false);
    expect(countsTowardVerdict("unknown")).toBe(false);
  });

  it("keeps timeouts out even though they are transport failures", () => {
    // Stated separately because "transport failure" is the intuitive grouping
    // and it is exactly the wrong one. The draft design made this mistake.
    expect(countsTowardVerdict("timeout")).toBe(false);
  });
});

describe("ServeOutcomeSensor", () => {
  const ATTR = { serveId: "serve-1", instanceUuid: "uuid-a" };

  function sensor(over: Record<string, unknown> = {}) {
    const log = vi.fn();
    const s = new ServeOutcomeSensor({
      resolve: () => ATTR,
      log,
      nowFn: () => 1_000,
      ...over,
    });
    return { s, log };
  }

  it("tallies failures per (serveId, instanceUuid)", () => {
    const { s } = sensor();
    s.record("http://127.0.0.1:4096", { status: 500 });
    s.record("http://127.0.0.1:4096", { status: 500 });
    s.record("http://127.0.0.1:4096", { error: transportError("ECONNREFUSED") });

    const tallies = s.snapshot();
    expect(tallies).toHaveLength(1);
    expect(tallies[0]).toMatchObject({
      serveId: "serve-1",
      instanceUuid: "uuid-a",
      serverError: 2,
      refused: 1,
      counting: 3,
    });
  });

  it("keeps a restarted serve's counters separate from the dead instance's", () => {
    // Amendment D: keying on serve_id alone means a FIXED serve inherits stale
    // suspicion. A fresh instance_uuid is the free "this is a new process"
    // signal already in the registry row.
    let uuid = "uuid-old";
    const { s } = sensor({ resolve: () => ({ serveId: "serve-1", instanceUuid: uuid }) });

    s.record("http://127.0.0.1:4096", { status: 500 });
    uuid = "uuid-new";
    s.record("http://127.0.0.1:4096", { status: 200 });

    const tallies = s.snapshot();
    expect(tallies).toHaveLength(2);
    expect(tallies.find((t) => t.instanceUuid === "uuid-new")!.counting).toBe(0);
  });

  it("counts timeouts separately and never as failures", () => {
    const { s } = sensor();
    s.record("http://127.0.0.1:4096", { error: new RequestTimeoutError(30_000, "http://x") });

    const t = s.snapshot()[0]!;
    expect(t.timeout).toBe(1);
    expect(t.counting).toBe(0);
  });

  it("counts 4xx separately and never as failures", () => {
    const { s } = sensor();
    s.record("http://127.0.0.1:4096", { status: 404 });

    const t = s.snapshot()[0]!;
    expect(t.clientError).toBe(1);
    expect(t.counting).toBe(0);
  });

  it("drops observations it cannot attribute to a serve", () => {
    // An endpoint absent from the registry is the plugin's ephemeral direct
    // channel or a stale cached client — not evidence about any pool slot.
    const { s } = sensor({ resolve: () => undefined });
    s.record("http://127.0.0.1:39481", { status: 500 });
    expect(s.snapshot()).toHaveLength(0);
  });

  it("never throws out of record, whatever the resolver does", () => {
    // Called from inside the HTTP path on the live daemon.
    const { s } = sensor({
      resolve: () => {
        throw new Error("registry read failed");
      },
    });
    expect(() => s.record("http://127.0.0.1:4096", { status: 500 })).not.toThrow();
  });

  it("logs a periodic summary so the base rate becomes visible", () => {
    // The entire point of shadow mode: nothing records this today, so increment
    // 2's thresholds would otherwise be invented.
    const { s, log } = sensor();
    s.record("http://127.0.0.1:4096", { status: 500 });
    s.record("http://127.0.0.1:4096", { status: 200 });

    s.reportNow();

    expect(log).toHaveBeenCalled();
    const [msg, fields] = log.mock.calls[0]!;
    expect(msg).toMatch(/shadow/i);
    expect(JSON.stringify(fields)).toContain("serve-1");
  });

  it("says shadow mode in the summary so nobody thinks it is acting", () => {
    const { s, log } = sensor();
    s.record("http://127.0.0.1:4096", { status: 500 });
    s.reportNow();
    expect(String(log.mock.calls[0]![0])).toMatch(/shadow/i);
  });

  it("reports even when empty, so silence is verified rather than assumed", () => {
    // Was previously an early return. The reviewer was right that it made two
    // very different states byte-identical in the log: "the pool saw no daemon
    // traffic" and "attribution is broken so every observation was dropped".
    // A week of calibration could have been silently empty either way.
    const { s, log } = sensor();
    s.reportNow();
    expect(log).toHaveBeenCalled();
  });

  it("counts unattributable observations so a severed resolver is visible", () => {
    const { s, log } = sensor({ resolve: () => undefined });
    s.record("http://127.0.0.1:39481", { status: 500 });
    s.record("http://127.0.0.1:39482", { status: 500 });

    s.reportNow();

    expect(JSON.stringify(log.mock.calls[0]![1])).toContain('"unattributedObservations":2');
  });

  it("includes the time base so cumulative counters can be turned into rates", () => {
    // Counters are cumulative forever; without firstSeen/lastSeen a reader cannot
    // compute a rate, nor tell a daemon restart from a quiet hour.
    const { s, log } = sensor();
    s.record("http://127.0.0.1:4096", { status: 500 });

    s.reportNow();

    const fields = JSON.stringify(log.mock.calls[0]![1]);
    expect(fields).toContain("firstSeenAt");
    expect(fields).toContain("lastSeenAt");
  });
});

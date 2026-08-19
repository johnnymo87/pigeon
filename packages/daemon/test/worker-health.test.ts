import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/worker/poller";
import {
  WorkerHealthMonitor,
  SERVER_ERROR_THRESHOLD,
  SERVER_ERROR_MIN_SPAN_MS,
  TRANSPORT_THRESHOLD,
  TRANSPORT_MIN_SPAN_MS,
  CLIENT_ERROR_THRESHOLD,
  CLIENT_ERROR_MIN_SPAN_MS,
  classifyWorkerHealthSample,
} from "../src/worker/worker-health";

interface EnqueuedAlert {
  source: string;
  refMsgId: string | null;
  text: string;
  severity: string;
}

function createSink() {
  const alerts: EnqueuedAlert[] = [];
  return {
    alerts,
    enqueue(input: {
      source: string;
      refMsgId?: string | null;
      text: string;
      severity: "info" | "warning" | "error";
    }): boolean {
      alerts.push({
        source: input.source,
        refMsgId: input.refMsgId ?? null,
        text: input.text,
        severity: input.severity,
      });
      return true;
    },
  };
}

function serverError(status = 503, body?: unknown): WorkerResult {
  return { ok: false, kind: "http_error", status, ...(body !== undefined ? { body } : {}) };
}

function transportError(error = "fetch failed"): WorkerResult {
  return { ok: false, kind: "transport_error", error };
}

/**
 * Same shape as `serverError`, named for the 4xx range so the intent of a test reads
 * correctly. `serverError(404)` was always a misnomer -- it builds an http_error at
 * whatever status you pass.
 */
function clientError(status = 404, body?: unknown): WorkerResult {
  return { ok: false, kind: "http_error", status, ...(body !== undefined ? { body } : {}) };
}

function success(): WorkerResult {
  return { ok: true, kind: "success", status: 200, body: { ok: true } };
}

/** Records `count` server errors, advancing the shared clock by `stepMs` after each. */
function driveServerErrors(
  monitor: WorkerHealthMonitor,
  clock: { now: number },
  count: number,
  stepMs: number,
  endpoint: "register" | "send" = "send",
): void {
  for (let i = 0; i < count; i++) {
    monitor.record(endpoint, serverError());
    clock.now += stepMs;
  }
}

/** Records `count` client errors, advancing the shared clock by `stepMs` after each. */
function driveClientErrors(
  monitor: WorkerHealthMonitor,
  clock: { now: number },
  count: number,
  stepMs: number,
  endpoint: "register" | "send" = "send",
  status = 404,
): void {
  for (let i = 0; i < count; i++) {
    monitor.record(endpoint, clientError(status));
    clock.now += stepMs;
  }
}

function createMonitor(clock: { now: number }) {
  const sink = createSink();
  const monitor = new WorkerHealthMonitor({
    alerts: sink,
    nowFn: () => clock.now,
  });
  return { sink, monitor };
}

describe("classifyWorkerHealthSample", () => {
  it("classifies a 2xx success as success", () => {
    expect(classifyWorkerHealthSample(success())).toBe("success");
  });

  it("classifies any 5xx http_error as a server error", () => {
    expect(classifyWorkerHealthSample(serverError(500))).toBe("server_error");
    expect(classifyWorkerHealthSample(serverError(503))).toBe("server_error");
    expect(classifyWorkerHealthSample(serverError(599))).toBe("server_error");
  });

  it("classifies a thrown fetch as transport", () => {
    expect(classifyWorkerHealthSample(transportError())).toBe("transport");
  });

  /**
   * REVERSAL (pigeon-5typ). These four were asserted `neutral` until 2026-08-19, on the
   * grounds that a 4xx proves the worker is answering. True, and beside the point: a
   * SUSTAINED 4xx on a write route is a total outage for that function while the worker
   * stays perfectly healthy. The 2026-07-14 outage was most likely a 429 from the session
   * cap on register, so the alarm built in response to it would have stayed silent through
   * it.
   *
   * The original insight is preserved rather than discarded: a 4xx still must not CLEAR a
   * 5xx episode. It now extends an episode of its OWN class, which is what keeps a stream
   * of 404s from masking a live 5xx outage.
   */
  it("classifies every 4xx as a client error, including the July session-cap 429", () => {
    expect(classifyWorkerHealthSample(clientError(400))).toBe("client_error");
    expect(classifyWorkerHealthSample(clientError(401))).toBe("client_error");
    expect(classifyWorkerHealthSample(clientError(403))).toBe("client_error");
    expect(classifyWorkerHealthSample(clientError(404))).toBe("client_error");
    expect(classifyWorkerHealthSample(clientError(429))).toBe("client_error");
    expect(classifyWorkerHealthSample(clientError(499))).toBe("client_error");
  });

  /**
   * A worker 400 is counted, which looks like it contradicts the 502/Telegram-400 carve-out
   * below. It does not, and the difference is mechanical rather than a matter of taste.
   *
   * A Telegram 400 never reaches the daemon as an HTTP 400 -- it arrives as a 502 carrying
   * `details.error_code` (delivery-policy.ts rule 6). A 502 is a 5xx, so `isTransportFailure`
   * calls it transient and it is NEVER charged an outbox attempt: one poisoned message
   * retries until the age cap and would trip the alarm by itself. Hence the carve-out.
   *
   * A worker 400 is worker field validation only, and delivery-policy rule 4 makes it
   * TERMINAL -- the entry dies after a single attempt and cannot repeat. So five consecutive
   * 400s require five DISTINCT rejected entries, which means daemon/worker version skew:
   * the worker started requiring a field this daemon does not send. That is silent,
   * permanent message loss on every notification, and nothing else alarms on it.
   */
  it("counts a worker 400 (field validation) because it is terminal, not a retry loop", () => {
    expect(classifyWorkerHealthSample(clientError(400))).toBe("client_error");
  });

  it("treats app_rejection (2xx carrying ok:false) as neutral", () => {
    const result: WorkerResult = {
      ok: false,
      kind: "app_rejection",
      status: 200,
      body: { ok: false },
    };
    expect(classifyWorkerHealthSample(result)).toBe("neutral");
  });

  /**
   * The load-bearing exclusion. A Telegram client-error relayed by the worker arrives as
   * HTTP 502 carrying body.details.error_code in the 4xx range (see delivery-policy.ts
   * rule 6). That is Telegram's verdict on OUR message, not the worker failing, and it can
   * repeat forever: a 5xx never charges the entry an attempt (isTransportFailure), so a
   * poisoned message retries until the age cap. Counting it would produce a "worker is
   * down" alert naming the wrong component.
   */
  it("treats a 502 relaying a Telegram 400 as neutral, not a server error", () => {
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 400 } })),
    ).toBe("neutral");
  });

  /**
   * The exclusion is exactly 400 and nothing wider. The worker relays EVERY Telegram
   * error as 502 carrying that code (worker/telegram.ts getTelegramErrorDetails), so a
   * blanket 4xx exclusion would swallow 401 (bot token revoked or mis-rotated) and 403
   * (bot removed from the group). Those are verdicts on the deployment, not on one
   * message: they fail every send until a human intervenes, which is precisely the
   * sustained-total-failure shape this alarm exists to record.
   */
  it("counts a 502 relaying a Telegram 401 or 403 — those are account-level, not per-message", () => {
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 401 } })),
    ).toBe("server_error");
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 403 } })),
    ).toBe("server_error");
  });

  it("still counts a 502 relaying a Telegram 5xx, and a bare 502", () => {
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 500 } })),
    ).toBe("server_error");
    expect(classifyWorkerHealthSample(serverError(502))).toBe("server_error");
    expect(classifyWorkerHealthSample(serverError(502, { details: {} }))).toBe("server_error");
  });
});

describe("WorkerHealthMonitor — server error episodes", () => {
  it("does not alert below the consecutive threshold", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD - 1, 30_000);

    expect(sink.alerts).toHaveLength(0);
  });

  it("alerts once the threshold and the minimum span are both met", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 30_000);

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.severity).toBe("error");
    expect(sink.alerts[0]!.text).toContain("/notifications/send");
    expect(sink.alerts[0]!.refMsgId).toBe("worker5xx:send:1000000");
  });

  /**
   * The time floor. The outbox can burn the whole threshold inside a single batch pass,
   * so without this a one-second worker blip pages a human.
   */
  it("does NOT alert when the threshold is met faster than the minimum span", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD * 3, 1);

    expect(sink.alerts).toHaveLength(0);
  });

  it("alerts on the first failure that crosses the span, once the count is already met", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 1);
    expect(sink.alerts).toHaveLength(0);

    clock.now = 1_000_000 + SERVER_ERROR_MIN_SPAN_MS;
    monitor.record("send", serverError());

    expect(sink.alerts).toHaveLength(1);
  });

  it("alerts only once per episode, however long the outage runs", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, 500, 60_000);

    expect(sink.alerts).toHaveLength(1);
  });

  it("resets the counter on a success, so a later burst starts from zero", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD - 1, 30_000);
    monitor.record("send", success());
    clock.now += 30_000;
    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD - 1, 30_000);

    expect(sink.alerts).toHaveLength(0);
  });

  /**
   * The crux of this bead. The 2026-07-14 outage had a HEALTHY /machines/:id/next poll
   * throughout, and register stayed healthy while send failed. A counter shared across
   * endpoints, or one reset by unrelated healthy traffic, would have stayed silent through
   * the very outage this alarm exists to catch.
   */
  it("keeps endpoint counters independent — register successes do not clear a send episode", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < SERVER_ERROR_THRESHOLD; i++) {
      monitor.record("send", serverError());
      monitor.record("register", success());
      clock.now += 30_000;
    }

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.text).toContain("/notifications/send");
  });

  it("tracks the two endpoints as separate episodes", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < SERVER_ERROR_THRESHOLD; i++) {
      monitor.record("send", serverError());
      monitor.record("register", serverError());
      clock.now += 30_000;
    }

    expect(sink.alerts).toHaveLength(2);
    const refs = sink.alerts.map((a) => a.refMsgId).sort();
    expect(refs).toEqual(["worker5xx:register:1000000", "worker5xx:send:1000000"]);
  });

  it("neutral results neither trip nor clear an episode", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD - 1, 30_000);
    // A 502 relaying a Telegram 400 is the neutral case that survives pigeon-5typ; a plain
    // 4xx is no longer neutral and would now open an episode of its own class.
    monitor.record("send", serverError(502, { details: { error_code: 400 } }));
    clock.now += 30_000;
    expect(sink.alerts).toHaveLength(0);

    monitor.record("send", serverError());
    expect(sink.alerts).toHaveLength(1);
  });
});

describe("WorkerHealthMonitor — sustained 4xx (pigeon-5typ)", () => {
  it("trips after the threshold once the time floor is cleared", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD, CLIENT_ERROR_MIN_SPAN_MS / 4);

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.severity).toBe("error");
    expect(sink.alerts[0]!.refMsgId).toBe("worker4xx:send:1000000");
    expect(sink.alerts[0]!.text).toContain("4xx");
  });

  /**
   * The floor is the guard that separates a janitorial burst from an outage. A reaped
   * session's entry is terminal after at most a re-register and one retry, so a cleanup
   * cluster drains within a tick or two of the 5s outbox loop. Sustaining 4xx for five
   * minutes requires doomed entries to keep ARRIVING, which cleanup does not do.
   */
  it("does NOT trip on a fast burst that clears the count but not the floor", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD * 3, 1_000);

    expect(sink.alerts).toHaveLength(0);
  });

  /**
   * Pins the floor at the exact boundary. The looser burst test above only proves the floor
   * is longer than a few seconds; this one fails if the floor is shortened, lengthened, or
   * if the comparison flips between `<` and `<=`.
   */
  it("does not trip until the floor is actually crossed", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    // Count satisfied immediately, so only the floor is under test.
    for (let i = 0; i < CLIENT_ERROR_THRESHOLD; i++) {
      monitor.record("send", clientError());
    }
    clock.now += CLIENT_ERROR_MIN_SPAN_MS - 1;
    monitor.record("send", clientError());
    expect(sink.alerts).toHaveLength(0);

    clock.now += 1;
    monitor.record("send", clientError());
    expect(sink.alerts).toHaveLength(1);
  });

  /**
   * The scenario the floor exists to tolerate, in ABSOLUTE time so that shortening the floor
   * breaks this test. The tests above are all written relative to CLIENT_ERROR_MIN_SPAN_MS
   * and therefore scale with it, which means none of them can detect the constant being
   * lowered — the exact change that would make this alarm noisy.
   *
   * Basis: a reaped session's outbox entry 404s, may burn one re-registration, and is then
   * terminal, so it contributes about two samples spaced by the 5s tick and the first
   * backoff step. A handful of such entries draining together is ordinary janitorial
   * traffic and can stretch over a couple of minutes. It must not page anyone.
   */
  it("tolerates a reaped-session cleanup cluster draining over two minutes", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < CLIENT_ERROR_THRESHOLD * 2; i++) {
      monitor.record("send", clientError(404));
      clock.now += 30_000;
    }

    expect(sink.alerts).toHaveLength(0);
  });

  it("does NOT trip below the threshold even after a long span", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD - 1, CLIENT_ERROR_MIN_SPAN_MS);

    expect(sink.alerts).toHaveLength(0);
  });

  /**
   * The success path hand-enumerates the classes it clears, so a forgotten third class
   * fails SILENTLY: the episode would never clear, never re-alert, and never send a
   * recovery. That is the failure this test exists to catch.
   */
  it("clears a tripped 4xx episode on the next success and emits a recovery", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD, CLIENT_ERROR_MIN_SPAN_MS / 4);
    expect(sink.alerts).toHaveLength(1);

    monitor.record("send", success());

    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[1]!.severity).toBe("info");
    expect(sink.alerts[1]!.refMsgId).toBe("worker4xxok:send:1000000");
    expect(sink.alerts[1]!.text).toContain("recovered");

    // And the cleared episode can trip again rather than being wedged shut.
    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD, CLIENT_ERROR_MIN_SPAN_MS / 4);
    expect(sink.alerts).toHaveLength(3);
    expect(sink.alerts[2]!.severity).toBe("error");
  });

  it("keeps 4xx and 5xx episodes independent — neither clears the other", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    // Interleave: each class accrues its own count, and neither resets the other.
    for (let i = 0; i < SERVER_ERROR_THRESHOLD - 1; i++) {
      monitor.record("send", serverError());
      monitor.record("send", clientError(429));
      clock.now += 30_000;
    }
    expect(sink.alerts).toHaveLength(0);

    monitor.record("send", serverError());
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.refMsgId).toContain("worker5xx:");
  });

  it("tracks 4xx per endpoint, so register and send alert independently", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < CLIENT_ERROR_THRESHOLD; i++) {
      monitor.record("send", clientError(404));
      monitor.record("register", clientError(429));
      clock.now += CLIENT_ERROR_MIN_SPAN_MS / 4;
    }

    expect(sink.alerts).toHaveLength(2);
    const refs = sink.alerts.map((a) => a.refMsgId).sort();
    expect(refs).toEqual(["worker4xx:register:1000000", "worker4xx:send:1000000"]);
  });

  /**
   * The 5xx send text promises "the daemon outbox is holding and retrying". For a 4xx that
   * is a false reassurance: delivery-policy makes 400 terminal and 404 terminal once
   * re-registration is spent, so those entries are DROPPED, not held. Telling an operator
   * their messages are safe while they are being lost is worse than saying nothing.
   */
  it("does not promise the outbox is holding when a 4xx may be dropping entries", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveClientErrors(monitor, clock, CLIENT_ERROR_THRESHOLD, CLIENT_ERROR_MIN_SPAN_MS / 4);

    const text = sink.alerts[0]!.text;
    expect(text).not.toContain("the daemon outbox is holding and retrying");
    expect(text).toMatch(/drop|lost|terminal/i);
  });

  it("a success clears all THREE classes for that endpoint", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < SERVER_ERROR_THRESHOLD - 1; i++) {
      monitor.record("send", serverError());
      clock.now += 30_000;
    }
    for (let i = 0; i < TRANSPORT_THRESHOLD - 1; i++) {
      monitor.record("send", transportError());
      clock.now += 120_000;
    }
    for (let i = 0; i < CLIENT_ERROR_THRESHOLD - 1; i++) {
      monitor.record("send", clientError());
      clock.now += 120_000;
    }

    monitor.record("send", success());

    // Every class restarted from zero: one more failure of each must not reach a threshold.
    monitor.record("send", serverError());
    monitor.record("send", transportError());
    monitor.record("send", clientError());
    clock.now += CLIENT_ERROR_MIN_SPAN_MS;
    expect(sink.alerts).toHaveLength(0);
  });
});

describe("WorkerHealthMonitor — recovery", () => {
  it("emits an info recovery alert on the first success after an alerted episode", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 60_000);
    expect(sink.alerts).toHaveLength(1);

    monitor.record("send", success());

    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[1]!.severity).toBe("info");
    expect(sink.alerts[1]!.refMsgId).toBe("worker5xxok:send:1000000");
    expect(sink.alerts[1]!.text).toContain("recovered");
  });

  it("does NOT emit a recovery alert for an episode that never alerted", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD - 1, 30_000);
    monitor.record("send", success());

    expect(sink.alerts).toHaveLength(0);
  });

  it("reports the episode duration and failure count in the recovery text", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, 10, 60_000);
    clock.now = 1_000_000 + 2 * 60 * 60 * 1000;
    monitor.record("send", success());

    const recovery = sink.alerts[1]!;
    expect(recovery.text).toContain("2h");
    expect(recovery.text).toContain("10");
  });

  it("can alert again for a genuinely new episode after recovery", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 60_000);
    monitor.record("send", success());
    clock.now += 60_000;
    const secondEpisodeStart = clock.now;
    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 60_000);

    expect(sink.alerts).toHaveLength(3);
    expect(sink.alerts[2]!.refMsgId).toBe(`worker5xx:send:${secondEpisodeStart}`);
  });
});

describe("WorkerHealthMonitor — transport episodes", () => {
  it("alerts on sustained transport failures, under a stiffer span than 5xx", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < TRANSPORT_THRESHOLD; i++) {
      monitor.record("send", transportError());
      clock.now += TRANSPORT_MIN_SPAN_MS / (TRANSPORT_THRESHOLD - 1);
    }

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.refMsgId).toBe("workerxport:send:1000000");
    expect(sink.alerts[0]!.text).toContain("unreachable");
  });

  it("does not alert on a short transport blip that meets the count", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < TRANSPORT_THRESHOLD * 3; i++) {
      monitor.record("send", transportError());
      clock.now += 1_000;
    }

    expect(sink.alerts).toHaveLength(0);
  });

  /**
   * Mutual neutrality: a 5xx is not evidence the worker is reachable-but-broken in the
   * transport sense, and a transport error is not evidence about the 5xx condition. Only a
   * success clears either.
   */
  it("keeps 5xx and transport episodes from clearing each other", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < SERVER_ERROR_THRESHOLD - 1; i++) {
      monitor.record("send", serverError());
      clock.now += 30_000;
    }
    monitor.record("send", transportError());
    clock.now += 30_000;
    monitor.record("send", serverError());

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.refMsgId).toBe("worker5xx:send:1000000");
  });

  it("a success clears BOTH classes for that endpoint", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    for (let i = 0; i < SERVER_ERROR_THRESHOLD - 1; i++) {
      monitor.record("send", serverError());
      clock.now += 30_000;
    }
    for (let i = 0; i < TRANSPORT_THRESHOLD - 1; i++) {
      monitor.record("send", transportError());
      clock.now += 120_000;
    }

    monitor.record("send", success());
    clock.now += 30_000;

    monitor.record("send", serverError());
    monitor.record("send", transportError());

    expect(sink.alerts).toHaveLength(0);
  });
});

describe("WorkerHealthMonitor — robustness", () => {
  it("never lets a failing alert sink break the caller", () => {
    const clock = { now: 1_000_000 };
    const monitor = new WorkerHealthMonitor({
      alerts: {
        enqueue() {
          throw new Error("db is on fire");
        },
      },
      nowFn: () => clock.now,
    });

    expect(() => driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 60_000)).not.toThrow();
  });

  /**
   * A 5xx we deliberately decline to count still gets a journal line. Without this, the
   * one case the alarm is designed to stay quiet about is also the one case that leaves no
   * evidence at all — and "no durable record" is the whole reason the 2026-07-14 outage
   * could not be diagnosed sixteen days later.
   */
  it("logs a 5xx that it declines to count, so silence still leaves evidence", () => {
    const clock = { now: 1_000_000 };
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const monitor = new WorkerHealthMonitor({
      alerts: createSink(),
      nowFn: () => clock.now,
      log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
    });

    monitor.record("send", serverError(502, { details: { error_code: 400 } }));

    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toContain("not counted");
    expect(logged[0]!.fields?.telegramErrorCode).toBe(400);
  });

  it("does not log an uncounted 5xx below the alarm, nor a routine 4xx that clears", () => {
    const clock = { now: 1_000_000 };
    const logged: string[] = [];
    const monitor = new WorkerHealthMonitor({
      alerts: createSink(),
      nowFn: () => clock.now,
      log: (msg) => logged.push(msg),
    });

    // A single 4xx followed by a success is ordinary traffic (a reaped session's entry):
    // it opens an episode that clears before ever reaching the threshold, and since the
    // episode never alerted there is nothing to report.
    monitor.record("send", clientError(404));
    monitor.record("send", success());

    expect(logged).toEqual([]);
  });

  it("names the right consequence for each endpoint", () => {
    const clock = { now: 1_000_000 };
    const { sink, monitor } = createMonitor(clock);

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 30_000, "register");
    clock.now += 30_000;
    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 30_000, "send");

    const registerAlert = sink.alerts.find((a) => a.text.includes("/sessions/register"))!;
    const sendAlert = sink.alerts.find((a) => a.text.includes("/notifications/send"))!;

    expect(registerAlert.text).toContain("session");
    expect(registerAlert.text).not.toContain("Telegram delivery through the worker is down");
    expect(sendAlert.text).toContain("Telegram delivery through the worker is down");
  });

  it("logs the trip so there is durable journal evidence even with no alert egress", () => {
    const clock = { now: 1_000_000 };
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const monitor = new WorkerHealthMonitor({
      alerts: createSink(),
      nowFn: () => clock.now,
      log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
    });

    driveServerErrors(monitor, clock, SERVER_ERROR_THRESHOLD, 60_000);

    expect(logged.some((l) => l.msg.includes("worker health"))).toBe(true);
  });
});

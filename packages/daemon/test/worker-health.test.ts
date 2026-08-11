import { describe, expect, it } from "vitest";
import type { WorkerResult } from "../src/worker/poller";
import {
  WorkerHealthMonitor,
  SERVER_ERROR_THRESHOLD,
  SERVER_ERROR_MIN_SPAN_MS,
  TRANSPORT_THRESHOLD,
  TRANSPORT_MIN_SPAN_MS,
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

function success(): WorkerResult {
  return { ok: true, kind: "success", status: 200, body: { ok: true } };
}

/**
 * Drives `count` server errors spaced `stepMs` apart, starting at `startAt`.
 * Returns the clock value AFTER the final sample.
 */
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

  it("treats 4xx as neutral — the worker answered, but that is not evidence the 5xx cleared", () => {
    expect(classifyWorkerHealthSample(serverError(400))).toBe("neutral");
    expect(classifyWorkerHealthSample(serverError(403))).toBe("neutral");
    expect(classifyWorkerHealthSample(serverError(404))).toBe("neutral");
    expect(classifyWorkerHealthSample(serverError(429))).toBe("neutral");
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
  it("treats a 502 relaying a Telegram 4xx as neutral, not a server error", () => {
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 400 } })),
    ).toBe("neutral");
    expect(
      classifyWorkerHealthSample(serverError(502, { details: { error_code: 403 } })),
    ).toBe("neutral");
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
    monitor.record("send", serverError(400));
    clock.now += 30_000;
    expect(sink.alerts).toHaveLength(0);

    monitor.record("send", serverError());
    expect(sink.alerts).toHaveLength(1);
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

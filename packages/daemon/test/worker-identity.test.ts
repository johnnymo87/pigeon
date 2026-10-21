/** Daemon side of per-machine credentials (pigeon-k0qn.8). */
import { describe, it, expect, vi } from "vitest";
import { Poller, POLL_AUTH_ALERT_THRESHOLD, type PollerCallbacks } from "../src/worker/poller";
import { describeWorkerIdentity, formatPollAuthAlert } from "../src/worker/worker-identity";

const NO_CALLBACKS = {} as unknown as PollerCallbacks;

function pollerWith(
  respond: (url: string) => Response | Promise<Response>,
  onPollAuthRejected?: (status: number, n: number) => void,
) {
  const fetchFn = vi.fn(async (url: string) => respond(url));
  const poller = new Poller(
    { workerUrl: "https://w", apiKey: "pgk_x", machineId: "cloudbox" },
    NO_CALLBACKS,
    { fetchFn: fetchFn as unknown as typeof fetch, ...(onPollAuthRejected ? { onPollAuthRejected } : {}) },
  );
  return { poller, fetchFn };
}

describe("Poller.whoami", () => {
  it("reads a machine credential", async () => {
    const { poller, fetchFn } = pollerWith(() =>
      Response.json({ credential: "machine", machine_id: "cloudbox" }),
    );
    expect(await poller.whoami()).toEqual({ kind: "machine", machineId: "cloudbox" });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://w/whoami");
  });

  it("reads the shared key", async () => {
    const { poller } = pollerWith(() => Response.json({ credential: "shared", machine_id: null }));
    expect(await poller.whoami()).toEqual({ kind: "shared" });
  });

  it("reports rejection, an old worker, and transport failure without throwing", async () => {
    expect(await pollerWith(() => new Response("", { status: 401 })).poller.whoami())
      .toEqual({ kind: "rejected", status: 401 });
    expect(await pollerWith(() => new Response("", { status: 404 })).poller.whoami())
      .toEqual({ kind: "unsupported" });
    expect((await pollerWith(() => { throw new Error("boom"); }).poller.whoami()).kind)
      .toBe("unknown");
  });
});

describe("refused-poll alarm", () => {
  it("fires once at the threshold of consecutive 401/403 polls", async () => {
    const onRejected = vi.fn();
    const { poller } = pollerWith(() => new Response("", { status: 403 }), onRejected);
    for (let i = 0; i < POLL_AUTH_ALERT_THRESHOLD * 2; i++) {
      await expect(poller.poll()).rejects.toThrow(/403/);
    }
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(403, POLL_AUTH_ALERT_THRESHOLD);
  });

  it("re-arms after a successful poll, and ignores other failures", async () => {
    const onRejected = vi.fn();
    let status = 401;
    const { poller } = pollerWith(() => new Response(null, { status }), onRejected);
    for (let i = 0; i < POLL_AUTH_ALERT_THRESHOLD - 1; i++) await poller.poll().catch(() => {});
    status = 500;
    await poller.poll().catch(() => {});
    status = 401;
    await poller.poll().catch(() => {});
    expect(onRejected).toHaveBeenCalledTimes(1); // a 500 neither resets nor counts
    status = 204;
    await poller.poll();
    status = 401;
    for (let i = 0; i < POLL_AUTH_ALERT_THRESHOLD; i++) await poller.poll().catch(() => {});
    expect(onRejected).toHaveBeenCalledTimes(2);
  });
});

describe("describeWorkerIdentity", () => {
  it("logs a match and warns on a mismatch or rejection", () => {
    expect(describeWorkerIdentity({ kind: "machine", machineId: "cloudbox" }, "cloudbox"))
      .toEqual({ level: "log", text: "[worker-identity] credential=machine machine=cloudbox" });
    const mismatch = describeWorkerIdentity({ kind: "machine", machineId: "devbox" }, "cloudbox");
    expect(mismatch.level).toBe("warn");
    expect(mismatch.text).toContain("MISMATCH");
    expect(describeWorkerIdentity({ kind: "rejected", status: 401 }, "cloudbox").level).toBe("warn");
    expect(describeWorkerIdentity({ kind: "shared" }, "cloudbox").text).toContain("credential=shared");
  });

  it("the alert names the machine, the status and the runbook", () => {
    const text = formatPollAuthAlert("devbox", 403, 12);
    expect(text).toContain("devbox");
    expect(text).toContain("HTTP 403");
    expect(text).toContain("per-machine-credentials.md");
  });
});

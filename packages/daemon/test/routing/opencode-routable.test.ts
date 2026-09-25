import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { IngressRouter } from "../../src/routing/router";
import { OpencodeClientFactory } from "../../src/routing/client-factory";
import { isOpencodeRoutable, makeClientForSession } from "../../src/routing/opencode-routable";
import { GOOSE_BACKEND_KIND } from "../../src/goose/backend-kind";
import type { UpsertSessionInput } from "../../src/storage/types";

const OPENCODE: Partial<UpsertSessionInput> = {
  backendKind: "opencode-plugin-direct",
  backendProtocolVersion: 1,
  backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
  backendAuthToken: "tok",
};

describe("isOpencodeRoutable", () => {
  const rec = (fields: { backendKind?: string | null; nvimSocket?: string | null; ptyPath?: string | null }) => ({
    backendKind: fields.backendKind ?? null,
    nvimSocket: fields.nvimSocket ?? null,
    ptyPath: fields.ptyPath ?? null,
  });

  it("routes a session the opencode plugin registered", () => {
    expect(isOpencodeRoutable(rec({ backendKind: "opencode-plugin-direct" }))).toBe(true);
  });

  it("routes an id with no session row, which /launch and swarm rely on", () => {
    // /launch resolves the owner of a session it has just created, BEFORE the
    // plugin inside it has registered. Refusing unknown ids would break launch.
    expect(isOpencodeRoutable(undefined)).toBe(true);
  });

  it("does not route a registered session that declared no backend", () => {
    // The shape of an external registrant that only wants a Telegram topic
    // (for example a scripted job posting /session-start + /stop). Routing it
    // would place an opencode lease for a session no opencode serve has.
    expect(isOpencodeRoutable(rec({}))).toBe(false);
  });

  it("does not route goose, or any backend kind it does not recognise", () => {
    expect(isOpencodeRoutable(rec({ backendKind: GOOSE_BACKEND_KIND }))).toBe(false);
    // A kind sent once and then withdrawn persists: /session-start keeps the
    // stored kind when a later registration omits it.
    expect(isOpencodeRoutable(rec({ backendKind: "goose-pull" }))).toBe(false);
    expect(isOpencodeRoutable(rec({ backendKind: "something-new" }))).toBe(false);
  });

  it("keeps routing any non-goose session selectAdapter would serve over nvim", () => {
    // selectAdapter still serves these through NvimRpcAdapter, and their
    // connection-error recovery revives through the opencode client. Taking the
    // client away would turn a transient failure into a deleted session.
    expect(isOpencodeRoutable(rec({ nvimSocket: "/tmp/nvim.sock", ptyPath: "/dev/pts/3" }))).toBe(true);
    // selectAdapter does not look at the kind for the nvim branch, so neither
    // may this: refusing these would expose them to the delete branch.
    expect(isOpencodeRoutable(rec({ backendKind: "goose-pull", nvimSocket: "/tmp/nvim.sock", ptyPath: "/dev/pts/3" }))).toBe(true);
    // goose stays refused whatever else it carries.
    expect(isOpencodeRoutable(rec({ backendKind: GOOSE_BACKEND_KIND, nvimSocket: "/tmp/nvim.sock", ptyPath: "/dev/pts/3" }))).toBe(false);
    // Half the evidence is not enough; selectAdapter needs both too.
    expect(isOpencodeRoutable(rec({ nvimSocket: "/tmp/nvim.sock" }))).toBe(false);
    expect(isOpencodeRoutable(rec({ ptyPath: "/dev/pts/3" }))).toBe(false);
  });
});

/**
 * Behavioural: the resolver the daemon wires as `clientForSession`, over a real
 * in-memory router. The hazard is a side effect (an assignment row and a live
 * lease that count against activeTurnCap), so that is what is asserted -- not
 * merely the return value.
 */
describe("makeClientForSession", () => {
  function setup() {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });
    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });
    const factory = new OpencodeClientFactory(router, () => now);
    const clientForSession = makeClientForSession({
      getSession: (id) => s.sessions.get(id) ?? undefined,
      clientFactory: factory,
      fallbackClient: undefined,
    });
    const register = (sessionId: string, fields: Partial<UpsertSessionInput>) =>
      s.sessions.upsert({ sessionId, notify: true, ...fields }, now);
    return { s, clientForSession, register };
  }

  it("places no assignment and no lease for a session with no backend", () => {
    const { s, clientForSession, register } = setup();
    register("ses_scripted_job", { cwd: "/tmp/job", label: "job" });

    expect(clientForSession("ses_scripted_job")).toBeUndefined();
    expect(s.assignments.get("ses_scripted_job")).toBeNull();
    expect(s.leases.get("ses_scripted_job")).toBeNull();
  });

  it("places no assignment and no lease for goose or an unknown backend kind", () => {
    const { s, clientForSession, register } = setup();
    register("gse_1", { backendKind: GOOSE_BACKEND_KIND, backendEndpoint: "ws://127.0.0.1:4080/acp" });
    register("ses_pull", { backendKind: "goose-pull" });

    for (const id of ["gse_1", "ses_pull"]) {
      expect(clientForSession(id), id).toBeUndefined();
      expect(s.assignments.get(id), id).toBeNull();
      expect(s.leases.get(id), id).toBeNull();
    }
  });

  it("still routes and leases a real opencode session", () => {
    const { s, clientForSession, register } = setup();
    register("ses_real", OPENCODE);

    expect(clientForSession("ses_real")).toBeDefined();
    expect(s.assignments.get("ses_real")?.desiredServeId).toBe("serve-1");
    expect(s.leases.get("ses_real")?.serveId).toBe("serve-1");
  });

  it("still routes an id with no row (launch resolves its owner before registration)", () => {
    const { s, clientForSession } = setup();
    expect(clientForSession("ses_just_created")).toBeDefined();
    expect(s.assignments.get("ses_just_created")).not.toBeNull();
  });

  it("falls back to the single legacy client when routing is unconfigured, still refusing non-opencode sessions", () => {
    const s = openStorageDb(":memory:");
    const fallback = { tag: "legacy" } as never;
    const clientForSession = makeClientForSession({
      getSession: (id) => s.sessions.get(id) ?? undefined,
      clientFactory: undefined,
      fallbackClient: fallback,
    });
    s.sessions.upsert({ sessionId: "ses_real", notify: true, ...OPENCODE }, 1);
    s.sessions.upsert({ sessionId: "ses_none", notify: true }, 1);

    expect(clientForSession("ses_real")).toBe(fallback);
    expect(clientForSession("ses_none")).toBeUndefined();
  });
});

/**
 * The invariant the refusal rests on, checked against selectAdapter itself
 * rather than restated: any row the router is refused for must have either no
 * adapter or a `surface` one. A non-surface adapter with no opencode client
 * reaches command-ingest's connection-error branch that DELETES the session.
 * If selectAdapter grows a new branch, this is what notices.
 */
describe("isOpencodeRoutable agrees with selectAdapter", () => {
  it("never refuses a row that selectAdapter would serve with a non-surface adapter", async () => {
    const { selectAdapter } = await import("../../src/worker/command-ingest");
    const s = openStorageDb(":memory:");
    const fakeRunner = (() => ({})) as never;
    let n = 0;
    for (const backendKind of [null, "opencode-plugin-direct", GOOSE_BACKEND_KIND, "goose-pull", "other"]) {
      for (const endpoint of [null, "http://x"]) {
        for (const token of [null, "t"]) {
          for (const nvimSocket of [null, "/tmp/n.sock"]) {
            for (const ptyPath of [null, "/dev/pts/1"]) {
              for (const runners of [undefined, fakeRunner]) {
                const id = `s${n++}`;
                s.sessions.upsert({ sessionId: id, notify: true, backendKind, backendEndpoint: endpoint, backendAuthToken: token, nvimSocket, ptyPath }, 1);
                const rec = s.sessions.get(id)!;
                const adapter = selectAdapter(rec, undefined, runners);
                // KNOWN, PRE-EXISTING, NOT WIDENED HERE: a goose row that also
                // carries an nvim socket + pty, on a daemon with goose
                // unconfigured, gets NvimRpcAdapter. The goose-only guard this
                // replaces refused it too. No path writes that row today --
                // register-session.ts sets neither field -- and routing it
                // would put goose ids back in the opencode pool.
                const knownGooseNvimGap = backendKind === GOOSE_BACKEND_KIND && nvimSocket && ptyPath && !runners;
                if (!isOpencodeRoutable(rec) && !knownGooseNvimGap) {
                  const label = JSON.stringify({ backendKind, endpoint, token, nvimSocket, ptyPath, runners: Boolean(runners) });
                  expect(adapter === null || adapter.failurePolicy === "surface", label).toBe(true);
                }
              }
            }
          }
        }
      }
    }
    expect(n).toBe(160);
  });
});

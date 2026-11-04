import { describe, expect, it } from "vitest";
import { coordinatorProgramOf, tagKeyFor, whichKeyFor, type TagKeySession } from "../src/tag-key";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";

function lookup(...rows: TagKeySession[]) {
  return { get: (id: string) => rows.find((r) => r.sessionId === id) ?? null };
}

const goose = (over: Partial<TagKeySession> = {}): TagKeySession => ({
  sessionId: "gse_aaaa-bbbb",
  backendKind: GOOSE_BACKEND_KIND,
  backendSessionId: "20261104_3",
  boundTopicKey: null,
  ...over,
});

describe("tagKeyFor", () => {
  it("keys an opencode session by its own id", () => {
    expect(tagKeyFor("ses_abc123", lookup())).toEqual({ ok: true, key: "ses_abc123" });
  });

  it("keys a goose session by goose:<backend_session_id>, the key goose spend is ledgered under", () => {
    expect(tagKeyFor("gse_aaaa-bbbb", lookup(goose()))).toEqual({ ok: true, key: "goose:20261104_3" });
  });

  it("keys a legacy goose row (NULL backend_session_id) by its own id, which IS goose's id", () => {
    const legacy = goose({ sessionId: "20260920_1", backendSessionId: null });
    expect(tagKeyFor("20260920_1", lookup(legacy))).toEqual({ ok: true, key: "goose:20260920_1" });
  });

  it("never produces goose:gse_ (session-tags refuses it)", () => {
    const broken = goose({ backendSessionId: null });
    const res = tagKeyFor("gse_aaaa-bbbb", lookup(broken));
    expect(res.ok).toBe(false);
  });

  it("refuses a gse_ id with no local goose row rather than passing a pigeon id to session-tags", () => {
    const res = tagKeyFor("gse_unknown", lookup());
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.reason).toMatch(/not a goose session on this machine/);
  });

  it("refuses an id that could be read as an option", () => {
    expect(tagKeyFor("--db", lookup()).ok).toBe(false);
    expect(tagKeyFor(undefined as unknown as string, lookup()).ok).toBe(false);
  });

  it("refuses a goose row whose backend id could be read as an option", () => {
    expect(tagKeyFor("gse_aaaa-bbbb", lookup(goose({ backendSessionId: "-x" }))).ok).toBe(false);
  });

  it("passes a well-formed goose:<native> key through (the /tag backlog lists them)", () => {
    expect(tagKeyFor("goose:20261031_1", lookup())).toEqual({ ok: true, key: "goose:20261031_1" });
  });

  it("refuses goose:gse_ and a goose: key that could be read oddly", () => {
    expect(tagKeyFor("goose:gse_abc", lookup()).ok).toBe(false);
    expect(tagKeyFor("goose:", lookup()).ok).toBe(false);
    expect(tagKeyFor("goose:-x", lookup()).ok).toBe(false);
  });

  it("works with no session store for an opencode id", () => {
    expect(tagKeyFor("ses_abc", undefined)).toEqual({ ok: true, key: "ses_abc" });
  });

  it("survives a store that throws", () => {
    const throwing = { get: () => { throw new Error("db closed"); } };
    expect(tagKeyFor("ses_abc", throwing)).toEqual({ ok: true, key: "ses_abc" });
    expect(tagKeyFor("gse_x", throwing).ok).toBe(false);
  });
});

describe("coordinatorProgramOf", () => {
  it("reads the program tag off a stall-watch coordinator binding", () => {
    expect(coordinatorProgramOf(goose({ boundTopicKey: "stallwatch:mono-ci" }))).toEqual({ program: "mono-ci" });
  });

  it("is null for a session that is not a coordinator", () => {
    expect(coordinatorProgramOf(goose())).toBeNull();
    expect(coordinatorProgramOf(goose({ boundTopicKey: "digest:x" }))).toBeNull();
    expect(coordinatorProgramOf(null)).toBeNull();
  });

  it("reports an unusable program tag rather than falling back to the coordinator's own tag", () => {
    expect(coordinatorProgramOf(goose({ boundTopicKey: "stallwatch:" }))).toMatchObject({ invalid: "" });
    expect(coordinatorProgramOf(goose({ boundTopicKey: "stallwatch:auto:x" }))).toMatchObject({ invalid: "auto:x" });
  });
});

describe("whichKeyFor", () => {
  it("maps a goose session and passes an opencode one through", () => {
    expect(whichKeyFor("gse_aaaa-bbbb", lookup(goose()))).toBe("goose:20261104_3");
    expect(whichKeyFor("ses_abc", lookup())).toBe("ses_abc");
  });

  it("withholds an unmappable gse_ id", () => {
    expect(whichKeyFor("gse_unknown", lookup())).toBeNull();
  });

  it("passes through an id it has no rule for, as the footer always did", () => {
    expect(whichKeyFor("pull-session-1", lookup())).toBe("pull-session-1");
  });
});

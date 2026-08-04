/**
 * Cross-repo schema firewall for the routing database (bead pigeon-f2a, rule 5
 * of the pigeon-u1u spine).
 *
 * WHY THIS FILE EXISTS
 *
 * The routing DB is a SHARED file: pigeon opens it as its daemon storage DB, and
 * every `opencode serve` in the pool opens the same path via OPENCODE_ROUTING_DB.
 * The two processes ship from two different repos on two different release
 * cadences, and they agree on the schema through exactly one mechanism:
 *
 *   1. pigeon hashes its own `ROUTING_DDL` template string and writes the digest
 *      into `routing_meta.ddl_checksum` (route-schema.ts).
 *   2. the serve reads that column back and compares it to a HARDCODED constant
 *      baked into the patch — `EXPECTED_DDL_CHECKSUM` in
 *      opencode-patched/patches/serve-lease.patch. On mismatch it throws
 *      SchemaMismatchError at startup.
 *
 * Note what the serve does NOT do: it never re-hashes the actual live schema. It
 * compares one recorded string to one compiled-in string. Two consequences, both
 * load-bearing for this bead:
 *
 *   - Editing `ROUTING_DDL` by even one character crash-loops the entire serve
 *     pool until a matching opencode-patched release lands. That is an 8-step
 *     cross-repo lockstep, and any ordering slip takes routing down.
 *   - Adding a table OUTSIDE `ROUTING_DDL` is completely free. `ROUTING_DDL` is
 *     unchanged, so the digest is unchanged, so the serve is unaffected and needs
 *     no coordination at all.
 *
 * `reassignment_event` (this bead) is deliberately defined in its own DDL string
 * for exactly that reason, and the second test below is what stops a future
 * refactor from "tidying" it into `ROUTING_DDL` and taking the pool down.
 *
 * The constant below is duplicated from the patch ON PURPOSE. Importing it is
 * impossible (different repo, applied as a patch), so this test is the only place
 * the cross-repo contract is mechanically checked. If it fails, do not update the
 * constant to make it green — that just moves the breakage to production. Read
 * the 8-step release note on pigeon-ntk item 2 first.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ROUTING_DDL, ROUTING_SCHEMA_VERSION } from "../../src/routing/route-schema";

/**
 * Verbatim from opencode-patched/patches/serve-lease.patch:
 *   export const EXPECTED_DDL_CHECKSUM = "e5c8e409...";
 * Verified against that patch on 2026-07-27.
 */
const SERVE_EXPECTED_DDL_CHECKSUM =
  "e5c8e4094735034be618553ee3594a26f20d06004902ed0da8f66dc25eef4a68";

/** The serve pins this too (EXPECTED_SCHEMA_VERSION), same failure mode. */
const SERVE_EXPECTED_SCHEMA_VERSION = 1;

describe("routing schema cross-repo contract", () => {
  it("ROUTING_DDL still hashes to the checksum the serve pool has compiled in", () => {
    const actual = createHash("sha256").update(ROUTING_DDL).digest("hex");

    expect(
      actual,
      "ROUTING_DDL changed. Every opencode serve in the pool will throw " +
        "SchemaMismatchError on startup and crash-loop until a matching " +
        "opencode-patched release is deployed. If this change is genuinely " +
        "intended, follow the 8-step cross-repo lockstep; if you only needed a " +
        "new table, define it in its own DDL string instead (see " +
        "REASSIGNMENT_DDL) and this test stays green for free.",
    ).toBe(SERVE_EXPECTED_DDL_CHECKSUM);
  });

  it("schema version still matches the serve's pinned EXPECTED_SCHEMA_VERSION", () => {
    expect(ROUTING_SCHEMA_VERSION).toBe(SERVE_EXPECTED_SCHEMA_VERSION);
  });

  it("keeps daemon-private tables out of ROUTING_DDL so the digest stays stable", () => {
    // The whole point of the separate DDL string. If someone inlines it, the
    // digest changes and the pool crash-loops — catch it here, at desk, rather
    // than at 3am via a restart loop.
    expect(ROUTING_DDL).not.toContain("reassignment_event");
    expect(ROUTING_DDL).not.toContain("flap_alert_state");
  });
});

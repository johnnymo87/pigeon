import { describe, expect, it } from "vitest";
import { LAUNCH_USAGE_TEXT, parseLaunchMessage } from "../src/launch-command";

describe("parseLaunchMessage", () => {
  it("returns null for text that is not a /launch command", () => {
    expect(parseLaunchMessage("hello")).toBeNull();
    expect(parseLaunchMessage("/launchpad devbox pigeon hi")).toBeNull();
    expect(parseLaunchMessage("/tag billing")).toBeNull();
  });

  it("parses the untagged form", () => {
    expect(parseLaunchMessage("/launch devbox pigeon fix the failing test")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      prompt: "fix the failing test",
    });
  });

  it("keeps the prompt greedy, across newlines and runs of whitespace", () => {
    const parsed = parseLaunchMessage("/launch  devbox   /tmp/proj   do a thing\nand another");
    expect(parsed).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "/tmp/proj",
      prompt: "do a thing\nand another",
    });
  });

  it("parses --tag between the directory and the prompt", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag launch-tag fix the failing test")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      tag: "launch-tag",
      prompt: "fix the failing test",
    });
  });

  it("accepts a newline between --tag's value and the prompt", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm\nfix the failing test")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      tag: "fbm",
      prompt: "fix the failing test",
    });
  });

  it("does not treat a --tag later in the prompt as a flag", () => {
    expect(parseLaunchMessage("/launch devbox pigeon add --tag to the CLI")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      prompt: "add --tag to the CLI",
    });
  });

  it("leaves a prompt starting with # alone — # is not a tag sigil", () => {
    expect(parseLaunchMessage("/launch devbox pigeon #4231 is failing, fix it")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      prompt: "#4231 is failing, fix it",
    });
  });

  it("answers usage for a malformed /launch instead of returning null", () => {
    // Returning null would let webhook.ts fall through to the plain-message
    // path, injecting the typo into a live session as a prompt.
    expect(parseLaunchMessage("/launch")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon   ")).toEqual({ kind: "usage" });
  });

  it("answers usage for --tag with no prompt after it", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm   ")).toEqual({ kind: "usage" });
  });

  it("answers usage for an invalid tag rather than queueing it", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag auto:pigeon do it")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --tag --dir do it")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --tag has;semi do it")).toEqual({ kind: "usage" });
  });

  it("answers usage for a tag shaped like a session id", () => {
    // Mirrors /tag: a lone session id is a half-typed command, not a tag.
    expect(parseLaunchMessage("/launch devbox pigeon --tag ses_abc123 do it")).toEqual({ kind: "usage" });
  });

  it("answers usage for near-miss flag spellings instead of eating them as prompt", () => {
    // -t / --tag=x / --Tag are typos; the em dash is what iOS smart punctuation
    // makes of "--". A real prompt never begins with a dash-like character.
    // The fullwidth hyphen and the soft hyphen are in here because enumerating
    // a few dashes by hand let them through as PROMPT -- the silent-eat this
    // guard exists to prevent.
    for (const bad of [
      "-t fbm do it", "--tag=fbm do it", "--Tag fbm do it", "—tag fbm do it",
      "–tag fbm do it", "--taag fbm do it", "\uff0dtag fbm do it", "\u00adtag fbm do it",
      "\ufe63tag fbm do it",
    ]) {
      expect(parseLaunchMessage(`/launch devbox pigeon ${bad}`), bad).toEqual({ kind: "usage" });
    }
  });

  it("answers usage when the flag is in the machine or directory position", () => {
    // The workstation CLI takes its flags first, so this is the likely mistake.
    // Unguarded, these become "--tag is not recently seen" and a session in
    // ~/projects/--tag respectively.
    expect(parseLaunchMessage("/launch --tag fbm devbox pigeon do it")).toEqual({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox --tag fbm pigeon do it")).toEqual({ kind: "usage" });
  });

  it("names --tag in the usage text", () => {
    expect(LAUNCH_USAGE_TEXT).toContain("--tag");
    expect(LAUNCH_USAGE_TEXT).toContain("/launch");
  });
});

/**
 * `--backend`, and the flag loop it forces.
 *
 * `--tag` used to be recognised in one shot as "the first token of the tail".
 * A second flag turns that into a loop, and a loop is where a greedy prompt gets
 * dangerous: every token consumed as a flag is a token silently removed from
 * what the human asked for. So the loop stops at the first token that is not a
 * dash-led flag, and anything dash-led that is not exactly a known flag is
 * answered with usage rather than guessed at.
 */
describe("parseLaunchMessage --backend", () => {
  it("parses --backend on its own", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --backend goose fix the test")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      backend: "goose",
      prompt: "fix the test",
    });
  });

  it("accepts the explicit default without making it special", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --backend opencode do it")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      backend: "opencode",
      prompt: "do it",
    });
  });

  it("omits backend entirely when not asked for, so the wire shape is unchanged", () => {
    // A launch with no --backend must serialise exactly as it did before this
    // flag existed: poll.ts only puts `backend` on the wire when metadata
    // carries it, and a pre-gate daemon must keep seeing the old body.
    const parsed = parseLaunchMessage("/launch devbox pigeon do it");
    expect(parsed).not.toHaveProperty("backend");
  });

  it("normalises case, so --backend GOOSE is not an unknown backend", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --backend GOOSE do it")).toMatchObject({
      kind: "launch",
      backend: "goose",
    });
  });

  it("answers usage for a backend nothing can serve", () => {
    // Refused HERE rather than at the daemon: the worker knows the closed set,
    // and a typo'd backend should cost a usage message, not a queued command
    // that fails a poll later.
    expect(parseLaunchMessage("/launch devbox pigeon --backend gooose do it")).toMatchObject({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --backend claude do it")).toMatchObject({ kind: "usage" });
  });

  it("answers usage for --backend with no value or no prompt", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --backend")).toMatchObject({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --backend goose")).toMatchObject({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --backend goose   ")).toMatchObject({ kind: "usage" });
  });

  it("takes both flags, in either order", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm --backend opencode do it")).toMatchObject({
      kind: "launch", tag: "fbm", backend: "opencode", prompt: "do it",
    });
    expect(parseLaunchMessage("/launch devbox pigeon --backend opencode --tag fbm do it")).toMatchObject({
      kind: "launch", tag: "fbm", backend: "opencode", prompt: "do it",
    });
  });

  /**
   * `--tag` drives oc-tags, which is opencode-only cost attribution. Accepting
   * it alongside `--backend goose` and then ignoring it would tell the human
   * their session was tagged when no tag exists anywhere.
   */
  it("refuses --tag with --backend goose, rather than accepting and ignoring it", () => {
    const parsed = parseLaunchMessage("/launch devbox pigeon --tag fbm --backend goose do it");
    expect(parsed?.kind).toBe("usage");
    // A bare usage dump would not say WHY, and the human would read the
    // combination as a syntax error and retry it.
    expect(parsed?.kind === "usage" && parsed.reason).toMatch(/tag/i);
  });

  it("refuses a repeated flag instead of silently taking one of them", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --backend goose --backend opencode do it")).toMatchObject({ kind: "usage" });
    expect(parseLaunchMessage("/launch devbox pigeon --tag a --tag b do it")).toMatchObject({ kind: "usage" });
  });

  it("does not treat --backend later in the prompt as a flag", () => {
    expect(parseLaunchMessage("/launch devbox pigeon explain the --backend flag")).toEqual({
      kind: "launch",
      machineId: "devbox",
      directory: "pigeon",
      prompt: "explain the --backend flag",
    });
  });

  it("still answers usage for near-miss spellings of the new flag", () => {
    for (const bad of ["--backend=goose do it", "--Backend goose do it", "—backend goose do it", "-b goose do it"]) {
      expect(parseLaunchMessage(`/launch devbox pigeon ${bad}`), bad).toMatchObject({ kind: "usage" });
    }
  });

  /**
   * A deliberate behaviour change, pinned so it is a decision rather than an
   * accident. Before the flag loop, `--tag x` consumed exactly one flag and
   * everything after it was prompt -- so a prompt beginning with a dash was
   * accepted THERE while being refused in the no-flag form. Now the same rule
   * applies in both places.
   *
   * The alternative -- a position where dash-led tokens mean prose -- is
   * exactly the inconsistency that lets a mistyped second flag be eaten
   * silently, which is the failure this parser is built to prevent.
   */
  it("applies the no-dash-led-prompt rule after a flag too, not only before one", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm -1 is returned by foo")).toMatchObject({ kind: "usage" });
    // ...and the no-flag form is unchanged, as it always did this.
    expect(parseLaunchMessage("/launch devbox pigeon -1 is returned by foo")).toMatchObject({ kind: "usage" });
  });

  it("still accepts a dash INSIDE the prompt, just not at its start", () => {
    expect(parseLaunchMessage("/launch devbox pigeon --tag fbm return -1 from foo")).toMatchObject({
      kind: "launch", tag: "fbm", prompt: "return -1 from foo",
    });
  });

  it("names --backend in the usage text", () => {
    expect(LAUNCH_USAGE_TEXT).toContain("--backend");
    expect(LAUNCH_USAGE_TEXT).toContain("goose");
  });
});

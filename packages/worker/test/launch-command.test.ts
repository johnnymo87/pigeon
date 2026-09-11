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

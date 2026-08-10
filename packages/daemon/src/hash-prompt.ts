import { createHash } from "node:crypto";

/**
 * Computes sha256 hex digest of prompt text.
 * Canonical hash helper shared across daemon record sites, mirror route, and plugin.
 */
export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

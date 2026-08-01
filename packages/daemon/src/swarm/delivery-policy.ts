import { TransportError } from "../opencode-client";

export class TargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetUnavailableError";
  }
}

/**
 * Returns true if the delivery failure was an outage failure (uncounted retry).
 * Uncounted means "the request provably never reached the serve" (so a retry cannot duplicate a prompt).
 *
 * Timeout being COUNTED (returning false) is deliberate and important:
 * `prompt_async` is NOT idempotent, so a timeout may mean the request WAS processed.
 * Uncounted timeout retries would mean unbounded duplicate wakes.
 */
export function isOutageFailure(err: unknown): boolean {
  if (err instanceof TargetUnavailableError) {
    return true;
  }
  if (err instanceof TransportError) {
    return true;
  }
  return false;
}

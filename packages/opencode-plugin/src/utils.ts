/**
 * Serialize an Error object to a plain object for JSON serialization.
 * Handles Error instances, strings, and other values gracefully.
 */
export function serializeError(data: unknown): unknown {
  if (data instanceof Error) {
    return {
      message: data.message,
      stack: data.stack,
      name: data.name,
    }
  }
  return data
}

/** Extract a human-readable message string from an unknown error value.
 *
 * Handles standard Error instances, plain strings, OpenCode NamedError
 * objects (`{ name, data: { message? } }`), and generic `{ message }` objects.
 * Falls back to JSON serialisation so callers never see `[object Object]`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>
    // OpenCode NamedError shape: { name: string, data: { message?: string } }
    if (typeof obj.data === "object" && obj.data !== null) {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === "string") return data.message
      // Named error without data.message (e.g. MessageOutputLengthError)
      if (typeof obj.name === "string") return obj.name
    }
    // Plain { message: string }
    if (typeof obj.message === "string") return obj.message
    // Last resort for objects: JSON so we never return [object Object]
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/**
 * Determine whether an error object represents an aborted session/message.
 *
 * Keys strictly on `name === "MessageAbortedError"`, matching the closed union
 * `ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError`
 * typed in `@opencode-ai/sdk/dist/gen/types.gen.d.ts` (lines 80-85, 518-524).
 *
 * Within that closed union, `/abort/i` on `name` is exactly equivalent to
 * `name === "MessageAbortedError"` since none of the other four union names match.
 * Keying on the exact typed name avoids dangerous false positives: client libraries
 * that abort an internal controller on a network timeout produce `name: "AbortError"`,
 * which is a genuine failure that must notify the user.
 *
 * No message fallback is used: `errorMessage` prefers `data.message`, so an `APIError`
 * whose provider response body is literally "Aborted" would be suppressed even though
 * it is a genuine, possibly non-retryable failure. `session.error` arrives over SSE
 * as JSON with `name` preserved, so detection keys solely on the typed name.
 */
export function isAbortError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== "object") return false
  return (err as { name?: unknown }).name === "MessageAbortedError"
}

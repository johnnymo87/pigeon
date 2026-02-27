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

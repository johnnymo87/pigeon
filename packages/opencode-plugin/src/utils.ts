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

/** Extract a human-readable message string from an unknown error value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

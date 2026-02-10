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

export class StorageError extends Error {
  constructor(
    public op: string,
    public cause: unknown,
  ) {
    super(
      `D1 storage error in ${op}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "StorageError";
  }
}

/**
 * Wrap a SINGLE awaited D1 promise. Any throw is classified as a D1 storage error
 * by CALL SITE (deterministic + miniflare-testable), never by inspecting err shape.
 */
export async function withD1<T>(op: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new StorageError(op, err);
  }
}

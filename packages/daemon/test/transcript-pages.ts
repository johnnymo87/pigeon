/**
 * Test adapter: serve opencode's paged `GET /session/:id/message?limit&before`
 * from a function returning the WHOLE transcript (chronological), the shape the
 * watchdog tests were written against.
 *
 * Mirrors the real server: newest `limit` messages older than the cursor, in
 * chronological order, and a cursor only when something older remains (opencode
 * reads limit+1 rows, so a final page of exactly `limit` carries none). The
 * cursor is the index of the oldest message returned. A rejection from `getAll`
 * propagates unchanged, so `getSessionMessages failed (404)` mocks keep working.
 */
export function pagesFrom(
  getAll: (sessionId: string) => Promise<unknown[]>,
): (
  sessionId: string,
  opts: { limit: number; before?: string },
) => Promise<{ messages: unknown[]; nextCursor: string | null }> {
  return async (sessionId, opts) => {
    const all = await getAll(sessionId);
    const end = opts.before === undefined ? all.length : Number(opts.before);
    const start = Math.max(0, end - opts.limit);
    return {
      messages: all.slice(start, end),
      nextCursor: start > 0 ? String(start) : null,
    };
  };
}

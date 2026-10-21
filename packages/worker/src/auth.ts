/**
 * Bearer authentication lives in `credentials.ts` (`authenticate`), which accepts both the
 * shared `CCR_API_KEY` and per-machine keys (pigeon-k0qn.8). There is deliberately no
 * shared-key-only check left here: a route that used one would refuse every daemon that
 * has moved to its own key.
 */

/**
 * Returns a 401 JSON response.
 */
export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

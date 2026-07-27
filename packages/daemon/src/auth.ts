/** Returns a 401 Response if the request needs auth and the bearer is missing/wrong; null if OK.
 *  Auth is DISABLED when authToken is falsy (back-compat).
 *  When enabled, ALL endpoints require auth except the explicit anonymous allowlist (GET /health).
 */
export function checkAuth(request: Request, url: URL, authToken: string | undefined): Response | null {
  if (!authToken) return null;

  // Anonymous allowlist: EXACTLY GET /health is permitted without auth for liveness probing.
  // Health checks leak no state ({ ok: true, service: "pigeon-daemon" }) and are required
  // by process managers / load balancers that do not carry authorization tokens.
  const isAnonymousAllowed = request.method === "GET" && url.pathname === "/health";
  if (isAnonymousAllowed) return null;

  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${authToken}`) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

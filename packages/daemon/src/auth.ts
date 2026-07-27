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

  // Self-describing 401. A bare {"error":"unauthorized"} gives the caller no path
  // from symptom to fix, and the most common cause is not "wrong token" but "this
  // client's code predates auth and sends no header at all" -- which reads as a
  // broken daemon. Two people hit exactly that during rollout and neither could
  // reason from the 401 back to the cause.
  //
  // Disclosure is a non-issue here: the daemon is loopback-only, every process on
  // the box runs as the same uid and can already read the secret, and the path is
  // documented in the repo's skills. Naming it costs nothing and saves a search.
  return Response.json(
    {
      error: "unauthorized",
      hint:
        "missing or invalid 'Authorization: Bearer <token>'. When auth is enabled the token is " +
        "at /run/secrets/pigeon_daemon_auth_token (readable by the dev user, no sudo). A long-running " +
        "client whose code was loaded before auth was enabled sends no header at all and must be " +
        "restarted to pick up token support.",
    },
    { status: 401 },
  );
}

/** Returns a 401 Response if the request needs auth and the bearer is missing/wrong; null if OK.
 *  Auth is DISABLED when authToken is falsy (back-compat). Protected = POST/DELETE methods + GET /route. */
export function checkAuth(request: Request, url: URL, authToken: string | undefined): Response | null {
  if (!authToken) return null;
  const needsAuth =
    request.method === "POST" ||
    request.method === "DELETE" ||
    (request.method === "GET" && url.pathname === "/route");
  if (!needsAuth) return null;
  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${authToken}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

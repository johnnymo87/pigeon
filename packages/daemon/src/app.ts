const HEALTH_PAYLOAD = {
  ok: true,
  service: "pigeon-daemon",
} as const;

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(HEALTH_PAYLOAD);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

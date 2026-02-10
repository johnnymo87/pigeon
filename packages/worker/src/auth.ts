/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

/**
 * Verify the API key from the Authorization header.
 * Expects: `Authorization: Bearer <key>`
 */
export function verifyApiKey(request: Request, expectedKey: string): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) return false;
  return timingSafeEqual(parts[1], expectedKey);
}

/**
 * Returns a 401 JSON response.
 */
export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

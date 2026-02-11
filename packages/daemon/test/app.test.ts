import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/app";

describe("handleRequest", () => {
  it("returns health payload", async () => {
    const response = await handleRequest(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "pigeon-daemon" });
  });

  it("returns not found for unknown routes", async () => {
    const response = await handleRequest(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

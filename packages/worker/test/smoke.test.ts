import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";

describe("worker smoke test", () => {
  it("health endpoint returns ok", async () => {
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("has required env bindings", () => {
    expect(env.ROUTER).toBeDefined();
  });
});

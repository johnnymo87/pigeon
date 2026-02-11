import { describe, expect, it } from "vitest";
import { buildWorkerWebSocketUrl } from "../src/worker/machine-agent";

describe("buildWorkerWebSocketUrl", () => {
  it("converts http worker URL to ws URL", () => {
    expect(buildWorkerWebSocketUrl("http://localhost:8787", "devbox-1")).toBe(
      "ws://localhost:8787/ws?machineId=devbox-1",
    );
  });

  it("converts https worker URL to wss URL and encodes machine id", () => {
    expect(buildWorkerWebSocketUrl("https://worker.example.com", "machine alpha")).toBe(
      "wss://worker.example.com/ws?machineId=machine%20alpha",
    );
  });
});

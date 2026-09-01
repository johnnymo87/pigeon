import type { AcpTransport, AcpTransportFactory } from "./acp-client.js";

/**
 * The real socket behind {@link AcpTransport}, on node's global WebSocket
 * (node >= 22). Deliberately thin: it owns framing and nothing else, so that
 * every delivery decision lives in `acp-client.ts` where it is testable without
 * a socket, a serve, or a model.
 *
 * Not unit-tested, by design -- there is nothing here to assert that would not
 * just be asserting node's WebSocket. It is exercised end to end against a real
 * `goose serve` by `scripts/goose-acp-probe.ts`.
 */
export function webSocketTransport(authToken?: string): AcpTransportFactory {
  return async (url: string): Promise<AcpTransport> => {
    const ws = new WebSocket(url, authToken ? { headers: { Authorization: `Bearer ${authToken}` } } as never : undefined);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = (): void => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`failed to open goose acp socket at ${url}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErr, { once: true });
    });
    return {
      send: (data) => ws.send(data),
      onMessage: (cb) => ws.addEventListener("message", (ev) => cb(String(ev.data))),
      onClose: (cb) => ws.addEventListener("close", (ev) => cb(ev.code, ev.reason)),
      close: () => ws.close(),
    };
  };
}

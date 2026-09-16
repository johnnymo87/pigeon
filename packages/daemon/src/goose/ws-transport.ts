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
/**
 * Authenticates by QUERY PARAMETER, not by header, and the distinction is not
 * cosmetic. Measured against goose 1.48.0:
 *
 *   ?token=<secret>            HTTP POST 200, WS upgrade 101
 *   X-Secret-Key: <secret>     HTTP POST 200
 *   Authorization: Bearer ...  401 on both
 *
 * This previously sent `Authorization: Bearer`, which goose has never accepted,
 * and it did so through an `as never` cast because the standard WebSocket
 * constructor has no `headers` option at all -- so the credential was both the
 * wrong scheme AND smuggled through a hole in the type system. It went unnoticed
 * because the only thing exercising this file, `scripts/goose-acp-probe.ts`, runs
 * its serve with `--dangerously-unauthenticated`, where any credential "works".
 *
 * The query parameter is also the only form that works identically on the HTTP
 * and WebSocket transports, so authentication no longer depends on whether a
 * given runtime honours a non-standard option on its WebSocket constructor.
 */
export function webSocketTransport(authToken?: string): AcpTransportFactory {
  return async (url: string): Promise<AcpTransport> => {
    const ws = new WebSocket(authToken ? withToken(url, authToken) : url);
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

/**
 * Adds `token` to a URL's query string, preserving any parameters already there.
 * Uses the URL parser rather than string concatenation so that a url which
 * already carries a query (or a fragment) does not silently produce a malformed
 * one -- the failure mode there would be a 401 that looks like a bad secret.
 *
 * Exported only so the query-preserving behaviour can be asserted without a
 * socket; nothing outside this module should need it.
 */
export function withToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

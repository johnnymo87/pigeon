/**
 * `CommandDeliveryAdapter` for goose sessions.
 *
 * This is a thin policy layer. The turn lifecycle lives in `GooseSessionRunner`,
 * because an adapter is constructed fresh for every command and cannot hold state
 * that outlives one delivery; what lives HERE is the decision the delivery
 * contract asks for, which is how a failure should be classified.
 *
 * The contract is set out in full in `../adapters/types.ts`. Its two load-bearing
 * rules and how this adapter satisfies them:
 *
 *   `failurePolicy: "surface"` -- opts out of the string-classifying failure
 *   machinery. That machinery reads "fetch failed"/"econnrefused" as proof the
 *   opencode plugin has died and DELETES the session row, its routing assignment
 *   and its Telegram topic. Those strings mean nothing of the kind coming from a
 *   goose socket, and a blip must not cost the human their session mapping. The
 *   test suite pins this field, because forgetting it fails silently and
 *   destructively.
 *
 *   Throw ONLY before the send. Redelivery re-runs `deliverCommand` from the top,
 *   so a throw after the prompt has gone would issue a second prompt into a live
 *   turn. Concretely: an unreachable endpoint throws (nothing was sent, and the
 *   60s lease lapse is the retry); a bad token or a wrong port returns ok:false
 *   (permanent -- retrying a 401 every 60s until the command expires a day later
 *   helps nobody); anything at or after the prompt returns ok:false.
 *
 * The preflight is what makes that distinction decidable at all: node's WebSocket
 * collapses a 401 and a refused connection into the same error event, so without
 * an HTTP probe first this adapter could not tell a wrong password from a dead
 * server -- which is exactly the discrimination the contract demands.
 */
import type {
  CommandDeliveryAdapter,
  CommandDeliveryContext,
  CommandDeliveryResult,
} from "../adapters/types.js";
import type { SessionRecord } from "../storage/types.js";
import { classifyReachability, type Reachability } from "./preflight.js";
import type { GooseSessionRunner } from "./session-runner.js";

export interface GooseAcpAdapterOptions {
  /** Resolves (creating if needed) the long-lived runner for this session. */
  runnerFor: (session: SessionRecord) => GooseSessionRunner;
  /** Injected for tests; defaults to the real HTTP probe. */
  reachability?: (url: string, token: string) => Promise<Reachability>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class GooseAcpAdapter implements CommandDeliveryAdapter {
  readonly name = "goose-acp";

  /**
   * See the class comment. This is not decoration: without it a goose session
   * inherits the opencode delete-on-connection-error path.
   */
  readonly failurePolicy = "surface" as const;

  constructor(private readonly opts: GooseAcpAdapterOptions) {}

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    const endpoint = session.backendEndpoint;
    if (!endpoint) {
      return {
        ok: false,
        error: "this goose session has no endpoint recorded, so pigeon cannot reach it",
      };
    }

    if (context.media) {
      // Saying so beats silently dropping it: the ACP prompt surface this client
      // is allowed to use carries text only, and a caption-less photo would
      // otherwise arrive as a placeholder describing a file goose never got.
      return {
        ok: false,
        error: "file attachments are not supported for goose sessions yet",
      };
    }

    const probe = this.opts.reachability ?? classifyReachability;
    // An absent token becomes an empty one deliberately, and both outcomes are
    // then correct: a serve running --dangerously-unauthenticated answers 406
    // (reachable), and an authenticated one answers 401 (auth-failed). Guessing
    // which we are talking to is exactly what the probe is for.
    const reach = await probe(endpoint, session.backendAuthToken ?? "");

    switch (reach.kind) {
      case "auth-failed":
        // Permanent by nature. Throwing would retry a rejected credential every
        // 60s until the command expired, and no amount of retrying fixes a token.
        return {
          ok: false,
          error: `goose rejected pigeon's token for ${endpoint}. Check the session's stored token against the serve's GOOSE_SERVER__SECRET_KEY.`,
          meta: { reach: reach.kind },
        };
      case "not-goose":
        return {
          ok: false,
          error: `${endpoint} answered like something other than a goose serve (HTTP ${reach.status}). Check the port.`,
          meta: { reach: reach.kind, status: reach.status },
        };
      case "unreachable":
        // Nothing was sent, so a throw is safe and is the retry: the poller skips
        // the ack, the 60s lease lapses, and the command comes back.
        // KNOWN GAP, inherited deliberately: nothing caps that loop, so a
        // black-holed host retries until the command expires. Capping needs an
        // attempt counter the delivery context does not carry yet.
        throw new Error(`goose serve unreachable at ${endpoint}: ${reach.cause}`);
      case "ok":
        break;
    }

    const runner = this.opts.runnerFor(session);
    return runner.deliver(context.commandId, command);
  }

  // deliverQuestionReply is deliberately NOT implemented. The question-reply path
  // still string-classifies failures and throws independently of failurePolicy,
  // so a "surface" adapter must not offer it until that path is gated too --
  // stated as a precondition in adapters/types.ts.
}

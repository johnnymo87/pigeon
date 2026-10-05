import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import type {
  CommandDeliveryAdapter,
  CommandDeliveryContext,
  CommandDeliveryResult,
} from "./types";

/**
 * `backend_kind` for a client that CANNOT BE PUSHED TO and must collect its own
 * mail.
 *
 * The motivating client is a scheduled, one-shot agent episode: it exists for
 * the length of one run, and while it is idle there is no HTTP server to POST a
 * prompt to. Pigeon's inbound half assumes the opposite (delivery ultimately
 * reaches opencode via `POST {backend}/session/{id}/prompt_async`).
 */
export const PULL_BACKEND_KIND = "goose-pull";

export function isPullBackend(session: Pick<SessionRecord, "backendKind"> | null | undefined): boolean {
  return session?.backendKind === PULL_BACKEND_KIND;
}

export interface GoosePullAdapterDeps {
  storage: StorageDb;
  /**
   * Telegram user ids whose messages may be banked. Must be non-empty:
   * `selectAdapter` returns no adapter at all for a pull session when it is
   * empty, so the human gets the ordinary "not reachable" reply.
   */
  allowedSenderIds: ReadonlySet<string>;
  nowFn?: () => number;
}

/** Longest bot message kept as context for a reply. */
export const IN_REPLY_TO_MAX_CHARS = 500;

/**
 * Banks inbound for a pull-mode session instead of pushing it.
 *
 * WHAT THIS DELIBERATELY IS NOT: a fake push. An earlier design had a goose
 * backend whose `sendPrompt` enqueued, which would have made the swarm arbiter
 * mark the row `handed_off` -- "the target received it" everywhere in
 * swarm-repo.ts -- and the delivery watchdog would then have fetched a transcript
 * from serves that never owned the session, taken a 404 second opinion, concluded
 * "session truly gone", marked the row FAILED and told the sender so, five
 * minutes before the client successfully read the payload. A false terminal
 * record on a message that arrives. Banking is a different act with a different
 * name and its own state, so nothing downstream is told a delivery happened.
 *
 * The success path returns `meta.banked`, which `command-ingest` turns into a
 * user-visible notice. That is not decoration: Telegram has already toasted
 * "Command sent", and for this backend that is false by as much as days.
 */
export class GoosePullAdapter implements CommandDeliveryAdapter {
  readonly name = "goose-pull";
  /**
   * Its errors mean nothing to the opencode revive/delete machinery: a refusal
   * here is a policy answer, never a dead plugin. This is also what lets
   * isOpencodeRoutable refuse the kind without tripping the invariant test.
   * Deliberately no deliverQuestionReply (see the interface note on
   * failurePolicy, and /question-asked refusing pull sessions).
   */
  readonly failurePolicy = "surface" as const;

  private readonly storage: StorageDb;
  private readonly allowedSenderIds: ReadonlySet<string>;
  private readonly nowFn: () => number;

  constructor(deps: GoosePullAdapterDeps) {
    this.storage = deps.storage;
    this.allowedSenderIds = deps.allowedSenderIds;
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    // WHO, first. Banked text is input to a client nobody watches while it runs,
    // and the worker's chat allowlist admits every member of an allowed group
    // chat. A missing sender id fails closed: it is what a button tap or an
    // older worker produces, and neither is evidence of the owner.
    const senderId = context.senderId;
    if (!senderId || !this.allowedSenderIds.has(senderId)) {
      return {
        ok: false,
        error: "this session only accepts messages from its owner's Telegram account",
      };
    }
    // The allowlist proves who SENT a message, not who wrote it.
    if (context.forwarded) {
      return {
        ok: false,
        error: "forwarded messages are not accepted by this session; type the reply yourself",
      };
    }
    // The client reads text. Banking a file reference it cannot open would be a
    // message it silently never saw, announced to the human as delivered.
    if (context.media) {
      return {
        ok: false,
        error: "this session reads text only; send the message as text",
      };
    }
    const inReplyTo = context.inReplyTo?.trim()
      ? context.inReplyTo.trim().slice(0, IN_REPLY_TO_MAX_CHARS)
      : null;
    const inReplyToQuote = context.inReplyToQuote?.trim()
      ? context.inReplyToQuote.trim().slice(0, IN_REPLY_TO_MAX_CHARS)
      : null;
    return this.bank(session, {
      // Derived from commandId, never minted fresh. `command-ingest` explicitly
      // re-runs unfinished commands ("retry unfinished commandId=..."), so a
      // random id would put a second copy of the human's message in front of the
      // agent on any partially-completed ingest.
      msgId: `pull:${context.commandId}`,
      source: "telegram-reply",
      payload: command,
      senderId,
      inReplyTo,
      inReplyToQuote,
      chatId: context.chatId,
    });
  }

  private bank(
    session: SessionRecord,
    input: {
      msgId: string;
      source: "telegram-reply";
      payload: string;
      senderId: string;
      inReplyTo: string | null;
      inReplyToQuote: string | null;
      chatId?: string | number;
    },
  ): CommandDeliveryResult {
    // Belt and braces behind selectAdapter. This adapter is the only writer to
    // the bank, and a bank keyed on a session id that no drain will ever ask for
    // is mail that is written, never read, and never noticed.
    if (!isPullBackend(session)) {
      return {
        ok: false,
        error: `session ${session.sessionId} is not a ${PULL_BACKEND_KIND} backend`,
      };
    }

    const payload = input.payload.trim();
    if (!payload) {
      // Fail rather than bank a blank. An empty row still costs the human an
      // episode's attention and tells them nothing; the failure is visible.
      return { ok: false, error: "refusing to bank an empty payload" };
    }

    const fresh = this.storage.pullInbox.bank(
      {
        msgId: input.msgId,
        sessionId: session.sessionId,
        source: input.source,
        payload,
        senderId: input.senderId,
        inReplyTo: input.inReplyTo,
        inReplyToQuote: input.inReplyToQuote,
        chatId: input.chatId === undefined ? null : String(input.chatId),
      },
      this.nowFn(),
    );

    return {
      ok: true,
      meta: {
        banked: true,
        msgId: input.msgId,
        // False on the idempotent re-run of an already-banked command. Carried so
        // a log can distinguish "banked now" from "was already banked", which is
        // the difference between a working ingest and a retry loop.
        fresh,
      },
    };
  }
}

/**
 * The notice the human gets when their message is banked rather than delivered.
 *
 * Says WHEN, in the only terms the daemon actually knows. It deliberately does
 * not quote a cadence: the daemon has no idea when the client next runs, and an
 * invented number is how a true statement becomes a false one.
 */
export function bankedReplyMessage(session: SessionRecord): string {
  const name = session.label || session.title || session.sessionId;
  return (
    `Banked for ${name} — this session is not running continuously, so it reads its ` +
    `messages when it next runs, not immediately.`
  );
}

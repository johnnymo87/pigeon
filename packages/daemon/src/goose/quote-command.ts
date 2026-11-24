import { GOOSE_BACKEND_KIND } from "./backend-kind";
import { backendSessionIdOf, type SessionRecord } from "../storage/types";
import { coordinatorProgramOf } from "../tag-key";
import { displayName } from "../notification-service";
import { excerptOf } from "../text";
import { splitChatMessage } from "../split-message";
import {
  QuoteUnsupportedError,
  isValidQuoteMetadata,
  type QuoteRequest,
  type QuoteResult,
  type StoredQuote,
} from "./quote-types";
import {
  capPassages,
  emptyText,
  flattenPassages,
  pickLabel,
  quoteBodyMarkdown,
  quoteBodyText,
} from "./quote-render";
import type { QuoteMessage } from "../worker/poller";
import type { UpsertOutboxInput } from "../storage/outbox-repo";

export interface QuoteClient {
  isHonk: boolean;
  connect(): Promise<void>;
  quote(req: QuoteRequest, opts?: { timeoutMs?: number }): Promise<QuoteResult>;
  close(): void;
}

export interface QuoteHandlerDeps {
  getSession: (id: string) => SessionRecord | null;
  createClient: (url: string, token?: string) => QuoteClient;
  reply?: (text: string, msg?: QuoteMessage) => Promise<void> | void;
  sendChatReply?: (msg: QuoteMessage, text: string) => Promise<void> | void;
  upsertOutbox: (input: UpsertOutboxInput, now?: number) => void;
  machineId: string;
  now?: () => number;
  log?: (msg: string, ...args: unknown[]) => void;
}

const COMMAND_DEDUPE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function sendReply(
  text: string,
  msg: QuoteMessage,
  deps: QuoteHandlerDeps,
): Promise<void> {
  if (deps.reply) {
    await deps.reply(text, msg);
  } else if (deps.sendChatReply) {
    await deps.sendChatReply(msg, text);
  }
}

export function createQuoteHandler(
  deps: QuoteHandlerDeps,
): (msg: QuoteMessage) => Promise<void> {
  const seenCommandIds = new Map<string, number>();
  const nowFn = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string, ...args: unknown[]) => console.log(`[quote-command] ${m}`, ...args));

  async function run(msg: QuoteMessage): Promise<void> {
    const session = deps.getSession(msg.sessionId);
    if (!session) {
      await sendReply("Session not found", msg, deps);
      return;
    }

    if (session.backendKind !== GOOSE_BACKEND_KIND) {
      await sendReply("/quote works only for goose sessions for now.", msg, deps);
      return;
    }

    if (!session.backendEndpoint) {
      await sendReply(`Session ${msg.sessionId} has no backendEndpoint.`, msg, deps);
      return;
    }

    const coord = coordinatorProgramOf(session);
    const tag = coord && "program" in coord ? coord.program : undefined;

    const client = deps.createClient(
      session.backendEndpoint,
      session.backendAuthToken ?? undefined,
    );

    let result: QuoteResult;
    try {
      await client.connect();
      if (!client.isHonk) {
        await sendReply(
          "this session is on bare goose, not honkd; /quote needs honkd",
          msg,
          deps,
        );
        return;
      }

      result = await client.quote(
        {
          sessionId: backendSessionIdOf(session),
          pick: msg.metadata!.pick,
          full: msg.metadata!.full,
          ...(tag ? { tag } : {}),
          quoteId: msg.commandId,
        },
        { timeoutMs: 600_000 },
      );
    } catch (err) {
      if (err instanceof QuoteUnsupportedError) {
        await sendReply(
          `honkd on ${deps.machineId} does not support /quote yet (needs honk-9qf.31.7).`,
          msg,
          deps,
        );
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendReply(`/quote failed: ${errMsg}`, msg, deps);
      }
      return;
    } finally {
      try {
        client.close();
      } catch {
        // closing client is safe to ignore
      }
    }

    const pLabel = pickLabel(msg.metadata!.pick, msg.metadata!.full);

    if (result.empty) {
      await sendReply(emptyText(result, pLabel), msg, deps);
      return;
    }

    const flattened = flattenPassages(result);
    if (flattened.length === 0) {
      await sendReply(emptyText(result, pLabel), msg, deps);
      return;
    }

    const label = displayName({
      title: session.title,
      label: session.label,
      boundTopicKey: session.boundTopicKey,
      sessionId: session.sessionId,
    });

    const bodyText = quoteBodyText(result, pLabel, label);
    const chunks = splitChatMessage(
      { text: "", entities: [] },
      { text: bodyText, entities: [] },
      { text: "", entities: [] },
    );
    const richMarkdown = quoteBodyMarkdown(result, pLabel, label);

    const bodyNotificationId = `qt:${session.sessionId}:${msg.commandId}`;
    const bodyPayload = {
      messages: chunks.map((c) => ({ text: c.text, entities: c.entities })),
      title: session.title ?? undefined,
      dir: session.cwd ?? undefined,
      threaded: true,
      ...(richMarkdown !== null
        ? { rich: { markdown: richMarkdown, dialect: "slack" as const } }
        : {}),
    };

    const nowTime = nowFn();

    deps.upsertOutbox(
      {
        notificationId: bodyNotificationId,
        sessionId: session.sessionId,
        requestId: `quote-body-${session.sessionId}-${msg.commandId}`,
        kind: "quote",
        payload: JSON.stringify(bodyPayload),
        token: "",
        excerpt: excerptOf(bodyText),
      },
      nowTime,
    );

    const { passages: cappedPassages, total } = capPassages(flattened);
    const storedQuote: StoredQuote = {
      v: 1,
      sessionId: session.sessionId,
      passages: cappedPassages,
      total,
    };

    const k = cappedPassages.length;
    let answerText = `✍️ Answer ${k} passage(s) from this /quote`;
    if (total > cappedPassages.length) {
      answerText += ` — the first ${cappedPassages.length} of ${total}`;
    }

    const answerNotificationId = `qa:${session.sessionId}:${msg.commandId}`;
    const answerPayload = {
      messages: [{ text: answerText }],
      title: session.title ?? undefined,
      dir: session.cwd ?? undefined,
      threaded: true,
      replyMarkup: {
        inline_keyboard: [
          [{ text: "Answer", callback_data: `quote:${msg.commandId}` }],
        ],
      },
      quote: storedQuote,
    };

    deps.upsertOutbox(
      {
        notificationId: answerNotificationId,
        sessionId: session.sessionId,
        requestId: `quote-answer-${session.sessionId}-${msg.commandId}`,
        kind: "quote",
        payload: JSON.stringify(answerPayload),
        token: "",
        afterNotificationId: bodyNotificationId,
        excerpt: excerptOf(answerText),
      },
      nowTime,
    );
  }

  return async (msg: QuoteMessage): Promise<void> => {
    const now = nowFn();
    for (const [id, ts] of seenCommandIds.entries()) {
      if (now - ts > COMMAND_DEDUPE_TTL_MS) {
        seenCommandIds.delete(id);
      }
    }

    if (seenCommandIds.has(msg.commandId)) {
      log(`ignoring duplicate quote command ${msg.commandId}`);
      return;
    }
    seenCommandIds.set(msg.commandId, now);

    if (!isValidQuoteMetadata(msg.metadata)) {
      try {
        await sendReply("Malformed /quote", msg, deps);
      } catch (err) {
        log(
          `failed to reply for malformed quote: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    void run(msg).catch((err) => {
      log(
        `unhandled error in /quote handler: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
}

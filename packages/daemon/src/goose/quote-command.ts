import { GOOSE_BACKEND_KIND } from "./backend-kind";
import { backendSessionIdOf, type SessionRecord } from "../storage/types";
import { coordinatorProgramOf } from "../tag-key";
import { displayName } from "../notification-service";
import { excerptOf } from "../text";
import { splitChatMessage } from "../split-message";
import { withDeadline } from "./deadline";
import { NON_TURN_TIMEOUT_MS } from "./session-runner";
import {
  QuoteUnsupportedError,
  isValidQuoteMetadata,
  type QuoteRequest,
  type QuoteResult,
  type StoredQuote,
} from "./quote-types";
import {
  capPassages,
  defuseBroadcasts,
  emptyText,
  flattenPassages,
  formatUnmatchedNotesPlain,
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

function withPreservedNotes(text: string, notes: string | undefined): string {
  if (!notes) return text;
  return `${text}\n\nYour notes (copy before retrying):\n${defuseBroadcasts(notes)}`;
}

export function createQuoteHandler(
  deps: QuoteHandlerDeps,
): (msg: QuoteMessage) => Promise<void> {
  const seenCommandIds = new Map<string, number>();
  const nowFn = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string, ...args: unknown[]) => console.log(`[quote-command] ${m}`, ...args));

  async function run(msg: QuoteMessage): Promise<void> {
    const notes =
      typeof msg.metadata!.notes === "string" && msg.metadata!.notes.trim() !== ""
        ? msg.metadata!.notes.trim()
        : undefined;

    const session = deps.getSession(msg.sessionId);
    if (!session) {
      await sendReply(withPreservedNotes("Session not found", notes), msg, deps);
      return;
    }

    if (session.backendKind !== GOOSE_BACKEND_KIND) {
      await sendReply(
        withPreservedNotes("/quote works only for goose sessions for now.", notes),
        msg,
        deps,
      );
      return;
    }

    if (!session.backendEndpoint) {
      await sendReply(
        withPreservedNotes(`Session ${msg.sessionId} has no backendEndpoint.`, notes),
        msg,
        deps,
      );
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
      await withDeadline(client.connect(), NON_TURN_TIMEOUT_MS, "connect");
      if (!client.isHonk) {
        await sendReply(
          withPreservedNotes("this session is on bare goose, not honkd; /quote needs honkd", notes),
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
          ...(notes ? { notes } : {}),
          ...(tag ? { tag } : {}),
          quoteId: msg.commandId,
        },
        { timeoutMs: 600_000 },
      );
    } catch (err) {
      if (err instanceof QuoteUnsupportedError) {
        await sendReply(
          withPreservedNotes(
            `honkd on ${deps.machineId} does not support /quote yet (needs honk-9qf.31.7).`,
            notes,
          ),
          msg,
          deps,
        );
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        await sendReply(withPreservedNotes(`/quote failed: ${errMsg}`, notes), msg, deps);
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

    // Deploy-skew guard: honkd with honk-9qf.31.8 guarantees that whenever non-empty notes are
    // sent, either at least one passage has a non-empty prefill or unmatchedNotes is non-empty.
    // If neither came back, an older honkd ignored `notes`; preserve them so nothing is lost.
    const hasAnyPrefill = result.replies.some(
      (r) =>
        Array.isArray(r.prefills) &&
        r.prefills.some((p) => typeof p === "string" && p.trim() !== ""),
    );
    const rawUnmatched = (result.unmatchedNotes ?? []).filter((n) => n.trim() !== "");
    let effectiveResult = result;
    let effectiveUnmatched = rawUnmatched;
    if (notes && !hasAnyPrefill && rawUnmatched.length === 0) {
      effectiveResult = {
        ...result,
        warnings: [
          ...result.warnings,
          `honkd on ${deps.machineId} did not match your notes (may need update); carried them into the Answer form.`,
        ],
        unmatchedNotes: [notes],
      };
      effectiveUnmatched = [notes];
    }

    const flattened = flattenPassages(effectiveResult);
    const nowTime = nowFn();

    if (effectiveResult.empty || flattened.length === 0) {
      if (effectiveUnmatched.length === 0) {
        await sendReply(emptyText(effectiveResult, pLabel), msg, deps);
        return;
      }

      const emptyBodyText = `${emptyText(effectiveResult, pLabel)}\n\n${formatUnmatchedNotesPlain(effectiveUnmatched)}`;
      const emptyChunks = splitChatMessage(
        { text: "", entities: [] },
        { text: emptyBodyText, entities: [] },
        { text: "", entities: [] },
      );
      const bodyNotificationId = `qt:${session.sessionId}:${msg.commandId}`;
      deps.upsertOutbox(
        {
          notificationId: bodyNotificationId,
          sessionId: session.sessionId,
          requestId: `quote-body-${session.sessionId}-${msg.commandId}`,
          kind: "quote",
          payload: JSON.stringify({
            messages: emptyChunks.map((c) => ({ text: c.text, entities: c.entities })),
            title: session.title ?? undefined,
            dir: session.cwd ?? undefined,
            threaded: true,
          }),
          token: "",
          excerpt: excerptOf(emptyBodyText),
        },
        nowTime,
      );

      const storedQuote: StoredQuote = {
        v: 1,
        sessionId: session.sessionId,
        passages: [],
        total: 0,
        unmatchedNotes: effectiveUnmatched,
        ...(notes ? { notesRaw: notes } : {}),
      };
      const answerText = `✍️ Send ${effectiveUnmatched.length} unmatched note(s) from this /quote`;
      const answerNotificationId = `qa:${session.sessionId}:${msg.commandId}`;
      deps.upsertOutbox(
        {
          notificationId: answerNotificationId,
          sessionId: session.sessionId,
          requestId: `quote-answer-${session.sessionId}-${msg.commandId}`,
          kind: "quote",
          payload: JSON.stringify({
            messages: [{ text: answerText }],
            title: session.title ?? undefined,
            dir: session.cwd ?? undefined,
            threaded: true,
            replyMarkup: {
              inline_keyboard: [[{ text: "Answer", callback_data: `quote:${msg.commandId}` }]],
            },
            quote: storedQuote,
          }),
          token: "",
          afterNotificationId: bodyNotificationId,
          excerpt: excerptOf(answerText),
        },
        nowTime,
      );
      return;
    }

    const label = displayName({
      title: session.title,
      label: session.label,
      boundTopicKey: session.boundTopicKey,
      sessionId: session.sessionId,
    });

    const bodyText = quoteBodyText(effectiveResult, pLabel, label);
    const chunks = splitChatMessage(
      { text: "", entities: [] },
      { text: bodyText, entities: [] },
      { text: "", entities: [] },
    );
    const richMarkdown = quoteBodyMarkdown(effectiveResult, pLabel, label);

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

    const { passages: cappedPassages, total, droppedPrefills } = capPassages(flattened);
    const allUnmatched = [...effectiveUnmatched, ...droppedPrefills];
    const storedQuote: StoredQuote = {
      v: 1,
      sessionId: session.sessionId,
      passages: cappedPassages,
      total,
      ...(allUnmatched.length > 0 ? { unmatchedNotes: allUnmatched } : {}),
      ...(notes ? { notesRaw: notes } : {}),
    };

    const k = cappedPassages.length;
    const prefilledCount = cappedPassages.filter(
      (p) => typeof p.prefill === "string" && p.prefill.trim() !== "",
    ).length;
    let answerText = `✍️ Answer ${k} passage(s) from this /quote`;
    if (total > cappedPassages.length) {
      answerText += ` — the first ${cappedPassages.length} of ${total}`;
    }
    const detailParts: string[] = [];
    if (prefilledCount > 0) detailParts.push(`${prefilledCount} prefilled`);
    if (allUnmatched.length > 0) {
      detailParts.push(
        `${allUnmatched.length} unmatched note${allUnmatched.length === 1 ? "" : "s"}`,
      );
    }
    if (detailParts.length > 0) {
      answerText += ` (${detailParts.join(", ")})`;
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

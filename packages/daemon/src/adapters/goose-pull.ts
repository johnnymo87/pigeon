import type { StorageDb } from "../storage/database";
import type { SessionRecord } from "../storage/types";
import type {
  CommandDeliveryAdapter,
  CommandDeliveryContext,
  CommandDeliveryResult,
  QuestionReplyInput,
} from "./types";

/**
 * `backend_kind` for a client that CANNOT BE PUSHED TO and must collect its own
 * mail.
 *
 * The motivating client is a `goose run --recipe` episode under systemd
 * `Type=oneshot`: it exists for the length of one episode, holds a flock, and
 * while it runs there is no HTTP server to POST a prompt to. Pigeon's entire
 * inbound half assumes the opposite (delivery ultimately reaches opencode via
 * `POST {backend}/session/{id}/prompt_async`), and that mismatch -- not anything
 * about goose's hook API -- is the real gap between the two integrations.
 */
export const PULL_BACKEND_KIND = "goose-pull";

export function isPullBackend(session: Pick<SessionRecord, "backendKind"> | null | undefined): boolean {
  return session?.backendKind === PULL_BACKEND_KIND;
}

export interface GoosePullAdapterDeps {
  storage: StorageDb;
  nowFn?: () => number;
}

/**
 * Renders a question answer as the text a human would have typed.
 *
 * `answers` is `string[][]` -- one inner array per wizard step. The client needs
 * prose it can put in front of a model, not a JSON shape, and it separately gets
 * `question_request_id` to decide whether the answer is still relevant. Steps are
 * joined with a separator rather than concatenated so a two-step answer cannot
 * read as one run-on sentence.
 */
export function renderAnswerPayload(answers: readonly (readonly string[])[]): string {
  return answers
    .map((step) => step.join(", "))
    .filter((step) => step.trim().length > 0)
    .join(" | ");
}

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
 * "Command sent", and for this backend that is false by as much as ~68 hours.
 */
export class GoosePullAdapter implements CommandDeliveryAdapter {
  readonly name = "goose-pull";

  private readonly storage: StorageDb;
  private readonly nowFn: () => number;

  constructor(deps: GoosePullAdapterDeps) {
    this.storage = deps.storage;
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    return this.bank(session, {
      // Derived from commandId, never minted fresh. `command-ingest` explicitly
      // re-runs unfinished commands ("retry unfinished commandId=..."), so a
      // random id would put a second copy of the human's message in front of the
      // agent on any partially-completed ingest.
      msgId: `pull:${context.commandId}`,
      source: "telegram-reply",
      payload: command,
      chatId: context.chatId,
    });
  }

  async deliverQuestionReply(
    session: SessionRecord,
    reply: QuestionReplyInput,
    context: CommandDeliveryContext,
  ): Promise<CommandDeliveryResult> {
    const payload = renderAnswerPayload(reply.answers);
    return this.bank(session, {
      msgId: `pull:${context.commandId}`,
      source: "question-answer",
      payload,
      questionRequestId: reply.questionRequestId,
      answerKind: this.classifyAnswer(session.sessionId, reply),
      chatId: context.chatId,
    });
  }

  /**
   * Is this actually an answer, or an unrelated message a pending question
   * captured?
   *
   * MEASURED, NOT THEORISED, 2026-08-31 on a live daemon: while a question is
   * pending, command-ingest routes EVERY plain message to that session into the
   * question-reply path -- its own comment says "a live row hijacks EVERY plain
   * message to the session". So an ordinary Telegram message sent inside the 4h
   * TTL arrives here labelled as the answer to a question it never saw, and it
   * consumes the pending row, so a later button press is refused as stale. The
   * text is preserved either way; the LABEL is what lies, and a client that has
   * been told to validate answers against still-open questions would believe it.
   *
   * The discriminator is the question's own option labels: a rendered button
   * press resolves to one of them by construction (command-ingest maps an option
   * token to `options[i].label`), and free text almost never collides with one.
   * Reported rather than acted on -- refusing free text here would throw away
   * genuinely typed answers, which are legitimate.
   */
  private classifyAnswer(
    sessionId: string,
    reply: QuestionReplyInput,
  ): "option" | "free-text" {
    // Including expired: the row survives its TTL precisely so a late answer can
    // still be matched, and this classification wants the same evidence.
    const pending = this.storage.pendingQuestions.getBySessionIdIncludingExpired(sessionId);
    if (!pending || pending.requestId !== reply.questionRequestId) return "free-text";
    const labels = new Set(
      pending.questions.flatMap((q) => (q.options ?? []).map((o) => o.label)),
    );
    const values = reply.answers.flat();
    // Every step must have resolved to a label. A wizard whose steps are half
    // buttons and half typed text is not a button press, and calling it one
    // would be the overclaim this method exists to prevent.
    return values.length > 0 && values.every((a) => labels.has(a)) ? "option" : "free-text";
  }

  private bank(
    session: SessionRecord,
    input: {
      msgId: string;
      source: "telegram-reply" | "question-answer";
      payload: string;
      questionRequestId?: string;
      answerKind?: "option" | "free-text";
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
        questionRequestId: input.questionRequestId ?? null,
        answerKind: input.answerKind ?? null,
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
 * not quote a cadence: the daemon has no idea when the lane next runs, and an
 * invented number is how a true statement becomes a false one.
 */
export function bankedReplyMessage(session: SessionRecord): string {
  const name = session.label || session.title || session.sessionId;
  return (
    `Banked for ${name} — this session is not running continuously, so it reads its ` +
    `messages when it next runs, not immediately.`
  );
}

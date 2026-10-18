/**
 * Shared receipt and turn rendering for goose turns.
 *
 * Used by:
 * - GooseSessionRunner (receipt rendering when turns finish)
 * - POST /goose/turn-event (rendering honkd turn.ended hook events)
 */

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024;
export const TRUNCATION_NOTICE = "\n\n[... truncated: the turn produced more output than pigeon buffers]";

/**
 * Cap text at `cap` characters without splitting a UTF-16 surrogate pair.
 */
export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) {
    return { text, truncated: false };
  }
  let sliceEnd = cap;
  const c = text.charCodeAt(sliceEnd - 1);
  if (c >= 0xd800 && c <= 0xdbff) {
    sliceEnd = cap - 1;
  }
  return {
    text: text.slice(0, sliceEnd),
    truncated: true,
  };
}

/**
 * Explanatory detail sentence for honkd cancellation reasons.
 */
export function honkReasonDetail(
  stopReason?: string | null,
  honkReason?: string | null,
): string | undefined {
  if (stopReason !== undefined && stopReason !== null && stopReason !== "cancelled") {
    return undefined;
  }
  if (honkReason === "not_delivered") {
    return "The message was not delivered; please send it again.";
  }
  if (honkReason === "upstream_restart") {
    return "goose restarted and the turn was cancelled.";
  }
  if (honkReason === "delivery_unknown") {
    return "honkd could not confirm goose received this message; check the session before resending.";
  }
  return undefined;
}

/**
 * Standard wording when goose finishes a turn with no reply text.
 */
export function emptyReplyText(stopReason?: string | null): string {
  return stopReason && stopReason !== "end_turn"
    ? `goose ended the turn without a reply (stopReason: ${stopReason}).`
    : "goose ended the turn without a reply.";
}

export interface HookTurnEndedEvent {
  v?: number;
  type?: string;
  event_id?: string;
  session_id?: string;
  upstream_id?: string;
  run_id?: string | null;
  client_req_ids?: string[];
  prompt_text?: string | null;
  at_ms?: number;
  stop_reason?: string | null;
  honk_reason?: string | null;
  final_text?: string | null;
  final_text_truncated?: boolean | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface RenderedHookTurn {
  message: string;
  event: "Stop" | "Error";
  errorKind?: string;
}

/**
 * Renders a honkd turn.ended event into a notification payload for pigeon's stop route.
 */
export function renderHookTurn(ev: HookTurnEndedEvent): RenderedHookTurn {
  const isCancelled =
    ev.honk_reason === "cancelled" || (ev.stop_reason === "cancelled" && !ev.honk_reason);

  const hasText = typeof ev.final_text === "string" && ev.final_text !== "";
  const detail = honkReasonDetail(ev.stop_reason, ev.honk_reason);
  const errText = typeof ev.error === "string" && ev.error !== "" ? ev.error : undefined;

  let message: string;
  if (isCancelled) {
    if (hasText) {
      const capped = capText(ev.final_text!, DEFAULT_MAX_TRANSCRIPT_BYTES);
      let body = capped.text;
      if (capped.truncated || Boolean(ev.final_text_truncated)) {
        body += TRUNCATION_NOTICE;
      }
      message = `${body}\n\n(cancelled)`;
    } else {
      message = "Turn cancelled.";
    }
  } else if (!hasText) {
    if (detail) {
      message = errText ? `${detail}\n\n${errText}` : detail;
    } else if (errText) {
      message = errText;
    } else {
      message = emptyReplyText(ev.stop_reason);
    }
  } else {
    const capped = capText(ev.final_text!, DEFAULT_MAX_TRANSCRIPT_BYTES);
    let body = capped.text;
    if (capped.truncated || Boolean(ev.final_text_truncated)) {
      body += TRUNCATION_NOTICE;
    }
    message = body;
    if (detail) {
      message += `\n\n${detail}`;
    }
    if (errText) {
      message += `\n\n${errText}`;
    }
  }

  if (isCancelled) {
    return {
      message,
      event: "Stop",
      errorKind: undefined,
    };
  }

  if (errText) {
    return {
      message,
      event: "Error",
      errorKind: "goose-turn-failed",
    };
  }

  if (ev.honk_reason === "upstream_restart" || ev.honk_reason === "delivery_unknown") {
    return {
      message,
      event: "Error",
      errorKind: `honk-${ev.honk_reason}`,
    };
  }

  if (ev.honk_reason === "synthesized") {
    return {
      message,
      event: "Stop",
      errorKind: undefined,
    };
  }

  if (ev.stop_reason && ev.stop_reason !== "end_turn" && ev.stop_reason !== "cancelled") {
    return {
      message,
      event: "Error",
      errorKind: `goose-stop-${ev.stop_reason}`,
    };
  }

  return {
    message,
    event: "Stop",
    errorKind: undefined,
  };
}

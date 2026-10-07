import type { StorageDb } from "../storage/database";
import type { Priority } from "../storage/swarm-repo";
import { isPullBackend } from "../adapters/goose-pull";
import { enqueueSwarmTelegramNotice } from "./telegram-notice";

export interface BankOrInsertInput {
  msgId: string;
  fromSession: string;
  toSession: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
  deliverAt?: number | null;
  expiresAt?: number | null;
  ref?: string | null;
}

export type BankOrInsertResult =
  | {
      status: "banked";
      msgId: string;
      fresh: boolean;
    }
  | {
      status: "inserted";
      msgId: string;
      inserted: boolean;
    }
  | {
      status: "refused";
      reason: "scheduled" | "payload_too_large";
      error: string;
      statusCode: 409 | 413;
    };

/** Maximum allowed payload length for a banked pull session (in Unicode code points). */
export const MAX_PULL_PAYLOAD_CODE_POINTS = 4000;

/**
 * Routes every swarm message insertion to either the pull inbox bank or
 * the standard swarm_messages table.
 *
 * Messages to pull-mode sessions opting into swarm are banked in pull_inbox
 * and bypass the arbiter completely.
 */
export function bankOrInsertSwarmMessage(
  storage: StorageDb,
  input: BankOrInsertInput,
  now = Date.now(),
): BankOrInsertResult {
  // Check if target is a pull session that opted in to swarm banking.
  const hasSessionTarget = Boolean(input.toSession && !input.channel);
  const targetSession = hasSessionTarget && input.toSession ? storage.sessions.get(input.toSession) : null;
  const wouldBank = Boolean(
    targetSession &&
      isPullBackend(targetSession) &&
      targetSession.pullSources.includes("swarm"),
  );

  if (wouldBank) {
    // A pull session has no delivery clock to honour deliver_at, and moving
    // expiry onto the recipient was rejected.
    if (input.deliverAt !== undefined && input.deliverAt !== null) {
      return {
        status: "refused",
        reason: "scheduled",
        error: "scheduled messages cannot be banked for a pull session",
        statusCode: 409,
      };
    }

    // The receiving client cannot take more than 4000 code points, and refusing
    // at send time tells the sender immediately rather than failing days later.
    const codePointLength = [...input.payload].length;
    if (codePointLength > MAX_PULL_PAYLOAD_CODE_POINTS) {
      return {
        status: "refused",
        reason: "payload_too_large",
        error: `payload exceeds maximum length of ${MAX_PULL_PAYLOAD_CODE_POINTS} characters (${codePointLength})`,
        statusCode: 413,
      };
    }

    // Bank into pull_inbox; the arbiter must never see it.
    const fresh = storage.pullInbox.bank(
      {
        msgId: input.msgId,
        sessionId: input.toSession!,
        source: "swarm",
        payload: input.payload,
        senderId: input.fromSession,
        kind: input.kind,
        replyTo: input.replyTo,
      },
      now,
    );

    // Enqueue recipient Telegram notice only when the bank was fresh (not an idempotent repeat).
    if (fresh) {
      enqueueSwarmTelegramNotice(
        storage,
        {
          msgId: input.msgId,
          fromSession: input.fromSession,
          toSession: input.toSession,
          kind: input.kind,
          priority: input.priority,
          payload: input.payload,
          createdAt: now,
          deliverAt: null,
        },
        now,
      );
    }

    return {
      status: "banked",
      msgId: input.msgId,
      fresh,
    };
  }

  // Non-banking target: standard swarm_messages insert + notice.
  const inserted = storage.swarm.insert(
    {
      msgId: input.msgId,
      fromSession: input.fromSession,
      toSession: input.toSession,
      channel: input.channel,
      kind: input.kind,
      priority: input.priority,
      replyTo: input.replyTo,
      payload: input.payload,
      deliverAt: input.deliverAt,
      expiresAt: input.expiresAt,
      ref: input.ref,
    },
    now,
  );

  if (inserted) {
    const record = storage.swarm.getByMsgId(input.msgId);
    if (record) {
      enqueueSwarmTelegramNotice(storage, record, now);
    }
  }

  return {
    status: "inserted",
    msgId: input.msgId,
    inserted,
  };
}

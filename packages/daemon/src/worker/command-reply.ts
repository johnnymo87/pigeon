/**
 * Slash-command replies, sent through the worker's `POST /messages/send` (chat-transport
 * phase 1, pigeon-lenr). Before this they were a direct Bot API call from the daemon with no
 * timeout at all.
 *
 * No fallback, deliberately: replies are best-effort, their failures were always swallowed,
 * and only operational alerts (alert-notifier.ts) justify a second path. In exchange the
 * worker is asked to ride out a slow Telegram (pigeon-bit4 saw 43.6s stalls) with a long
 * abort, and our own bound sits above it.
 *
 * A worker 404 is logged as an ERROR, not a warning: it means the worker is older than this
 * daemon (a rollback below the /messages/send version, or a daemon deployed first), and
 * every reply on the machine is then being lost. That must be loud.
 */

import type { TgEntity } from "../telegram-message";
import type { WorkerMessageClient } from "./worker-message-client";

/** The worker's abort on its Telegram call for a reply. The route's documented maximum. */
export const COMMAND_REPLY_TELEGRAM_TIMEOUT_MS = 30_000;
/** Our bound on the whole request: above the worker's, so its answer arrives first. */
export const COMMAND_REPLY_REQUEST_TIMEOUT_MS = 35_000;

export type CommandReplySender = (
  chatId: string,
  text: string,
  opts: { entities?: TgEntity[]; messageThreadId: number | undefined },
) => Promise<void>;

export interface CommandReplyLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLog: CommandReplyLogger = {
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export function createCommandReplySender(
  client: Pick<WorkerMessageClient, "sendMessage"> | undefined,
  log: CommandReplyLogger = defaultLog,
): CommandReplySender {
  return async (chatId, text, opts) => {
    if (!client) {
      log.warn("[pigeon-daemon] command reply dropped: no worker configured (CCR_WORKER_URL/CCR_API_KEY)");
      return;
    }
    try {
      const out = await client.sendMessage(
        {
          chatId,
          text,
          ...(opts.entities && opts.entities.length > 0 ? { entities: opts.entities } : {}),
          ...(opts.messageThreadId !== undefined ? { messageThreadId: opts.messageThreadId } : {}),
          timeoutMs: COMMAND_REPLY_TELEGRAM_TIMEOUT_MS,
        },
        { timeoutMs: COMMAND_REPLY_REQUEST_TIMEOUT_MS },
      );
      if (out.kind === "sent") return;
      if (out.kind === "telegram_rejected") {
        // The description, not just the status. Telegram answers an over-long message, a
        // bad entity offset or invalid UTF-8 with an indistinguishable 400, and a reply
        // that vanishes between the worker's ack and the user's screen leaves a bare "400"
        // as the only trace. That dead end is what made the surrogate-pair bug in the /tag
        // backlog hard to find.
        log.warn(
          `[pigeon-daemon] command reply rejected by Telegram: ${out.status} ${(out.description ?? "").slice(0, 500)}`,
        );
        return;
      }
      if (out.status === 404) {
        log.error(
          `[pigeon-daemon] command reply LOST: worker has no POST /messages/send (404). The worker is ` +
            `older than this daemon; deploy the worker (or stop rolling it back) -- every slash-command ` +
            `reply on this machine is being dropped.`,
        );
        return;
      }
      log.warn(`[pigeon-daemon] command reply failed: worker /messages/send ${out.reason}`);
    } catch (err) {
      // sendMessage never throws; this is a backstop so a reply can never break a command.
      log.warn(`[pigeon-daemon] command reply error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

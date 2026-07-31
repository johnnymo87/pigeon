import type { TgEntity } from "../telegram-message";
import type { SendNotificationInput, WorkerResult } from "./poller";
import {
  classifyActivity,
  snippetFromMessages,
  lastActivityFromMessages,
} from "../current-state-enrich";
import {
  formatStateCard,
  formatCurrentStateIndex,
} from "../notification-service";

/**
 * Builds the notification payload for a /current-state card.
 *
 * `threaded: false` is load-bearing, not incidental: cards go through the same
 * sendNotification endpoint that lazily creates forum topics, once per surveyed
 * session, sequentially and uncapped. Letting them thread would fire a
 * createForumTopic + sendMessage burst (~31 calls on a 15-session machine)
 * against Telegram's ~20/min per-chat ceiling, and would create topics for idle
 * sessions that never notified — defeating lazy creation. Card failures are
 * swallowed with console.warn and have no outbox, so anything past the limit is
 * lost silently.
 */
export function buildCardNotification(opts: {
  sessionId: string;
  chatId: string;
  text: string;
  entities: TgEntity[] | undefined;
}): SendNotificationInput {
  return {
    sessionId: opts.sessionId,
    chatId: opts.chatId,
    text: opts.text,
    replyMarkup: { inline_keyboard: [] },
    entities: opts.entities,
    threaded: false,
  };
}

export interface CurrentStateIngestInput {
  commandId: string;
  chatId: string;
  machineId: string;
  opencodeClient: {
    healthCheck: () => Promise<boolean>;
    getSessionInfo: (sid: string) => Promise<{ id: string; title: string; directory: string; time: { created: number; updated: number } } | null>;
    getSessionMessages: (sid: string) => Promise<unknown[]>;
  };
  enumerate: () => Promise<{ sids: string[]; homeScreenCount: number }>;
  registerSession: (sid: string, label: string) => Promise<WorkerResult>;
  enqueueCard: (opts: {
    sid: string;
    text: string;
    entities: TgEntity[] | undefined;
    notificationId: string;
  }) => void;
  sendPlainText: (text: string, entities?: TgEntity[]) => Promise<void>;
  now?: number; // for deterministic relative-time in tests
}

export async function ingestCurrentStateCommand(input: CurrentStateIngestInput): Promise<void> {
  const healthy = await input.opencodeClient.healthCheck();
  if (!healthy) {
    await input.sendPlainText(`opencode serve is not running on ${input.machineId}.`);
    return;
  }

  const { sids, homeScreenCount } = await input.enumerate();
  if (sids.length === 0 && homeScreenCount === 0) {
    await input.sendPlainText(`No main-session TUIs found on ${input.machineId}.`);
    return;
  }

  let unreadable = 0;
  const records: Array<{
    sid: string;
    title: string;
    dir: string | null;
    status: "active" | "idle";
    snippet: string;
    lastActivity: number | null;
  }> = [];

  for (const sid of sids) {
    try {
      const info = await input.opencodeClient.getSessionInfo(sid);
      if (!info) {
        unreadable++;
        continue;
      }
      const messages = await input.opencodeClient.getSessionMessages(sid);
      const status = classifyActivity(messages);
      const snippet = snippetFromMessages(messages);
      const lastActivity = lastActivityFromMessages(messages) ?? info.time.updated;
      records.push({
        sid,
        title: info.title || sid,
        dir: info.directory,
        status,
        snippet,
        lastActivity,
      });
    } catch {
      unreadable++;
    }
  }

  records.sort((a, b) => {
    if (a.lastActivity === null && b.lastActivity === null) return 0;
    if (a.lastActivity === null) return 1;
    if (b.lastActivity === null) return -1;
    return b.lastActivity - a.lastActivity;
  });

  // invariant: The index/summary message must go out BEFORE any individual state cards are sent (index-before-cards).
  const index = formatCurrentStateIndex({
    machineId: input.machineId,
    sessions: records.map(r => ({ title: r.title, status: r.status })),
    unreadable,
    homeScreen: homeScreenCount,
  });
  await input.sendPlainText(index.text, index.entities);

  // Cards (no cap)
  // invariant: registerSession MUST precede enqueueCard per record (the worker swipe-reply handle won't resolve otherwise).
  // This loop is intentionally sequential.
  for (const r of records) {
    try {
      const regResult = await input.registerSession(r.sid, r.title);
      if (!regResult.ok) {
        console.warn(`[current-state-ingest] registerSession failed for ${r.sid}:`, regResult);
        continue;
      }
      const card = formatStateCard(
        {
          title: r.title,
          status: r.status,
          dir: r.dir,
          sid: r.sid,
          snippet: r.snippet,
          lastActivity: r.lastActivity,
          machineId: input.machineId,
        },
        input.now,
      );
      const notificationId = `cs:${input.commandId}:${r.sid}`;
      input.enqueueCard({
        sid: r.sid,
        text: card.text,
        entities: card.entities,
        notificationId,
      });
    } catch (e) {
      console.warn(`[current-state-ingest] failed to register or enqueue card for ${r.sid}:`, e);
    }
  }
}

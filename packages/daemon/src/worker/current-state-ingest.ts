import type { AllowlistDeps } from "../main-session-allowlist";
import type { TgEntity } from "../telegram-message";
import {
  classifyActivity,
  snippetFromMessages,
  lastActivityFromMessages,
} from "../current-state-enrich";
import {
  formatStateCard,
  formatCurrentStateIndex,
} from "../notification-service";

export interface CurrentStateIngestInput {
  commandId: string;
  chatId: string;
  machineId: string;
  opencodeClient: {
    healthCheck: () => Promise<boolean>;
    getSessionInfo: (sid: string) => Promise<{ id: string; title: string; directory: string; time: { created: number; updated: number } } | null>;
    getSessionMessages: (sid: string) => Promise<unknown[]>;
  };
  enumerate: (deps: AllowlistDeps) => Promise<string[]>;   // inject enumerateMainSessionSids for testability
  allowlistDeps: AllowlistDeps;
  registerSession: (sid: string, label: string) => Promise<void>;
  sendCard: (sid: string, text: string, entities: TgEntity[] | undefined) => Promise<void>;
  sendPlainText: (text: string, entities?: TgEntity[]) => Promise<void>;
  now?: number; // for deterministic relative-time in tests
}

export async function ingestCurrentStateCommand(input: CurrentStateIngestInput): Promise<void> {
  const healthy = await input.opencodeClient.healthCheck();
  if (!healthy) {
    await input.sendPlainText(`opencode serve is not running on ${input.machineId}.`);
    return;
  }

  const sids = await input.enumerate(input.allowlistDeps);
  if (sids.length === 0) {
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
  });
  await input.sendPlainText(index.text, index.entities);

  // Cards (no cap)
  // invariant: registerSession MUST precede sendCard per record (the worker swipe-reply handle won't resolve otherwise).
  // This loop is intentionally sequential.
  for (const r of records) {
    try {
      await input.registerSession(r.sid, r.title);
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
      await input.sendCard(r.sid, card.text, card.entities);
    } catch (e) {
      console.warn(`[current-state-ingest] failed to register or send card for ${r.sid}:`, e);
    }
  }
}

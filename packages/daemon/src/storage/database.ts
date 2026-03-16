import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initSchema } from "./schema";
import {
  InboxRepository,
  PendingQuestionRepository,
  ReplyTokenRepository,
  SessionRepository,
  SessionTokenRepository,
} from "./repos";
import { OutboxRepository } from "./outbox-repo";

export interface StorageDb {
  db: BetterSqlite3.Database;
  sessions: SessionRepository;
  sessionTokens: SessionTokenRepository;
  replyTokens: ReplyTokenRepository;
  inbox: InboxRepository;
  pendingQuestions: PendingQuestionRepository;
  outbox: OutboxRepository;
}

export function openStorageDb(path: string): StorageDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new BetterSqlite3(path);
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);

  return {
    db,
    sessions: new SessionRepository(db),
    sessionTokens: new SessionTokenRepository(db),
    replyTokens: new ReplyTokenRepository(db),
    inbox: new InboxRepository(db),
    pendingQuestions: new PendingQuestionRepository(db),
    outbox: new OutboxRepository(db),
  };
}

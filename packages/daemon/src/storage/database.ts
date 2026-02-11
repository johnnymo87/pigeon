import BetterSqlite3 from "better-sqlite3";
import { initSchema } from "./schema";
import {
  InboxRepository,
  ReplyTokenRepository,
  SessionRepository,
  SessionTokenRepository,
} from "./repos";

export interface StorageDb {
  db: BetterSqlite3.Database;
  sessions: SessionRepository;
  sessionTokens: SessionTokenRepository;
  replyTokens: ReplyTokenRepository;
  inbox: InboxRepository;
}

export function openStorageDb(path: string): StorageDb {
  const db = new BetterSqlite3(path);
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);

  return {
    db,
    sessions: new SessionRepository(db),
    sessionTokens: new SessionTokenRepository(db),
    replyTokens: new ReplyTokenRepository(db),
    inbox: new InboxRepository(db),
  };
}

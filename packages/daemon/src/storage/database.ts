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
import { initSwarmSchema } from "./swarm-schema";
import { SwarmRepository } from "./swarm-repo";
import { initRouteSchema } from "../routing/route-schema";
import { ServeInstanceRepo, SessionAssignmentRepo, SessionLeaseRepo, RoutingMetaRepo } from "../routing/route-repo";
import { initReassignmentSchema, ReassignmentEventRepo } from "../routing/reassignment-repo";

export interface StorageDb {
  db: BetterSqlite3.Database;
  sessions: SessionRepository;
  sessionTokens: SessionTokenRepository;
  replyTokens: ReplyTokenRepository;
  inbox: InboxRepository;
  pendingQuestions: PendingQuestionRepository;
  outbox: OutboxRepository;
  swarm: SwarmRepository;
  serves: ServeInstanceRepo;
  assignments: SessionAssignmentRepo;
  leases: SessionLeaseRepo;
  meta: RoutingMetaRepo;
  /** Dated log of serve reassignments — the flap detector's input (pigeon-f2a). */
  reassignments: ReassignmentEventRepo;
}

export function openStorageDb(path: string): StorageDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new BetterSqlite3(path);
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  initSwarmSchema(db);
  initRouteSchema(db);
  // Deliberately a SEPARATE schema call: this table must stay out of ROUTING_DDL,
  // whose digest the serve pool validates at startup. See reassignment-repo.ts.
  initReassignmentSchema(db);

  return {
    db,
    sessions: new SessionRepository(db),
    sessionTokens: new SessionTokenRepository(db),
    replyTokens: new ReplyTokenRepository(db),
    inbox: new InboxRepository(db),
    pendingQuestions: new PendingQuestionRepository(db),
    outbox: new OutboxRepository(db),
    swarm: new SwarmRepository(db),
    serves: new ServeInstanceRepo(db),
    assignments: new SessionAssignmentRepo(db),
    leases: new SessionLeaseRepo(db),
    meta: new RoutingMetaRepo(db),
    reassignments: new ReassignmentEventRepo(db),
  };
}

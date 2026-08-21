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
import { initAlertSchema, AlertRepository } from "./alert-repo";
import { initSwarmSchema } from "./swarm-schema";
import { SwarmRepository } from "./swarm-repo";
import { initSessionOriginSchema } from "./session-origin-schema";
import { initSessionEventsSchema } from "./session-events-schema";
import { SessionEventsRepo } from "./session-events-repo";
import { SessionOriginRepository } from "./session-origin-repo";
import { initRouteSchema } from "../routing/route-schema";
import { ServeInstanceRepo, SessionAssignmentRepo, SessionLeaseRepo, RoutingMetaRepo } from "../routing/route-repo";
import { initReassignmentSchema, ReassignmentEventRepo } from "../routing/reassignment-repo";
import { initInjectedPromptsSchema } from "./injected-prompts-schema";
import { InjectedPromptsRepository } from "./injected-prompts-repo";

export interface StorageDb {
  db: BetterSqlite3.Database;
  sessions: SessionRepository;
  sessionTokens: SessionTokenRepository;
  replyTokens: ReplyTokenRepository;
  inbox: InboxRepository;
  pendingQuestions: PendingQuestionRepository;
  outbox: OutboxRepository;
  alerts: AlertRepository;
  swarm: SwarmRepository;
  sessionOrigins: SessionOriginRepository;
  /** Durable log of what was delivered to a topic, plus the read watermark. */
  sessionEvents: SessionEventsRepo;
  injectedPrompts: InjectedPromptsRepository;
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
  initSessionOriginSchema(db);
  initSessionEventsSchema(db);
  initInjectedPromptsSchema(db);
  initAlertSchema(db);
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
    alerts: new AlertRepository(db),
    swarm: new SwarmRepository(db),
    sessionOrigins: new SessionOriginRepository(db),
    sessionEvents: new SessionEventsRepo(db),
    injectedPrompts: new InjectedPromptsRepository(db),
    serves: new ServeInstanceRepo(db),
    assignments: new SessionAssignmentRepo(db),
    leases: new SessionLeaseRepo(db),
    meta: new RoutingMetaRepo(db),
    reassignments: new ReassignmentEventRepo(db),
  };
}

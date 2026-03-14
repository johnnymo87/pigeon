import { verifyApiKey, unauthorized } from "./auth";

const MAX_SESSIONS = 1000;

export type SessionAction = "list" | "register" | "unregister";

export interface SessionRow {
  session_id: string;
  machine_id: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

export async function handleSessionRequest(
  db: D1Database,
  env: Env,
  request: Request,
  action: SessionAction,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  switch (action) {
    case "list":
      return listSessions(db);
    case "register":
      return registerSession(db, request);
    case "unregister":
      return unregisterSession(db, request);
  }
}

async function listSessions(db: D1Database): Promise<Response> {
  const { results } = await db.prepare("SELECT * FROM sessions").all<SessionRow>();
  return Response.json(results);
}

async function registerSession(
  db: D1Database,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sessionId = body.sessionId as string | undefined;
  const machineId = body.machineId as string | undefined;
  const label = (body.label as string | undefined) ?? null;

  if (!sessionId || !machineId) {
    return Response.json(
      { error: "sessionId and machineId required" },
      { status: 400 },
    );
  }

  // Check session limit (only for new sessions)
  const existing = await db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ session_id: string }>();

  if (!existing) {
    const countResult = await db
      .prepare("SELECT COUNT(*) as count FROM sessions")
      .first<{ count: number }>();
    if (countResult && countResult.count >= MAX_SESSIONS) {
      return Response.json({ error: "Session limit reached" }, { status: 429 });
    }
  }

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         machine_id = excluded.machine_id,
         label = excluded.label,
         updated_at = excluded.updated_at`,
    )
    .bind(sessionId, machineId, label, now, now)
    .run();

  return Response.json({ ok: true, sessionId, machineId });
}

async function unregisterSession(
  db: D1Database,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }

  await db.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
  await db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();

  return Response.json({ ok: true });
}

/**
 * Touch a session to keep it alive (update updated_at).
 * Used internally by notification and command routing.
 */
export async function touchSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
    .bind(Date.now(), sessionId)
    .run();
}

/**
 * Look up which machine a session belongs to.
 */
export async function getSessionMachine(
  db: D1Database,
  sessionId: string,
): Promise<{ machine_id: string; label: string | null } | null> {
  const row = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  return row ?? null;
}

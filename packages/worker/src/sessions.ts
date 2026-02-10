import { verifyApiKey, unauthorized } from "./auth";

const MAX_SESSIONS = 1000;

export type SessionAction = "list" | "register" | "unregister";

export interface SessionRow {
  session_id: string;
  machine_id: string;
  label: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export async function handleSessionRequest(
  sql: SqlStorage,
  env: Env,
  request: Request,
  action: SessionAction,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  switch (action) {
    case "list":
      return listSessions(sql);
    case "register":
      return registerSession(sql, request);
    case "unregister":
      return unregisterSession(sql, request);
  }
}

function listSessions(sql: SqlStorage): Response {
  const rows = sql.exec<SessionRow>("SELECT * FROM sessions").toArray();
  return Response.json(rows);
}

async function registerSession(
  sql: SqlStorage,
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
  const existing = sql
    .exec<{ session_id: string }>(
      "SELECT session_id FROM sessions WHERE session_id = ?",
      sessionId,
    )
    .toArray();

  if (existing.length === 0) {
    const countResult = sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM sessions")
      .toArray();
    if (countResult[0] && countResult[0].count >= MAX_SESSIONS) {
      return Response.json({ error: "Session limit reached" }, { status: 429 });
    }
  }

  const now = Date.now();
  sql.exec(
    `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       machine_id = excluded.machine_id,
       label = excluded.label,
       updated_at = excluded.updated_at`,
    sessionId,
    machineId,
    label,
    now,
    now,
  );

  return Response.json({ ok: true, sessionId, machineId });
}

async function unregisterSession(
  sql: SqlStorage,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }

  sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
  sql.exec("DELETE FROM messages WHERE session_id = ?", sessionId);

  return Response.json({ ok: true });
}

/**
 * Touch a session to keep it alive (update updated_at).
 * Used internally by notification and command routing.
 */
export function touchSession(sql: SqlStorage, sessionId: string): void {
  sql.exec(
    "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
    Date.now(),
    sessionId,
  );
}

/**
 * Look up which machine a session belongs to.
 */
export function getSessionMachine(
  sql: SqlStorage,
  sessionId: string,
): { machine_id: string; label: string | null } | null {
  const rows = sql
    .exec<{ machine_id: string; label: string | null }>(
      "SELECT machine_id, label FROM sessions WHERE session_id = ?",
      sessionId,
    )
    .toArray();
  return rows[0] ?? null;
}

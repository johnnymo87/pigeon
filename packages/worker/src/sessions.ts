import { verifyApiKey, unauthorized } from "./auth";
import { createTelegramClient } from "./telegram";
import { topicsEnabled, getBySession, markClosed } from "./topics";
import { withD1, StorageError } from "./d1";

export const MAX_SESSIONS = 5000;

export type SessionAction = "list" | "register" | "unregister";

/**
 * Test seam. Production always uses MAX_SESSIONS; tests override the cap so they can
 * exercise the limit without inserting thousands of rows into the shared D1.
 */
export interface SessionRequestOptions {
  maxSessions?: number;
}

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
  opts?: SessionRequestOptions,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  switch (action) {
    case "list":
      return listSessions(db);
    case "register":
      return registerSession(db, env, request, opts);
    case "unregister":
      return unregisterSession(db, env, request);
  }
}

async function listSessions(db: D1Database): Promise<Response> {
  const { results } = await db.prepare("SELECT * FROM sessions").all<SessionRow>();
  return Response.json(results);
}

async function registerSession(
  db: D1Database,
  env: Env,
  request: Request,
  opts?: SessionRequestOptions,
): Promise<Response> {
  try {
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

    const cap = opts?.maxSessions ?? MAX_SESSIONS;

    // Check session limit (only for new sessions)
    const existing = await withD1(
      "registerSession.existing",
      db
        .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first<{ session_id: string }>(),
    );

    if (!existing) {
      const countResult = await withD1(
        "registerSession.count",
        db
          .prepare("SELECT COUNT(*) as count FROM sessions")
          .first<{ count: number }>(),
      );
      const count = countResult?.count ?? 0;
      if (count >= cap) {
        console.error(`Session limit reached: ${count} / ${cap} sessions`);
        return Response.json({ error: "Session limit reached" }, { status: 429 });
      }
    }

    const now = Date.now();
    await withD1(
      "registerSession.upsert",
      db
        .prepare(
          `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             machine_id = excluded.machine_id,
             label = excluded.label,
             updated_at = excluded.updated_at`,
        )
        .bind(sessionId, machineId, label, now, now)
        .run(),
    );

    return Response.json({ ok: true, sessionId, machineId });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error("[worker] storage error", { op: err.op, error: err.message });
      return Response.json(
        { error: "storage_error", store: "d1", op: err.op },
        { status: 503 },
      );
    }
    throw err;
  }
}

async function unregisterSession(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const sessionId = body.sessionId as string | undefined;
  // Default-DEFER (pigeon-xehy). Closing a forum topic makes Telegram post a service message
  // that marks the topic UNREAD, so closes are batched into a daily window
  // (`shouldCloseOrphans`). This endpoint used to close unconditionally, which meant every
  // NON-INTERACTIVE unregister — the daemon's hourly session reaper, dead-session cleanup, the
  // outbox's compensating unregister — closed a topic off-window and defeated that batching.
  //
  // The gate lives HERE, at the single choke point, rather than in each daemon caller. Two
  // reasons: (1) three separate daemon call sites would each have to opt in and any one missed
  // keeps half the symptom, which is the pigeon-twdw lesson; (2) the daemon is deployed
  // per-machine while the worker deploys centrally, so an opt-in flag would only take effect
  // once every machine had been updated.
  //
  // Deferring is safe because the state left behind — topic `state='open'` with no `sessions`
  // row — is exactly what `listOrphaned` selects, so the windowed orphan-closer collects it on
  // its next in-window tick (at most ~1 day later, and the 30-day reap clock starts from that
  // close).
  //
  // `immediate` is the opt-in for an INTERACTIVE close (`/kill`, explicit session delete), where
  // a human is watching and expects the topic to shut immediately. Both version skews are safe:
  // an old daemon that never sends the flag simply gets its `/kill` closes batched (cosmetic,
  // self-healing), and a new daemon talking to an old worker sees the field ignored, i.e. today's
  // behaviour.
  const immediate = body.immediate === true;

  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }

  await db.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
  await db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();

  // Topic closing runs AFTER the deletes, and the order is load-bearing.
  //
  // Deleting the session is this endpoint's primary job; closing the topic is auxiliary. If the
  // topic block throws (the realistic case: the flag is flipped on before the `topics` DDL has
  // been applied, so `getBySession` hits a missing table) we still want the session gone.
  //
  // The failure then self-heals rather than wedging: T2.11's orphan-closer selects open topics
  // whose `sessions` row is ABSENT, which is exactly the state this leaves behind. Running the
  // block first would instead 500 the request, leave the session row in place, and give the
  // daemon's session-reaper a call that fails identically on every retry.
  if (immediate && topicsEnabled(env)) {
    const topic = await getBySession(db, sessionId);
    // `state === "open"` guard: `markClosed` is unconditional, so re-closing an already-closed
    // topic rewrites `closed_at` and restarts the 30-day reap clock, keeping a dead topic alive
    // indefinitely if anything unregisters the same session twice.
    if (topic && topic.state === "open") {
      // Mark closed in D1 before touching Telegram, so a failed/timed-out Telegram call still
      // leaves a row the reaper will collect.
      await markClosed(db, { sessionId });
      // A reservation row (NULL thread id) has no Telegram topic yet; closeForumTopic on it is a
      // guaranteed 400.
      if (topic.message_thread_id !== null) {
        try {
          const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
          await client.closeForumTopic({
            chatId: topic.chat_id,
            messageThreadId: topic.message_thread_id,
          });
        } catch {
          // best-effort Telegram call
        }
      }
    }
  }

  return Response.json({ ok: true });
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

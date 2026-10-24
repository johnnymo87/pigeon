import { unauthorized } from "./auth";
import { authenticate, checkActsAs, refusedCsvForSql, type Principal } from "./credentials";
import { createTelegramClient } from "./telegram";
import { topicsEnabled, getBySession, markClosed } from "./topics";
import { withD1, StorageError } from "./d1";

export const MAX_SESSIONS = 5000;

/**
 * A row idle this long may be taken over by another machine's credential (pigeon-k0qn.8).
 * Matches the daemon reaper's SESSION_TTL_MS: a session that old has been abandoned by its
 * owner, which would have unregistered it.
 */
export const REGISTER_TAKEOVER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

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
  const principal = await authenticate(request, env);
  if (!principal) {
    return unauthorized();
  }

  switch (action) {
    case "list":
      return listSessions(db);
    case "register":
      return registerSession(db, env, request, principal, opts);
    case "unregister":
      return unregisterSession(db, env, request, principal);
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
  principal: Principal,
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
        .prepare("SELECT session_id, machine_id, updated_at FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first<{ session_id: string; machine_id: string; updated_at: number }>(),
    );

    // Identity (pigeon-k0qn.8). A machine credential may register only as its own machine,
    // and may not take over a session another machine holds: without that, any key holder
    // could re-point a session at itself and collect its relays and Telegram commands. A row
    // idle for REGISTER_TAKEOVER_STALE_MS (the daemon reaper's TTL) is abandoned and may be
    // taken over; a live move needs the old owner to unregister first. The shared key keeps
    // last-registrant-wins, except as or over a machine it has been retired for.
    const claimed = checkActsAs(principal, env, machineId);
    if (claimed) return claimed;
    if (existing && existing.machine_id !== machineId) {
      if (principal.kind === "shared") {
        const over = checkActsAs(principal, env, existing.machine_id);
        if (over) return over;
      } else if (Date.now() - existing.updated_at < REGISTER_TAKEOVER_STALE_MS) {
        return Response.json(
          {
            error: "owned_by_other_machine",
            detail: `${sessionId} is registered to ${existing.machine_id}; it must unregister it first`,
          },
          { status: 409 },
        );
      }
    }

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

    // The ownership rule above is re-asserted INSIDE the upsert (pigeon-k0qn.5, rule 4 of the
    // .8 review), so a register racing between that read and this write cannot overwrite a
    // row it was not allowed to: the DO UPDATE applies only when the row is still ours, is
    // stale, or (shared key) is not owned by a retired machine. Zero changes means we lost.
    const now = Date.now();
    const upsert =
      principal.kind === "machine"
        ? db
            .prepare(
              `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                 machine_id = excluded.machine_id,
                 label = excluded.label,
                 updated_at = excluded.updated_at
               WHERE sessions.machine_id = excluded.machine_id OR sessions.updated_at < ?`,
            )
            .bind(sessionId, machineId, label, now, now, now - REGISTER_TAKEOVER_STALE_MS)
        : db
            .prepare(
              `INSERT INTO sessions (session_id, machine_id, label, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                 machine_id = excluded.machine_id,
                 label = excluded.label,
                 updated_at = excluded.updated_at
               WHERE sessions.machine_id = excluded.machine_id
                  OR instr(?, ',' || sessions.machine_id || ',') = 0`,
            )
            .bind(sessionId, machineId, label, now, now, refusedCsvForSql(env));
    const result = await withD1("registerSession.upsert", upsert.run());
    if (!result.meta.changes) {
      const owner = await withD1(
        "registerSession.owner",
        db
          .prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
          .bind(sessionId)
          .first<{ machine_id: string }>(),
      );
      const holder = owner?.machine_id ?? "another machine";
      if (principal.kind === "shared" && owner) {
        const refused = checkActsAs(principal, env, owner.machine_id);
        if (refused) return refused;
      }
      return Response.json(
        {
          error: "owned_by_other_machine",
          detail: `${sessionId} is registered to ${holder}; it must unregister it first`,
        },
        { status: 409 },
      );
    }
    // Real opencode and goose ids never legitimately move between machines; only fixed lane
    // ids do. A takeover is therefore worth a line in the log every time.
    if (existing && existing.machine_id !== machineId) {
      console.error("[sessions] register moved a session to another machine", {
        sessionId,
        from: existing.machine_id,
        to: machineId,
        idleMs: now - existing.updated_at,
        credential: principal.kind,
      });
    }

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
  principal: Principal,
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

  // Identity (pigeon-k0qn.8): only the owner may remove a session's routing, or unregister
  // followed by register would be a two-step takeover. Another machine's row is left alone
  // and answered 200, because every caller is janitorial (reaper, dead-session cleanup, the
  // outbox's compensating unregister) and "it is not mine to delete" is not a failure for
  // any of them. With no row there is nothing to protect; the deletes below are no-ops.
  if (principal.kind === "machine" || (env.SHARED_KEY_REFUSED_MACHINES ?? "").trim()) {
    const owner = await db
      .prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .first<{ machine_id: string }>();
    if (owner) {
      if (principal.kind === "machine" && owner.machine_id !== principal.machineId) {
        return Response.json({ ok: true, skipped: "not_owner" });
      }
      const refused = checkActsAs(principal, env, owner.machine_id);
      if (refused) return refused;
    }
  }

  await db.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
  await db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();

  try {
    await db.prepare("DELETE FROM named_topic_bindings WHERE session_id = ?").bind(sessionId).run();
  } catch (err) {
    console.warn("[worker] unregister binding delete failed", { sessionId, error: String(err) });
  }

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
 * `GET /sessions/:id/owner` (pigeon-k0qn.1): which machine a session is registered
 * to, and `last_seen` = the row's `updated_at` (bumped by registration, notifications
 * and Telegram routing, so "last active", not "last registered"). A daemon that
 * finds a swarm target is not on its own machine uses this to NAME the owner in the
 * sender's delivery.failed. That use is decoration, so this stays a single read: it
 * never touches `updated_at`, and `machine_id` is returned as stored (last registrant
 * wins).
 */
export async function handleSessionOwner(
  db: D1Database,
  env: Env,
  request: Request,
  sessionId: string,
): Promise<Response> {
  if (!(await authenticate(request, env))) {
    return unauthorized();
  }
  try {
    const row = await withD1(
      "sessionOwner",
      db
        .prepare("SELECT machine_id, updated_at FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first<{ machine_id: string; updated_at: number }>(),
    );
    if (!row) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }
    return Response.json({ machine_id: row.machine_id, last_seen: row.updated_at });
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

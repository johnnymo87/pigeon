export interface CommandWsLike {
  readyState: number;
  send(message: string): void;
}

export type CommandType = "execute" | "launch" | "kill";

interface QueueCountRow {
  count: number;
  [key: string]: SqlStorageValue;
}

interface QueueCommandRow {
  command_id: string;
  machine_id: string;
  session_id: string | null;
  command: string;
  chat_id: string;
  attempts: number;
  command_type: CommandType;
  directory: string | null;
  media_json: string | null;
  [key: string]: SqlStorageValue;
}

export const MAX_INFLIGHT = 20;
export const BATCH_SIZE = 10;
export const RETRY_INTERVAL_MS = 60_000;
export const MAX_ATTEMPTS = 10;
export const RETRY_SWEEP_LIMIT = 50;

export function generateCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getAttempts(sql: SqlStorage, commandId: string): number {
  const row = sql.exec(
    "SELECT attempts FROM command_queue WHERE command_id = ?",
    commandId,
  ).toArray()[0] as ({ attempts: number } & Record<string, SqlStorageValue>) | undefined;

  return row?.attempts ?? 0;
}

export function sendCommand(
  sql: SqlStorage,
  ws: CommandWsLike,
  commandId: string,
  sessionId: string | null,
  command: string,
  chatId: string,
  now = Date.now(),
  commandType: CommandType = "execute",
  directory: string | null = null,
  mediaJson: string | null = null,
): void {
  const currentAttempts = getAttempts(sql, commandId);
  const newAttempts = currentAttempts + 1;

  try {
    const media = mediaJson ? JSON.parse(mediaJson) : undefined;
    const message = commandType === "launch"
      ? JSON.stringify({ type: "launch", commandId, directory, prompt: command, chatId })
      : commandType === "kill"
      ? JSON.stringify({ type: "kill", commandId, sessionId, chatId })
      : JSON.stringify({ type: "command", commandId, sessionId, command, chatId, ...(media ? { media } : {}) });

    ws.send(message);

    sql.exec(
      `UPDATE command_queue
       SET status = 'sent', sent_at = ?, attempts = ?, next_retry_at = ?
       WHERE command_id = ?`,
      now,
      newAttempts,
      now + RETRY_INTERVAL_MS,
      commandId,
    );
  } catch (error) {
    const backoffMs = Math.min(1000 * (2 ** currentAttempts), 300_000);
    const message = error instanceof Error ? error.message : String(error);

    sql.exec(
      `UPDATE command_queue
       SET attempts = ?, next_retry_at = ?, last_error = ?
       WHERE command_id = ?`,
      newAttempts,
      now + backoffMs,
      message,
      commandId,
    );
  }
}

export function flushCommandQueue(
  sql: SqlStorage,
  machineId: string,
  ws: CommandWsLike,
  now = Date.now(),
): number {
  const inflightRows = sql.exec(
    `SELECT COUNT(*) as count
     FROM command_queue
     WHERE machine_id = ? AND status = 'sent'`,
    machineId,
  ).toArray() as QueueCountRow[];

  const inflight = inflightRows[0]?.count ?? 0;
  if (inflight >= MAX_INFLIGHT) {
    return 0;
  }

  const toSend = Math.min(BATCH_SIZE, MAX_INFLIGHT - inflight);
  const rows = sql.exec(
    `SELECT command_id, machine_id, session_id, command, chat_id, attempts, command_type, directory, media_json
     FROM command_queue
     WHERE machine_id = ?
       AND status IN ('pending', 'sent')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY created_at ASC
     LIMIT ?`,
    machineId,
    now,
    toSend,
  ).toArray() as QueueCommandRow[];

  for (const row of rows) {
    sendCommand(sql, ws, row.command_id, row.session_id, row.command, row.chat_id, now, row.command_type, row.directory, row.media_json);
  }

  return rows.length;
}

export function markCommandAcked(
  sql: SqlStorage,
  commandId: string,
  machineId: string,
  now = Date.now(),
): boolean {
  const result = sql.exec(
    `UPDATE command_queue
     SET status = 'acked', acked_at = ?
     WHERE command_id = ? AND machine_id = ?`,
    now,
    commandId,
    machineId,
  );

  return result.rowsWritten > 0;
}

export function retrySentCommands(
  sql: SqlStorage,
  getMachineWebSocket: (machineId: string) => CommandWsLike | null,
  now = Date.now(),
): number {
  const cutoff = now - RETRY_INTERVAL_MS;
  const rows = sql.exec(
    `SELECT command_id, machine_id, session_id, command, chat_id, attempts, command_type, directory, media_json
     FROM command_queue
     WHERE status = 'sent'
       AND sent_at < ?
       AND attempts < ?
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     LIMIT ?`,
    cutoff,
    MAX_ATTEMPTS,
    now,
    RETRY_SWEEP_LIMIT,
  ).toArray() as QueueCommandRow[];

  for (const row of rows) {
    const ws = getMachineWebSocket(row.machine_id);
    if (ws && ws.readyState === 1) {
      sendCommand(sql, ws, row.command_id, row.session_id, row.command, row.chat_id, now, row.command_type, row.directory, row.media_json);
      continue;
    }

    const backoffMs = Math.min(1000 * (2 ** row.attempts), 300_000);
    sql.exec(
      `UPDATE command_queue
       SET next_retry_at = ?
       WHERE command_id = ?`,
      now + backoffMs,
      row.command_id,
    );
  }

  return rows.length;
}

export function cleanupCommandQueue(
  sql: SqlStorage,
  now = Date.now(),
): { ackedDeleted: number; stuckDeleted: number } {
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const acked = sql.exec(
    `DELETE FROM command_queue
     WHERE status = 'acked' AND acked_at < ?`,
    oneHourAgo,
  );

  const stuck = sql.exec(
    `DELETE FROM command_queue
     WHERE status != 'acked' AND created_at < ?`,
    oneDayAgo,
  );

  return {
    ackedDeleted: acked.rowsWritten,
    stuckDeleted: stuck.rowsWritten,
  };
}

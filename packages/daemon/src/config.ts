export interface DaemonConfig {
  port: number;
  dbPath: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  workerUrl?: string;
  workerApiKey?: string;
  machineId?: string;
  opencodeUrl?: string;
  serveEndpoints: string[];
  leaseTtlMs: number;
  staleServeMs: number;
  healthPollMs: number;
  activeTurnCap: number;
  idleMigrateMs: number;
  dormantTtlMs: number;
  bindHost: string;
  authToken?: string;
}

const DEFAULT_PORT = 4731;

export function parsePort(value: string | undefined): number {
  if (!value || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PIGEON_DAEMON_PORT: ${value}`);
  }

  return parsed;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function numOr(value: string | undefined, defaultValue: number): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  const defaultDbPath = `${process.cwd()}/data/pigeon-daemon.db`;
  const opencodeUrl = env.OPENCODE_URL?.trim() || undefined;
  const serveEndpoints = parseList(env.PIGEON_SERVE_ENDPOINTS);

  return {
    port: parsePort(env.PIGEON_DAEMON_PORT),
    dbPath: env.PIGEON_DAEMON_DB_PATH?.trim() || defaultDbPath,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || env.TELEGRAM_GROUP_ID?.trim() || undefined,
    workerUrl: env.CCR_WORKER_URL?.trim() || undefined,
    workerApiKey: env.CCR_API_KEY?.trim() || undefined,
    machineId: env.CCR_MACHINE_ID?.trim() || undefined,
    opencodeUrl,
    serveEndpoints: serveEndpoints.length > 0 ? serveEndpoints : (opencodeUrl ? [opencodeUrl] : []),
    leaseTtlMs:   numOr(env.PIGEON_LEASE_TTL_MS, 30_000),
    staleServeMs: numOr(env.PIGEON_SERVE_STALE_MS, 15_000),
    healthPollMs: numOr(env.PIGEON_HEALTH_POLL_MS, 5_000),
    activeTurnCap: numOr(env.PIGEON_ACTIVE_TURN_CAP, 25),
    idleMigrateMs: numOr(env.PIGEON_IDLE_MIGRATE_MS, 60_000),
    dormantTtlMs:  numOr(env.PIGEON_DORMANT_TTL_MS, 300_000),
    bindHost: env.PIGEON_BIND_HOST?.trim() || "127.0.0.1",
    authToken: env.PIGEON_DAEMON_AUTH_TOKEN?.trim() || undefined,
  };
}

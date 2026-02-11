export interface DaemonConfig {
  port: number;
  dbPath: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  workerUrl?: string;
  workerApiKey?: string;
  machineId?: string;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  const defaultDbPath = `${process.cwd()}/data/pigeon-daemon.db`;

  return {
    port: parsePort(env.PIGEON_DAEMON_PORT),
    dbPath: env.PIGEON_DAEMON_DB_PATH?.trim() || defaultDbPath,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || env.TELEGRAM_GROUP_ID?.trim() || undefined,
    workerUrl: env.CCR_WORKER_URL?.trim() || undefined,
    workerApiKey: env.CCR_API_KEY?.trim() || undefined,
    machineId: env.CCR_MACHINE_ID?.trim() || undefined,
  };
}

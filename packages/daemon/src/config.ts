export interface DaemonConfig {
  port: number;
  dbPath: string;
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
  };
}

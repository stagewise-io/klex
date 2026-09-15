import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface RuntimeConfig {
  cwd: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  warnsAboutRemoteAccess: boolean;
}

export interface RawRuntimeConfig {
  cwd?: string;
  host?: string;
  port?: string;
  logLevel?: string;
}

export async function resolveRuntimeConfig(
  raw: RawRuntimeConfig,
  processCwd: string,
): Promise<RuntimeConfig> {
  const cwd = resolve(raw.cwd ?? processCwd);
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    throw new Error(
      `Working directory does not exist or is not a directory: ${cwd}`,
    );
  }

  const host = raw.host?.trim() || '127.0.0.1';
  const port = Number(raw.port ?? '3123');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `Invalid port: ${raw.port ?? port}. Expected an integer from 0 to 65535.`,
    );
  }

  const logLevel = (raw.logLevel ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(
      `Invalid log level: ${raw.logLevel}. Expected ${LOG_LEVELS.join(', ')}.`,
    );
  }

  return {
    cwd,
    host,
    port,
    logLevel: logLevel as LogLevel,
    warnsAboutRemoteAccess: !isLoopbackHost(host),
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost') return true;
  try {
    const canonical = new URL(
      `http://${normalized.includes(':') ? `[${normalized}]` : normalized}`,
    ).hostname.replace(/^\[|\]$/g, '');
    return (
      canonical === '::1' ||
      canonical === '::ffff:7f00:1' ||
      canonical.startsWith('127.')
    );
  } catch {
    return false;
  }
}

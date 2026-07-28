import type { LogLevel } from '@stagewise/logger';

export interface WindowsUseConfig {
  readonly gatewayUrl: URL;
  readonly gatewayToken: string;
  readonly windowsMcpCommand: string;
  readonly windowsMcpPort: number;
  readonly logLevel: LogLevel;
}

export type WindowsUseEnvironment = Readonly<
  Record<string, string | undefined>
>;

const DEFAULT_WINDOWS_MCP_COMMAND = 'uvx';
const DEFAULT_WINDOWS_MCP_PORT = 8123;
const DEFAULT_LOG_LEVEL: LogLevel = 'INFO';
const LOG_LEVELS = new Set<LogLevel>([
  'SILLY',
  'TRACE',
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
  'FATAL',
]);

export function createConfig(
  environment: WindowsUseEnvironment = process.env,
): WindowsUseConfig {
  const gatewayUrl = parseGatewayUrl(
    required(environment.GATEWAY_URL, 'GATEWAY_URL'),
  );
  const gatewayToken = required(environment.GATEWAY_TOKEN, 'GATEWAY_TOKEN');
  const windowsMcpCommand = optional(
    environment.WINDOWS_MCP_COMMAND,
    DEFAULT_WINDOWS_MCP_COMMAND,
    'WINDOWS_MCP_COMMAND',
  );
  const windowsMcpPort = parsePort(environment.WINDOWS_MCP_PORT);
  const logLevel = parseLogLevel(environment.LOG_LEVEL);

  return {
    gatewayUrl,
    gatewayToken,
    windowsMcpCommand,
    windowsMcpPort,
    logLevel,
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optional(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function parseGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GATEWAY_URL must be a valid URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('GATEWAY_URL must use ws: or wss:');
  }
  return url;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WINDOWS_MCP_PORT;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('WINDOWS_MCP_PORT must be an integer from 1 to 65535');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('WINDOWS_MCP_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return DEFAULT_LOG_LEVEL;
  const normalized = value.trim().toUpperCase() as LogLevel;
  if (!LOG_LEVELS.has(normalized)) {
    throw new Error(
      'LOG_LEVEL must be SILLY, TRACE, DEBUG, INFO, WARN, ERROR, or FATAL',
    );
  }
  return normalized;
}

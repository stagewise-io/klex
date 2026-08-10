import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { LogLevel } from '@stagewise/logger';

export interface WindowsUseConfig {
  readonly gatewayUrl: URL;
  readonly gatewayToken: string;
  readonly windowsMcpCommand: string;
  readonly windowsMcpLaunchMode: 'executable' | 'uvx';
  readonly windowsMcpPort: number;
  readonly logLevel: LogLevel;
}

export type WindowsUseEnvironment = Readonly<
  Record<string, string | undefined>
>;

interface WindowsUseFileConfig {
  readonly gatewayUrl?: unknown;
  readonly gatewayToken?: unknown;
  readonly windowsMcpCommand?: unknown;
  readonly windowsMcpLaunchMode?: unknown;
  readonly windowsMcpPort?: unknown;
  readonly logLevel?: unknown;
}

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
  configPath?: string,
): WindowsUseConfig {
  const file = configPath ? readConfigFile(configPath) : undefined;
  const gatewayUrl = parseGatewayUrl(
    required(
      environment.GATEWAY_URL ?? stringValue(file?.gatewayUrl),
      'GATEWAY_URL',
    ),
  );
  const gatewayToken = required(
    environment.GATEWAY_TOKEN ?? stringValue(file?.gatewayToken),
    'GATEWAY_TOKEN',
  );
  const fileCommand = stringValue(file?.windowsMcpCommand);
  const windowsMcpCommand = resolveCommand(
    optional(
      environment.WINDOWS_MCP_COMMAND ?? fileCommand,
      DEFAULT_WINDOWS_MCP_COMMAND,
      'WINDOWS_MCP_COMMAND',
    ),
    configPath,
    environment.WINDOWS_MCP_COMMAND === undefined && fileCommand !== undefined,
  );
  const windowsMcpLaunchMode = parseLaunchMode(
    environment.WINDOWS_MCP_LAUNCH_MODE ??
      stringValue(file?.windowsMcpLaunchMode),
    configPath ? 'executable' : 'uvx',
  );
  const windowsMcpPort = parsePort(
    environment.WINDOWS_MCP_PORT ?? numberValue(file?.windowsMcpPort),
  );
  const logLevel = parseLogLevel(
    environment.LOG_LEVEL ?? stringValue(file?.logLevel),
  );

  return {
    gatewayUrl,
    gatewayToken,
    windowsMcpCommand,
    windowsMcpLaunchMode,
    windowsMcpPort,
    logLevel,
  };
}

function readConfigFile(path: string): WindowsUseFileConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read Windows Use config at ${path}`, {
      cause: error,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Windows Use config must contain a JSON object');
  }
  return value as WindowsUseFileConfig;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

function resolveCommand(
  command: string,
  configPath: string | undefined,
  fromFile: boolean,
): string {
  if (!fromFile || !configPath || isAbsolute(command)) return command;
  return resolve(dirname(configPath), command);
}

function parseLaunchMode(
  value: string | undefined,
  fallback: 'executable' | 'uvx',
): 'executable' | 'uvx' {
  const normalized = value?.trim().toLowerCase() ?? fallback;
  if (normalized !== 'executable' && normalized !== 'uvx') {
    throw new Error('WINDOWS_MCP_LAUNCH_MODE must be executable or uvx');
  }
  return normalized;
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

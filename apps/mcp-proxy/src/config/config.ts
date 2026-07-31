import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createEnvironmentId,
  type EnvironmentId,
} from '@stagewise/mcp-proxy-sdk/core';

export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  authenticateEnvironment(token: string | undefined): EnvironmentId | undefined;
  parseEnvironmentId(value: string): EnvironmentId;
}

interface ParsedConfig {
  readonly host: string;
  readonly port: number;
  readonly environmentsByToken: ReadonlyMap<string, EnvironmentId>;
  readonly environmentsById: ReadonlyMap<string, EnvironmentId>;
}

class ProxyConfigModule implements ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly #environmentsByToken: ReadonlyMap<string, EnvironmentId>;
  readonly #environmentsById: ReadonlyMap<string, EnvironmentId>;

  constructor(config: ParsedConfig) {
    this.host = config.host;
    this.port = config.port;
    this.#environmentsByToken = config.environmentsByToken;
    this.#environmentsById = config.environmentsById;
  }

  authenticateEnvironment(
    token: string | undefined,
  ): EnvironmentId | undefined {
    return token ? this.#environmentsByToken.get(token) : undefined;
  }

  parseEnvironmentId(value: string): EnvironmentId {
    const environmentId = this.#environmentsById.get(value);
    if (!environmentId) throw new Error(`Unknown environment: ${value}`);
    return environmentId;
  }
}

export function createConfig(
  configPath = resolve('mcp-proxy.config.json'),
): ProxyConfig {
  let contents: string;
  try {
    contents = readFileSync(configPath, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read MCP proxy config at ${configPath}`, {
      cause,
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Invalid JSON in MCP proxy config at ${configPath}`, {
      cause,
    });
  }

  try {
    return new ProxyConfigModule(parseConfig(input));
  } catch (cause) {
    throw new Error(`Invalid MCP proxy config at ${configPath}`, { cause });
  }
}

function parseConfig(input: unknown): ParsedConfig {
  const root = object(input, 'config');
  const host = nonEmptyString(root.host, 'host');
  const port = tcpPort(root.port);
  const environmentInputs = nonEmptyArray(root.environments, 'environments');
  const tokens = new Set<string>();
  const environmentsByToken = new Map<string, EnvironmentId>();
  const environmentsById = new Map<string, EnvironmentId>();

  for (const [index, environmentInput] of environmentInputs.entries()) {
    const path = `environments[${index}]`;
    const environment = object(environmentInput, path);
    const environmentIdValue = nonEmptyString(
      environment.environmentId,
      `${path}.environmentId`,
    );
    unique(environmentsById, environmentIdValue, 'environment ID');
    const environmentId = createEnvironmentId(environmentIdValue);
    const token = credential(environment.token, `${path}.token`);
    unique(tokens, token, 'environment token');
    environmentsById.set(environmentIdValue, environmentId);
    environmentsByToken.set(token, environmentId);
  }

  return { host, port, environmentsByToken, environmentsById };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function nonEmptyArray(value: unknown, path: string): unknown[] {
  const result = array(value, path);
  if (result.length === 0) throw new TypeError(`${path} must not be empty`);
  return result;
}

function nonEmptyString(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${path} must be a non-empty, trimmed string`);
  }
  return value;
}

function credential(value: unknown, path: string): string {
  return nonEmptyString(value, path);
}

function tcpPort(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 65_535
  ) {
    throw new TypeError('port must be a valid TCP port');
  }
  return value as number;
}

function unique(
  values: Set<string> | Map<string, unknown>,
  value: string,
  description: string,
): void {
  if (values.has(value)) throw new Error(`Duplicate ${description}: ${value}`);
  if (values instanceof Set) values.add(value);
}

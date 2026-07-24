import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type AgentPrincipal,
  createAgentId,
  createEnvironmentId,
  createTenantId,
  type EnvironmentId,
  type EnvironmentPrincipal,
} from '@stagewise/mcp-gateway-sdk/core';

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  authenticateAgent(token: string | undefined): AgentPrincipal | undefined;
  authenticateEnvironment(
    token: string | undefined,
  ): EnvironmentPrincipal | undefined;
  authorize(agent: AgentPrincipal, environment: EnvironmentPrincipal): boolean;
  parseEnvironmentId(value: string): EnvironmentId;
}

interface AgentRecord {
  readonly principal: AgentPrincipal;
  readonly environmentGrants: ReadonlySet<EnvironmentId>;
}

interface ParsedConfig {
  readonly host: string;
  readonly port: number;
  readonly agentsByToken: ReadonlyMap<string, AgentRecord>;
  readonly environmentsByToken: ReadonlyMap<string, EnvironmentPrincipal>;
  readonly environmentsById: ReadonlyMap<string, EnvironmentId>;
}

class GatewayConfigModule implements GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly #agentsByToken: ReadonlyMap<string, AgentRecord>;
  readonly #environmentsByToken: ReadonlyMap<string, EnvironmentPrincipal>;
  readonly #environmentsById: ReadonlyMap<string, EnvironmentId>;

  constructor(config: ParsedConfig) {
    this.host = config.host;
    this.port = config.port;
    this.#agentsByToken = config.agentsByToken;
    this.#environmentsByToken = config.environmentsByToken;
    this.#environmentsById = config.environmentsById;
  }

  authenticateAgent(token: string | undefined): AgentPrincipal | undefined {
    return token ? this.#agentsByToken.get(token)?.principal : undefined;
  }

  authenticateEnvironment(
    token: string | undefined,
  ): EnvironmentPrincipal | undefined {
    return token ? this.#environmentsByToken.get(token) : undefined;
  }

  authorize(agent: AgentPrincipal, environment: EnvironmentPrincipal): boolean {
    for (const record of this.#agentsByToken.values()) {
      if (
        record.principal.tenantId === agent.tenantId &&
        record.principal.agentId === agent.agentId
      ) {
        return (
          environment.tenantId === agent.tenantId &&
          record.environmentGrants.has(environment.environmentId)
        );
      }
    }
    return false;
  }

  parseEnvironmentId(value: string): EnvironmentId {
    const environmentId = this.#environmentsById.get(value);
    if (!environmentId) throw new Error(`Unknown environment: ${value}`);
    return environmentId;
  }
}

export function createConfig(
  configPath = resolve('mcp-gateway.config.json'),
): GatewayConfig {
  let contents: string;
  try {
    contents = readFileSync(configPath, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read MCP gateway config at ${configPath}`, {
      cause,
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Invalid JSON in MCP gateway config at ${configPath}`, {
      cause,
    });
  }

  try {
    return new GatewayConfigModule(parseConfig(input));
  } catch (cause) {
    throw new Error(`Invalid MCP gateway config at ${configPath}`, { cause });
  }
}

function parseConfig(input: unknown): ParsedConfig {
  const root = object(input, 'config');
  const host = nonEmptyString(root.host, 'host');
  const port = tcpPort(root.port);
  const tenants = nonEmptyArray(root.tenants, 'tenants');
  const tenantIds = new Set<string>();
  const tokens = new Set<string>();
  const agentsByToken = new Map<string, AgentRecord>();
  const environmentsByToken = new Map<string, EnvironmentPrincipal>();
  const environmentsById = new Map<string, EnvironmentId>();

  for (const [tenantIndex, tenantInput] of tenants.entries()) {
    const path = `tenants[${tenantIndex}]`;
    const tenant = object(tenantInput, path);
    const tenantIdValue = nonEmptyString(tenant.tenantId, `${path}.tenantId`);
    unique(tenantIds, tenantIdValue, 'tenant ID');
    const tenantId = createTenantId(tenantIdValue);
    const environmentInputs = nonEmptyArray(
      tenant.environments,
      `${path}.environments`,
    );
    const tenantEnvironmentIds = new Map<string, EnvironmentId>();

    for (const [
      environmentIndex,
      environmentInput,
    ] of environmentInputs.entries()) {
      const environmentPath = `${path}.environments[${environmentIndex}]`;
      const environment = object(environmentInput, environmentPath);
      const environmentIdValue = nonEmptyString(
        environment.environmentId,
        `${environmentPath}.environmentId`,
      );
      unique(
        tenantEnvironmentIds,
        environmentIdValue,
        `environment ID in tenant ${tenantIdValue}`,
      );
      if (environmentsById.has(environmentIdValue)) {
        throw new Error(
          `Environment ID must be globally unique: ${environmentIdValue}`,
        );
      }
      const environmentId = createEnvironmentId(environmentIdValue);
      const token = credential(environment.token, `${environmentPath}.token`);
      unique(tokens, token, 'bearer token');
      const principal: EnvironmentPrincipal = {
        kind: 'environment',
        tenantId,
        environmentId,
      };
      tenantEnvironmentIds.set(environmentIdValue, environmentId);
      environmentsById.set(environmentIdValue, environmentId);
      environmentsByToken.set(token, principal);
    }

    const agentInputs = nonEmptyArray(tenant.agents, `${path}.agents`);
    const tenantAgentIds = new Set<string>();
    for (const [agentIndex, agentInput] of agentInputs.entries()) {
      const agentPath = `${path}.agents[${agentIndex}]`;
      const agent = object(agentInput, agentPath);
      const agentIdValue = nonEmptyString(
        agent.agentId,
        `${agentPath}.agentId`,
      );
      unique(
        tenantAgentIds,
        agentIdValue,
        `agent ID in tenant ${tenantIdValue}`,
      );
      const token = credential(agent.token, `${agentPath}.token`);
      unique(tokens, token, 'bearer token');
      const grantInputs = array(
        agent.environmentGrants,
        `${agentPath}.environmentGrants`,
      );
      const grantValues = new Set<string>();
      const grants = new Set<EnvironmentId>();
      for (const [grantIndex, grantInput] of grantInputs.entries()) {
        const grant = nonEmptyString(
          grantInput,
          `${agentPath}.environmentGrants[${grantIndex}]`,
        );
        unique(grantValues, grant, `grant for agent ${agentIdValue}`);
        const environmentId = tenantEnvironmentIds.get(grant);
        if (!environmentId) {
          throw new Error(
            `Unknown environment grant ${grant} for agent ${agentIdValue}`,
          );
        }
        grants.add(environmentId);
      }
      agentsByToken.set(token, {
        principal: {
          kind: 'agent',
          tenantId,
          agentId: createAgentId(agentIdValue),
        },
        environmentGrants: grants,
      });
    }
  }

  return {
    host,
    port,
    agentsByToken,
    environmentsByToken,
    environmentsById,
  };
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

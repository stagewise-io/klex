import {
  createAgentId,
  createEnvironmentId,
  createTenantId,
} from '@stagewise/mcp-gateway-core';

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly agentToken: string;
  readonly environmentToken: string;
  readonly tenantId: ReturnType<typeof createTenantId>;
  readonly agentId: ReturnType<typeof createAgentId>;
  readonly environmentId: ReturnType<typeof createEnvironmentId>;
}

class GatewayConfigModule implements GatewayConfig {
  readonly host = process.env.MCP_GATEWAY_HOST ?? '127.0.0.1';
  readonly port = parsePort(process.env.MCP_GATEWAY_PORT ?? '3000');
  readonly agentToken = required('MCP_GATEWAY_AGENT_TOKEN');
  readonly environmentToken = required('MCP_GATEWAY_ENVIRONMENT_TOKEN');
  readonly tenantId = createTenantId(
    process.env.MCP_GATEWAY_TENANT_ID ?? 'example-tenant',
  );
  readonly agentId = createAgentId(
    process.env.MCP_GATEWAY_AGENT_ID ?? 'example-agent',
  );
  readonly environmentId = createEnvironmentId(
    process.env.MCP_GATEWAY_ENVIRONMENT_ID ?? 'example-environment',
  );
}

export function createConfig(): GatewayConfig {
  return new GatewayConfigModule();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('MCP_GATEWAY_PORT must be a valid TCP port');
  }
  return port;
}

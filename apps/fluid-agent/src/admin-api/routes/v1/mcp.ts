import type { Context } from 'hono';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, McpServerConfig } from '@/config';
import { ConfigValidationError, mcpServerConfigSchema } from '@/config';
import type { Mcp } from '@/mcp';

export interface McpRouteDependencies {
  config: Config;
  mcp: Mcp;
  logger: ModuleLogger;
}

export function getMcpServers(deps: McpRouteDependencies) {
  return (c: Context) => {
    return c.json({ servers: deps.mcp.getServerStatuses() });
  };
}

export function createMcpServer(deps: McpRouteDependencies) {
  return async (c: Context) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON' }, 400);
    }

    if (
      typeof input !== 'object' ||
      input === null ||
      typeof (input as Record<string, unknown>).name !== 'string' ||
      !(input as Record<string, unknown>).name
    ) {
      return c.json(
        { error: 'Request body must include a non-empty "name" field' },
        400,
      );
    }

    const { name, ...serverConfig } = input as Record<string, unknown> & {
      name: string;
    };

    let server: McpServerConfig;
    try {
      server = mcpServerConfigSchema.parse(serverConfig);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid MCP server config';
      return c.json({ error: message }, 400);
    }

    try {
      await deps.config.addMcpServer(name, server);
      return c.json({ servers: deps.mcp.getServerStatuses() }, 201);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 409);
      }
      deps.logger.error({ error }, 'MCP server create failed');
      return c.json({ error: 'Failed to create MCP server' }, 500);
    }
  };
}

export function updateMcpServer(deps: McpRouteDependencies) {
  return async (c: Context) => {
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'MCP server name is required' }, 400);

    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON' }, 400);
    }

    let server: McpServerConfig;
    try {
      server = mcpServerConfigSchema.parse(input);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid MCP server config';
      return c.json({ error: message }, 400);
    }

    try {
      await deps.config.updateMcpServer(name, server);
      return c.json({ servers: deps.mcp.getServerStatuses() });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 404);
      }
      deps.logger.error({ error }, 'MCP server update failed');
      return c.json({ error: 'Failed to update MCP server' }, 500);
    }
  };
}

export function deleteMcpServer(deps: McpRouteDependencies) {
  return async (c: Context) => {
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'MCP server name is required' }, 400);

    try {
      await deps.config.removeMcpServer(name);
      return c.json({ servers: deps.mcp.getServerStatuses() });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 404);
      }
      deps.logger.error({ error }, 'MCP server delete failed');
      return c.json({ error: 'Failed to delete MCP server' }, 500);
    }
  };
}

export function getMcpToolCallHistory(deps: McpRouteDependencies) {
  return (c: Context) => {
    const namespace = c.req.param('name');
    const history = deps.mcp.getToolCallHistory();
    const filtered = namespace
      ? history.filter((record) => record.namespace === namespace)
      : history;
    return c.json({ toolCalls: filtered });
  };
}

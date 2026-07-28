import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, McpServerConfig } from '@/config';
import { ConfigValidationError } from '@/config';
import type { Mcp } from '@/mcp';

import {
  createMcpServerBodySchema,
  errorResponseSchema,
  mcpServerNameParamSchema,
  mcpServersResponseSchema,
  toolCallHistoryResponseSchema,
  updateMcpServerBodySchema,
} from './schemas';

export interface McpRouteDependencies {
  config: Config;
  mcp: Mcp;
  logger: ModuleLogger;
}

// --- GET /v1/mcp-servers ---

export const getMcpServersRoute = createRoute({
  method: 'get',
  path: '/v1/mcp-servers',
  tags: ['MCP Servers'],
  summary: 'List MCP servers',
  description:
    'Returns the current status of all configured MCP servers including connection state, tool count, and transport type.',
  responses: {
    200: {
      content: {
        'application/json': { schema: mcpServersResponseSchema },
      },
      description: 'List of MCP server statuses',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getMcpServers(
  deps: McpRouteDependencies,
): RouteHandler<typeof getMcpServersRoute> {
  return (c) => {
    return c.json({ servers: deps.mcp.getServerStatuses() }, 200);
  };
}

// --- POST /v1/mcp-servers ---

export const createMcpServerRoute = createRoute({
  method: 'post',
  path: '/v1/mcp-servers',
  tags: ['MCP Servers'],
  summary: 'Add an MCP server',
  description:
    'Adds a new MCP server configuration. The body must include a non-empty "name" field plus either a stdio config (command, args, env) or an HTTP config (url, headers).',
  request: {
    body: {
      content: {
        'application/json': { schema: createMcpServerBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': { schema: mcpServersResponseSchema },
      },
      description: 'MCP server created — returns updated server list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid request body or server configuration',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'A server with this name already exists',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function createMcpServer(
  deps: McpRouteDependencies,
): RouteHandler<typeof createMcpServerRoute> {
  return async (c) => {
    const { name, ...serverConfig } = c.req.valid('json');
    const server = serverConfig as McpServerConfig;

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

// --- PATCH /v1/mcp-servers/{name} ---

export const updateMcpServerRoute = createRoute({
  method: 'patch',
  path: '/v1/mcp-servers/{name}',
  tags: ['MCP Servers'],
  summary: 'Update an MCP server',
  description:
    'Replaces the configuration of an existing MCP server. The body must contain a valid stdio or HTTP server config (without the name field).',
  request: {
    params: mcpServerNameParamSchema,
    body: {
      content: {
        'application/json': { schema: updateMcpServerBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: mcpServersResponseSchema },
      },
      description: 'MCP server updated — returns updated server list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid request body or server configuration',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'MCP server not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function updateMcpServer(
  deps: McpRouteDependencies,
): RouteHandler<typeof updateMcpServerRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const server = c.req.valid('json') as McpServerConfig;

    try {
      await deps.config.updateMcpServer(name, server);
      return c.json({ servers: deps.mcp.getServerStatuses() }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 404);
      }
      deps.logger.error({ error }, 'MCP server update failed');
      return c.json({ error: 'Failed to update MCP server' }, 500);
    }
  };
}

// --- DELETE /v1/mcp-servers/{name} ---

export const deleteMcpServerRoute = createRoute({
  method: 'delete',
  path: '/v1/mcp-servers/{name}',
  tags: ['MCP Servers'],
  summary: 'Remove an MCP server',
  description:
    'Removes an MCP server from the configuration and disconnects it.',
  request: {
    params: mcpServerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: mcpServersResponseSchema },
      },
      description: 'MCP server removed — returns updated server list',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'MCP server not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function deleteMcpServer(
  deps: McpRouteDependencies,
): RouteHandler<typeof deleteMcpServerRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');

    try {
      await deps.config.removeMcpServer(name);
      return c.json({ servers: deps.mcp.getServerStatuses() }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 404);
      }
      deps.logger.error({ error }, 'MCP server delete failed');
      return c.json({ error: 'Failed to delete MCP server' }, 500);
    }
  };
}

// --- GET /v1/mcp-servers/{name}/tool-calls ---

export const getMcpToolCallHistoryRoute = createRoute({
  method: 'get',
  path: '/v1/mcp-servers/{name}/tool-calls',
  tags: ['MCP Servers'],
  summary: 'Get tool call history',
  description:
    'Returns the recorded history of tool calls made to MCP servers. When a name is provided, results are filtered to that namespace.',
  request: {
    params: mcpServerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: toolCallHistoryResponseSchema },
      },
      description: 'Tool call history (filtered by namespace)',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getMcpToolCallHistory(
  deps: McpRouteDependencies,
): RouteHandler<typeof getMcpToolCallHistoryRoute> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((c: any) => {
    const { name } = c.req.valid('param') as { name: string };
    const history = deps.mcp.getToolCallHistory();
    const filtered = history.filter((record) => record.namespace === name);
    return c.json({ toolCalls: filtered }, 200);
  }) as RouteHandler<typeof getMcpToolCallHistoryRoute>;
}

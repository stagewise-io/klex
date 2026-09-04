import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, McpServerConfig } from '@/config';
import { ConfigValidationError } from '@/config';
import type { Mcp } from '@/mcp';

import {
  createMcpServerBodySchema,
  errorResponseSchema,
  mcpServerNameParamSchema,
  mcpServerResponseSchema,
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
    'Returns sanitized status for all configured MCP servers, including any pending OAuth authorization, the last connection failure, and the next scheduled retry. OAuth URLs, callback data, and credentials are never returned.',
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

// --- GET /v1/mcp-servers/{name} ---

export const getMcpServerRoute = createRoute({
  method: 'get',
  path: '/v1/mcp-servers/{name}',
  tags: ['MCP Servers'],
  summary: 'Get one MCP server',
  description:
    'Returns sanitized status for a single MCP server, including any pending OAuth authorization. Poll this while an authorization is in flight instead of re-issuing the authorization request.',
  request: {
    params: mcpServerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: mcpServerResponseSchema },
      },
      description: 'MCP server status',
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

export function getMcpServer(
  deps: McpRouteDependencies,
): RouteHandler<typeof getMcpServerRoute> {
  return (c) => {
    const { name } = c.req.valid('param');
    const server = deps.mcp
      .getServerStatuses()
      .find((status) => status.name === name);
    if (!server) {
      return c.json(
        { error: 'MCP server not found', code: 'server_not_found' },
        404,
      );
    }
    return c.json({ server }, 200);
  };
}

// --- POST /v1/mcp-servers ---

export const createMcpServerRoute = createRoute({
  method: 'post',
  path: '/v1/mcp-servers',
  tags: ['MCP Servers'],
  summary: 'Add an MCP server',
  description:
    'Adds a new MCP server configuration. The body must include a non-empty "name" plus either stdio configuration or HTTP configuration. Remote HTTP servers automatically negotiate MCP OAuth when challenged unless an Authorization header is configured.',
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
    const server: McpServerConfig = serverConfig;

    try {
      await deps.config.addMcpServer(name, server);
      return c.json({ servers: deps.mcp.getServerStatuses() }, 201);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message, code: 'server_exists' }, 409);
      }
      deps.logger.error({ error }, 'MCP server create failed');
      return c.json(
        { error: 'Failed to create MCP server', code: 'internal_error' },
        500,
      );
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
    'Replaces an MCP server configuration. Remote HTTP servers automatically negotiate MCP OAuth when challenged unless an Authorization header is configured.',
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
    const server: McpServerConfig = c.req.valid('json');

    try {
      await deps.config.updateMcpServer(name, server);
      return c.json({ servers: deps.mcp.getServerStatuses() }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message, code: 'server_not_found' }, 404);
      }
      deps.logger.error({ error }, 'MCP server update failed');
      return c.json(
        { error: 'Failed to update MCP server', code: 'internal_error' },
        500,
      );
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
        return c.json({ error: error.message, code: 'server_not_found' }, 404);
      }
      deps.logger.error({ error }, 'MCP server delete failed');
      return c.json(
        { error: 'Failed to delete MCP server', code: 'internal_error' },
        500,
      );
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
  // biome-ignore lint/suspicious/noExplicitAny: RouteHandler generic causes TS2589 type instantiation depth exceeded
  return ((c: any) => {
    const { name } = c.req.valid('param') as { name: string };
    const history = deps.mcp.getToolCallHistory();
    const filtered = history.filter((record) => record.namespace === name);
    return c.json({ toolCalls: filtered }, 200);
  }) as RouteHandler<typeof getMcpToolCallHistoryRoute>;
}

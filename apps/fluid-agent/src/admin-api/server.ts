import { type Hook, OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { Mcp } from '@/mcp';
import type { Router } from '@/router';

import { getHealth, healthRoute } from './routes/v1/health';
import {
  createMcpServer,
  createMcpServerRoute,
  deleteMcpServer,
  deleteMcpServerRoute,
  getMcpServers,
  getMcpServersRoute,
  getMcpToolCallHistory,
  getMcpToolCallHistoryRoute,
  updateMcpServer,
  updateMcpServerRoute,
} from './routes/v1/mcp';
import { getSessions, sessionsRoute } from './routes/v1/sessions';
import {
  getModelSelection,
  getModelSelectionRoute,
  patchModelSelection,
  patchModelSelectionRoute,
} from './routes/v1/settings';

export interface AdminAppDependencies {
  config: Config;
  mcp: Mcp;
  router: Router;
  logger: ModuleLogger;
}

// biome-ignore lint/suspicious/noExplicitAny: Hook generic parameters are opaque validation types
const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((i) =>
        i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
      )
      .join('; ');
    return c.json({ error: message }, 400);
  }
};

export function createAdminApp(deps: AdminAppDependencies): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: validationHook,
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    deps.logger.error({ error: err }, 'Unhandled error in admin API');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Health
  app.openapi(healthRoute, getHealth());

  // Settings
  app.openapi(getModelSelectionRoute, getModelSelection(deps));
  app.openapi(patchModelSelectionRoute, patchModelSelection(deps));

  // Sessions
  app.openapi(sessionsRoute, getSessions({ router: deps.router }));

  // MCP Servers
  app.openapi(getMcpServersRoute, getMcpServers(deps));
  app.openapi(createMcpServerRoute, createMcpServer(deps));
  app.openapi(updateMcpServerRoute, updateMcpServer(deps));
  app.openapi(deleteMcpServerRoute, deleteMcpServer(deps));
  app.openapi(getMcpToolCallHistoryRoute, getMcpToolCallHistory(deps));

  // OpenAPI spec endpoint
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Fluid Agent Admin API',
      version: '1.0.0',
      description:
        'Observability and management API for the Fluid Agent admin plane. Provides session state, token consumption, MCP connection status, tool call history, and configuration management.',
    },
    servers: [{ url: 'http://0.0.0.0:2706' }],
  });

  return app;
}

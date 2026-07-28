import { Hono } from 'hono';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { Mcp } from '@/mcp';
import type { Router } from '@/router';

import { getHealth } from './routes/v1/health';
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServers,
  getMcpToolCallHistory,
  updateMcpServer,
} from './routes/v1/mcp';
import { getSessions } from './routes/v1/sessions';
import { getModelSelection, patchModelSelection } from './routes/v1/settings';

export interface AdminAppDependencies {
  config: Config;
  mcp: Mcp;
  router: Router;
  logger: ModuleLogger;
}

export function createAdminApp(deps: AdminAppDependencies): Hono {
  const app = new Hono();

  app.get('/v1/health', getHealth);

  app.get('/v1/settings/model-selection', getModelSelection(deps));
  app.patch('/v1/settings/model-selection', patchModelSelection(deps));

  app.get('/v1/sessions', getSessions({ router: deps.router }));

  app.get('/v1/mcp-servers', getMcpServers(deps));
  app.post('/v1/mcp-servers', createMcpServer(deps));
  app.patch('/v1/mcp-servers/:name', updateMcpServer(deps));
  app.delete('/v1/mcp-servers/:name', deleteMcpServer(deps));
  app.get('/v1/mcp-servers/:name/tool-calls', getMcpToolCallHistory(deps));

  return app;
}

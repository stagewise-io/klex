import type { ModuleLogger } from '@stagewise/logger';
import { Hono } from 'hono';
import type { Config } from '../config/config';
import { getConfig, putConfig } from './routes/v1/config';
import { getHealth } from './routes/v1/health';

export interface AdminAppDependencies {
  config: Config;
  logger: ModuleLogger;
}

export function createAdminApp(deps: AdminAppDependencies): Hono {
  const app = new Hono();

  app.get('/v1/health', getHealth);
  app.get('/v1/config', getConfig(deps));
  app.put('/v1/config', putConfig(deps));

  return app;
}

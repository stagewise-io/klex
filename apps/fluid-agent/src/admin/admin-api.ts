import { type ServerType, serve } from '@hono/node-server';
import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type { Config } from '../config/config';
import { createAdminApp } from './server';

export interface AdminApiDependencies {
  logging: RootLogger;
  config: Config;
}

export interface AdminApi {
  start(): Promise<void>;
  close(): Promise<void>;
}

class AdminApiModule implements AdminApi {
  private server: ServerType | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const app = createAdminApp({
      config: this.deps.config,
      logger: this.deps.logger,
    });

    this.server = await new Promise<ServerType>((resolve) => {
      const server = serve(
        { fetch: app.fetch, port: 2706, hostname: '0.0.0.0' },
        (info) => {
          this.deps.logger.info(
            { address: info.address, port: info.port },
            'AdminAPI listening',
          );
          resolve(server);
        },
      );
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    this.deps.logger.info('AdminAPI stopped');
  }
}

export function createAdminApi(deps: AdminApiDependencies): AdminApi {
  return new AdminApiModule({
    logger: deps.logging.child({
      name: 'admin-api',
      bindings: { module: 'admin-api' },
    }),
    config: deps.config,
  });
}

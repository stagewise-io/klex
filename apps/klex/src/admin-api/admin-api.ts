import { type ServerType, serve } from '@hono/node-server';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { Introspector } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ModelCallLogger } from '@/model-call-logger';

import { createAdminApp } from './server';

export interface AdminApiDependencies {
  logging: RootLogger;
  config: Config;
  mcp: Mcp;
  introspector: Introspector;
  modelCallLogger: ModelCallLogger;
  cloudEnabled: boolean;
  port: number;
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
      mcp: Mcp;
      introspector: Introspector;
      modelCallLogger: ModelCallLogger;
      cloudEnabled: boolean;
      port: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const app = createAdminApp({
      config: this.deps.config,
      mcp: this.deps.mcp,
      introspector: this.deps.introspector,
      modelCallLogger: this.deps.modelCallLogger,
      logger: this.deps.logger,
      port: this.deps.port,
    });

    if (this.deps.cloudEnabled) {
      this.deps.logger.info(
        'AdminAPI running in tunnel-only mode — local port not bound',
      );
      return;
    }

    this.server = await new Promise<ServerType>((resolve) => {
      const server = serve(
        { fetch: app.fetch, port: this.deps.port, hostname: '0.0.0.0' },
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
    mcp: deps.mcp,
    introspector: deps.introspector,
    modelCallLogger: deps.modelCallLogger,
    cloudEnabled: deps.cloudEnabled,
    port: deps.port,
  });
}

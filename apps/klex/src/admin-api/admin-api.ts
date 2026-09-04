import { type ServerType, serve } from '@hono/node-server';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';
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
  cloudConnectivity: CloudConnectivity;
  localPort: number | undefined;
}

export interface AdminApi {
  start(): Promise<void>;
  close(): Promise<void>;
  handle(request: Request): Response | Promise<Response>;
}

class AdminApiModule implements AdminApi {
  private server: ServerType | null = null;
  private app: ReturnType<typeof createAdminApp> | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
      mcp: Mcp;
      introspector: Introspector;
      modelCallLogger: ModelCallLogger;
      cloudConnectivity: CloudConnectivity;
      localPort: number | undefined;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.app = createAdminApp({
      config: this.deps.config,
      mcp: this.deps.mcp,
      introspector: this.deps.introspector,
      modelCallLogger: this.deps.modelCallLogger,
      cloudConnectivity: this.deps.cloudConnectivity,
      logger: this.deps.logger,
      localPort: this.deps.localPort,
    });

    if (this.deps.localPort === undefined) {
      this.deps.logger.info('AdminAPI running without a local port');
      return;
    }

    // Loopback only: the admin API has no authentication middleware and its
    // routes expose configuration and provider data. Binding 0.0.0.0 exposed
    // that to the whole local network under `--no-cloud`. Use the IPv4
    // literal rather than 'localhost', which can resolve to IPv6 ::1 only.
    const app = this.app;
    this.server = await new Promise<ServerType>((resolve) => {
      const server = serve(
        {
          fetch: app.fetch,
          port: this.deps.localPort,
          hostname: '127.0.0.1',
        },
        (info) => {
          this.deps.logger.warn(
            { address: info.address, port: info.port },
            'DANGER: unauthenticated Admin API is available on a local port',
          );
          resolve(server);
        },
      );
    });
  }

  handle(request: Request): Response | Promise<Response> {
    if (!this.app) throw new Error('Admin API is not started');
    return this.app.fetch(request);
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
    cloudConnectivity: deps.cloudConnectivity,
    localPort: deps.localPort,
  });
}

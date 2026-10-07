import { createServer, type Server } from 'node:http';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

export interface HealthServer {
  start(): Promise<void>;
  markReady(): void;
  /** Permanently revokes readiness for this process. */
  markNotReady(): void;
  close(): Promise<void>;
}

export interface HealthServerDependencies {
  logging: RootLogger;
  port: number;
  host: string;
}

class HealthServerModule implements HealthServer {
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private ready = false;
  private stopping = false;

  constructor(
    private readonly deps: Omit<HealthServerDependencies, 'logging'> & {
      logger: ModuleLogger;
    },
  ) {}

  start(): Promise<void> {
    this.starting ??= this.listen();
    return this.starting;
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET' && request.url === '/livez') {
        response.writeHead(200).end('ok\n');
      } else if (request.method === 'GET' && request.url === '/readyz') {
        response
          .writeHead(this.ready ? 200 : 503)
          .end(this.ready ? 'ok\n' : 'not ready\n');
      } else {
        response.writeHead(404).end('not found\n');
      }
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.deps.port, this.deps.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    this.deps.logger.info(
      { port: this.deps.port, host: this.deps.host },
      'Health listener started',
    );
  }

  markReady(): void {
    if (!this.stopping) this.ready = true;
  }

  markNotReady(): void {
    this.stopping = true;
    this.ready = false;
  }

  close(): Promise<void> {
    if (!this.starting) return Promise.resolve();
    this.markNotReady();
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    this.server = undefined;
  }
}

export function createHealthServer(
  deps: HealthServerDependencies,
): HealthServer {
  const { logging, ...rest } = deps;
  return new HealthServerModule({
    ...rest,
    logger: logging.child({
      name: 'health-server',
      bindings: { module: 'health-server' },
    }),
  });
}

import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';

import type { RuntimeConfig } from './config.js';
import { createMachineLogger, type MachineLogger } from './logger.js';
import { createMachineMcp, type MachineMcp } from './mcp.js';
import {
  createNotificationStore,
  type NotificationStore,
} from './notifications/index.js';

export type { MachineLogger } from './logger.js';

export interface MachineServer {
  host: string;
  port: number;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface MachineServerOptions {
  mcp?: MachineMcp;
  logger?: MachineLogger;
  registerSignals?: boolean;
  /** Directory for persisted notification state. Memory-only when omitted. */
  dataDir?: string;
}

export function createMachineApp(mcp: MachineMcp, host = '127.0.0.1') {
  const app = createMcpHonoApp({ host });
  app.get('/health', (context) =>
    context.json({ status: 'ok', service: 'klex-machine' }),
  );
  app.all('/mcp', (context) => mcp.fetch(context.req.raw));
  return app;
}

export async function startMachineServer(
  config: RuntimeConfig,
  options: MachineServerOptions = {},
): Promise<MachineServer> {
  const logger = options.logger ?? createMachineLogger(config.logLevel);
  let store: NotificationStore | undefined;
  let mcp: MachineMcp;
  if (options.mcp) {
    mcp = options.mcp;
  } else {
    store = createNotificationStore({ dataDir: options.dataDir, logger });
    await store.ready();
    mcp = createMachineMcp(config.cwd, { notifications: store, logger });
  }
  const app = createMachineApp(mcp, config.host);

  const listener = await new Promise<ReturnType<typeof serve>>(
    (resolve, reject) => {
      const onStartupError = (error: Error) => reject(error);
      const server = serve(
        { fetch: app.fetch, hostname: config.host, port: config.port },
        () => {
          server.off('error', onStartupError);
          resolve(server);
        },
      );
      server.once('error', onStartupError);
    },
  ).catch(async (error) => {
    try {
      await mcp.close();
    } finally {
      await store?.close();
    }
    throw error;
  });
  listener.on('error', (error) => {
    logger.error({ error }, 'klex-machine listener error');
  });

  const address = listener.address();
  const port =
    typeof address === 'object' && address ? address.port : config.port;
  if (config.warnsAboutRemoteAccess) {
    logger.warn(
      { host: config.host, port },
      'UNRESTRICTED, UNAUTHENTICATED machine access is exposed on a non-loopback interface',
    );
  }
  logger.info(
    { cwd: config.cwd, host: config.host, port },
    'klex-machine MCP server listening',
  );

  let closing: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      // Stop accepting requests first, but close SSE streams before waiting for
      // the listener. Active subscription responses would otherwise block close.
      const listenerClosed = new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
      try {
        // Wait for every cleanup to settle before releasing the writer lock.
        const results = await Promise.allSettled([
          listenerClosed,
          Promise.resolve().then(() => mcp.close()),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        await store?.close();
      }
    })();
    return closing;
  };

  if (options.registerSignals !== false) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        logger.info({ signal }, 'Shutting down klex-machine MCP server');
        void close().then(
          () => {
            process.exitCode = 0;
          },
          (error: unknown) => {
            logger.error({ error, signal }, 'Failed to shut down klex-machine');
            process.exitCode = 1;
          },
        );
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  return {
    host: config.host,
    port,
    fetch: async (request) => app.fetch(request),
    close,
  };
}

import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';

import type { RuntimeConfig } from './config.js';
import { createMachineMcp, type MachineMcp } from './mcp.js';

export interface MachineServer {
  host: string;
  port: number;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

const LEVEL_PRIORITY = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

function createMachineLogger(
  minLevel: RuntimeConfig['logLevel'],
): MachineLogger {
  const write = (
    level: 'info' | 'warn' | 'error',
    data: unknown,
    message: string,
  ) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
    process.stderr.write(
      `${new Date().toISOString()} ${level.toUpperCase()} ${message} ${JSON.stringify(data)}\n`,
    );
  };
  return {
    info: (data, message) => write('info', data, message),
    warn: (data, message) => write('warn', data, message),
    error: (data, message) => write('error', data, message),
  };
}

export interface MachineLogger {
  info(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
  error(data: unknown, message: string): void;
}

export interface MachineServerOptions {
  mcp?: MachineMcp;
  logger?: MachineLogger;
  registerSignals?: boolean;
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
  const mcp = options.mcp ?? createMachineMcp(config.cwd);
  const app = createMachineApp(mcp, config.host);

  const listener = await new Promise<ReturnType<typeof serve>>(
    (resolve, reject) => {
      const server = serve(
        { fetch: app.fetch, hostname: config.host, port: config.port },
        () => resolve(server),
      );
      server.once('error', reject);
    },
  ).catch(async (error) => {
    await mcp.close();
    throw error;
  });
  listener.removeAllListeners('error');

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
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
      await mcp.close();
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

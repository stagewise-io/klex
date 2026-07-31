import { createLogger } from '@stagewise/logger';
import { createProxyServer } from '@stagewise/mcp-proxy-sdk/server';

import { createConfig } from '@/config';

const logger = createLogger({
  name: 'mcp-proxy',
  type: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  mask: {},
});

async function main(): Promise<void> {
  const config = createConfig();
  const server = createProxyServer({
    host: config.host,
    port: config.port,
    authenticateEnvironment: async ({ request }) =>
      config.authenticateEnvironment(bearer(request.headers.authorization)),
    parseEnvironmentId: (value) => config.parseEnvironmentId(value),
    hooks: {
      onExchangeOpened: (details) =>
        logger.info(details, 'Proxy exchange opened'),
      onExchangeClosed: (details) =>
        logger.info(details, 'Proxy exchange closed'),
      onError: ({ error }) => logger.error({ error }, 'Proxy error'),
    },
    onConnected: ({ environmentId }) =>
      logger.info({ environmentId }, 'Environment connected'),
  });
  const address = await server.start();
  logger.info({ host: address.host, port: address.port }, 'Proxy listening');

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await logger[Symbol.asyncDispose]();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function bearer(value: string | undefined | null): string | undefined {
  return value?.startsWith('Bearer ')
    ? value.slice('Bearer '.length)
    : undefined;
}

main().catch(async (error: unknown) => {
  logger.fatal({ error }, 'Proxy startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

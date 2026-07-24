import { createLogger } from '@stagewise/logger';
import { createGatewayServer } from '@stagewise/mcp-gateway-sdk/server';

import { createConfig } from '@/config';

const logger = createLogger({
  name: 'mcp-gateway',
  type: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  mask: {},
});

async function main(): Promise<void> {
  const config = createConfig();
  const server = createGatewayServer({
    host: config.host,
    port: config.port,
    authorization: {
      authorize: async (agent, environment) =>
        config.authorize(agent, environment),
    },
    authenticateAgent: async ({ request }) =>
      config.authenticateAgent(bearer(request.headers.get('authorization'))),
    authenticateEnvironment: async ({ request }) =>
      config.authenticateEnvironment(bearer(request.headers.authorization)),
    parseEnvironmentId: (value) => config.parseEnvironmentId(value),
    hooks: {
      onExchangeOpened: (details) =>
        logger.info(details, 'Gateway exchange opened'),
      onExchangeClosed: (details) =>
        logger.info(details, 'Gateway exchange closed'),
      onError: ({ error }) => logger.error({ error }, 'Gateway error'),
    },
    onConnected: ({ principal }) =>
      logger.info(
        { environmentId: principal.environmentId },
        'Environment connected',
      ),
  });
  const address = await server.start();
  logger.info({ host: address.host, port: address.port }, 'Gateway listening');

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
  logger.fatal({ error }, 'Gateway startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

import { createLogger } from '@stagewise/logger';
import { createGatewayServer } from '@stagewise/mcp-gateway-node';

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
        agent.tenantId === config.tenantId &&
        agent.agentId === config.agentId &&
        environment.tenantId === config.tenantId &&
        environment.environmentId === config.environmentId,
    },
    authenticateAgent: async ({ request }) =>
      bearer(request.headers.get('authorization')) === config.agentToken
        ? {
            kind: 'agent',
            tenantId: config.tenantId,
            agentId: config.agentId,
          }
        : undefined,
    authenticateEnvironment: async ({ request }) =>
      bearer(request.headers.authorization) === config.environmentToken
        ? {
            kind: 'environment',
            tenantId: config.tenantId,
            environmentId: config.environmentId,
          }
        : undefined,
    parseEnvironmentId: (value) => {
      if (value !== config.environmentId)
        throw new Error('Unknown environment');
      return config.environmentId;
    },
    hooks: {
      onSessionOpened: (details) =>
        logger.info(details, 'Gateway session opened'),
      onSessionClosed: (details) =>
        logger.info(details, 'Gateway session closed'),
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

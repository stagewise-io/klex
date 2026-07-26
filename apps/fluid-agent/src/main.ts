import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { createConfig } from '@/config';
import { createInMemoryFluidEventInbox } from '@/fluid-event-inbox';
import { createMcp } from '@/mcp';
import { createModelProvider } from '@/model-provider';
import { createChatSession } from '@/session/chat';
import type { SessionHooks } from '@/session/types';
import { createTracing } from '@/tracing';

import { createRouter } from './router';
import { SessionInboxPriority } from './session/inbox';

const logger = createLogger({
  name: 'fluid-agent',
  otel: {
    url: 'http://localhost:4318/v1/logs',
    resourceAttributes: {
      'deployment.environment': 'development',
      'service.name': 'fluid-agent',
      'service.namespace': 'stagewise',
    },
  },
});

async function main(): Promise<void> {
  logger.info('Fluid Agent v1.0.0');

  const tracing = createTracing({
    logging: logger,
    otlpUrl: 'http://localhost:4318/v1/traces',
    serviceName: 'fluid-agent',
    resourceAttributes: {
      'deployment.environment': 'development',
      'service.namespace': 'stagewise',
    },
  });
  await tracing.start();

  const config = createConfig({
    logging: logger,
    dataDirectory: process.env.FLUID_DATA_DIR ?? process.cwd(),
  });
  const adminApi = createAdminApi({ logging: logger, config });
  const modelProvider = createModelProvider({ logging: logger, config });
  const fluidEventInbox = createInMemoryFluidEventInbox();
  const mcp = createMcp({ logging: logger, config, fluidEventInbox });

  const router = createRouter({
    logging: logger,
    createChatSession: (hooks: SessionHooks) =>
      createChatSession({
        logging: logger,
        config: config,
        modelProvider: modelProvider,
        toolProvider: mcp,
        extensionFactories: [],
        hooks,
      }),
  });
  await router.start();

  const started: { close(): Promise<void> }[] = [];
  try {
    for (const resource of [config, adminApi, modelProvider, mcp]) {
      await resource.start();
      started.push(resource);
    }
  } catch (error) {
    await closeReverse(started);
    throw error;
  }
  await router.start();

  // Send a test message into the primary session via the router
  router.sendInput({
    sourceEnv: 'chatApp',
    priority: SessionInboxPriority.Medium,
    context: {
      sourceEnv: 'chatApp',
      metadata: {
        chatId: '95g8743',
        senderId: 'u4987tzrh4',
        timestamp: new Date().toISOString(),
      },
      content: [{ type: 'text', text: 'Hey there! Who are you?' }], // TODO Add a real message here
    },
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await router.close();
    await closeReverse(started);
    await tracing.close();
    await logger[Symbol.asyncDispose]();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function closeReverse(
  resources: readonly { close(): Promise<void> }[],
): Promise<void> {
  for (const resource of [...resources].reverse()) {
    await resource.close().catch((error: unknown) => {
      logger.error({ error }, 'Resource shutdown failed');
    });
  }
}

main().catch(async (error: unknown) => {
  logger.fatal({ error }, 'Fluid Agent startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

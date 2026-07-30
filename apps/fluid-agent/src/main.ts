import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { type CliOptions, parseCliArgs } from '@/cli';
import { createConfig } from '@/config';
import { createInMemoryFluidEventInbox } from '@/fluid-event-inbox';
import { createMcp } from '@/mcp';
import { createModelProvider } from '@/model-provider';
import { createRouter } from '@/router';
import { createChatSession } from '@/session/chat';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import { createCoreDataPartsExt } from '@/session/chat/extensions/core-data-parts';
import type { SessionHooks } from '@/session/types';
import { createTracing } from '@/tracing';

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

  const cli: CliOptions = parseCliArgs(process.argv.slice(2));

  const config = createConfig({
    logging: logger,
    dataDirectory: cli.dataDirectory,
  });
  const modelProvider = createModelProvider({ logging: logger, config });
  const fluidEventInbox = createInMemoryFluidEventInbox();
  const mcp = createMcp({ logging: logger, config, fluidEventInbox });

  const router = createRouter({
    logging: logger,
    mcp,
    createChatSession: (hooks: SessionHooks) =>
      createChatSession({
        logging: logger,
        config: config,
        modelProvider: modelProvider,
        toolProvider: mcp,
        extensionFactories: [
          createCoreDataPartsExt,
          createContextCompactionExt,
        ],
        dataDirectory: cli.dataDirectory,
        hooks,
      }),
  });
  const adminApi = createAdminApi({ logging: logger, config, mcp, router });
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

import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { createConfig } from '@/config';
import { createMcp } from '@/mcp';
import { createModelProvider } from '@/model-provider';
import { createChatSession } from '@/session/chat';

const logger = createLogger({ name: 'fluid-agent' });

async function main(): Promise<void> {
  logger.info('Fluid Agent v1.0.0');

  const config = createConfig({
    logging: logger,
    dataDirectory: process.env.FLUID_DATA_DIR ?? process.cwd(),
  });
  const adminApi = createAdminApi({ logging: logger, config });
  const modelProvider = createModelProvider({ logging: logger, config });
  const mcp = createMcp({ logging: logger, config });
  const session = createChatSession({
    logging: logger,
    config,
    modelProvider,
    toolProvider: mcp,
  });

  const started: { close(): Promise<void> }[] = [];
  try {
    for (const resource of [config, adminApi, modelProvider, mcp, session]) {
      await resource.start();
      started.push(resource);
    }
  } catch (error) {
    await closeReverse(started);
    throw error;
  }

  session.sendMessage('Hello there!');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeReverse(started);
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

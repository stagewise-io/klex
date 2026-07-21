import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { createConfig } from '@/config';
import { createModelProvider } from '@/model-provider';
import { createChatSession } from '@/session/chat';

const logger = createLogger({ name: 'fluid-agent' });

async function main(): Promise<void> {
  logger.info('Fluid Agent v1.0.0');

  const config = createConfig({
    logging: logger,
    dataDirectory: process.env.FLUID_DATA_DIR ?? process.cwd(),
  });
  await config.start();

  const adminApi = createAdminApi({ logging: logger, config });
  await adminApi.start();

  const modelProvider = createModelProvider({ logging: logger, config });

  // For the first test, we create a simple session and enter some content into it
  const session = createChatSession({
    logging: logger,
    config: config,
    modelProvider: modelProvider,
  });

  session.sendMessage('Hello there!');

  // Idle until signal — graceful shutdown
  const shutdown = async () => {
    await adminApi.close();
    await config.close();
    await logger[Symbol.asyncDispose]();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error: unknown) => {
  logger.fatal({ error }, 'Fluid Agent startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

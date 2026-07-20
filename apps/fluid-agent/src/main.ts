import { createLogger } from '@stagewise/logger';
import { createAdminApi } from './admin/admin-api';
import { createConfig } from './config/config';

const logger = createLogger({ name: 'fluid-agent' });

async function main(): Promise<void> {
  logger.info('Fluid Agent v1.0.0');

  const config = createConfig({
    logging: logger,
    dataDirectory: process.cwd(),
  });
  await config.start();

  const adminApi = createAdminApi({ logging: logger, config });
  await adminApi.start();

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

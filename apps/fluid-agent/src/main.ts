import { createAdminApi } from './admin/admin-api';
import { createLogger } from './logger/logger';

const logger = createLogger({ name: 'fluid-agent' });

async function main(): Promise<void> {
  logger.info('Fluid Agent v1.0.0');

  const adminApi = createAdminApi({ logging: logger });
  await adminApi.start();

  // Idle until signal — graceful shutdown
  const shutdown = async () => {
    await adminApi.close();
    await logger[Symbol.asyncDispose]();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

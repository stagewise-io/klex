import type { Logger } from './admin/admin-api';
import { createAdminApi } from './admin/admin-api';

// TODO: Replace with proper services (config file loader, structured logger, etc.)
const logger: Logger = {
  info: (msg, ...args) => console.log(`[info] ${msg}`, ...args),
};

async function main(): Promise<void> {
  console.log('Fluid Agent v1.0.0\n');

  const adminApi = createAdminApi({ logger });
  await adminApi.start();

  // Idle until signal — graceful shutdown
  const shutdown = async () => {
    await adminApi.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

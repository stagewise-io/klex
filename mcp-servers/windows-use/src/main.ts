import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';

import { createLogger } from '@stagewise/logger';

import { createConfig } from '@/config';
import { createWindowsUse } from '@/windows-use';

const configPath =
  process.env.WINDOWS_USE_CONFIG ??
  (isSea()
    ? join(dirname(process.execPath), 'windows-use.config.json')
    : undefined);
const config = createConfig(process.env, configPath);
const logger = createLogger({
  name: 'windows-use',
  minLevel: config.logLevel,
  type: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  mask: {},
});
const application = createWindowsUse({
  config,
  logging: logger,
  onFatal: (error) => void shutdown(error),
});

let shuttingDown = false;
async function shutdown(error?: Error): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (error) {
    process.exitCode = 1;
    logger.fatal({ error }, 'Windows-use application failed');
  }
  await application.close().catch((closeError: unknown) => {
    process.exitCode = 1;
    logger.error({ error: closeError }, 'Windows-use shutdown failed');
  });
  await logger[Symbol.asyncDispose]();
  process.exit();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

application
  .start()
  .then(() => logger.info('Windows-use environment connected'))
  .catch((error: unknown) =>
    shutdown(error instanceof Error ? error : new Error(String(error))),
  );

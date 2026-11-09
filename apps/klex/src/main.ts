import './ai-sdk-warnings';

import { attachOtelTransport, createLogger } from '@stagewise/logger';

import { parseCliArgs } from '@/cli';
import { createLogStore } from '@/log-store';
import { createUpdateBootstrap } from '@/update-bootstrap';

const cli = parseCliArgs(process.argv.slice(2));
const logStore = createLogStore(500);
const logger = createLogger({
  name: 'klex',
  verbose: cli.verbose,
  minLevel: cli.telemetryLevel === 'debug' ? 'TRACE' : undefined,
  capture: cli.headless ? undefined : (entry) => logStore.add(entry),
  console: cli.headless,
  mask: { caseInsensitive: true },
});

async function main(): Promise<void> {
  if (cli.verifyNative) {
    const { runNativeVerification } = await import('@/release/verify-native');
    process.exit(await runNativeVerification());
  }
  const bootstrap = createUpdateBootstrap({
    logging: logger,
    cli,
    disposeLogging: () => logger[Symbol.asyncDispose](),
    onStartupFailure: () => {
      logger.settings.type = 'pretty';
    },
    loadApplication: async (updateManager, healthServer) => {
      // Keep application schemas, native modules and service imports out of the
      // update path, including in the single-file SEA bundle.
      const { createApplication } = await import('@/application');
      return createApplication({
        cli,
        logging: logger,
        logStore,
        updateManager,
        healthServer,
        attachTelemetryLogging: (options) =>
          attachOtelTransport(logger, options, cli.verbose),
        closeInfrastructure: () => bootstrap.close(),
        disposeLogging: () => logger[Symbol.asyncDispose](),
      });
    },
  });
  await bootstrap.start();
}

main().catch(async (error: unknown) => {
  logger.settings.type = 'pretty';
  logger.fatal({ error }, 'Klex Bot startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

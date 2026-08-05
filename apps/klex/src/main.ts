import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { type CliOptions, parseCliArgs } from '@/cli';
import { createConfig } from '@/config';
import { createIntrospector } from '@/introspection';
import { createMcp } from '@/mcp';
import { createModelProvider } from '@/model-provider';
import { createRouter } from '@/router';
import { createChatSession } from '@/session/chat';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import { createImageInputOptimizerExt } from '@/session/chat/extensions/image-input-optimizer';
import { createJsReplSandboxExt } from '@/session/chat/extensions/js-repl-sandbox';
import type { SessionHooks } from '@/session/types';
import {
  createTelemetryManager,
  createTelemetrySpanProcessor,
} from '@/telemetry-manager';
import { createTracing } from '@/tracing';

const logger = createLogger({
  name: 'klex',
  otel: {
    url: 'http://localhost:4318/v1/logs',
    resourceAttributes: {
      'deployment.environment': 'development',
      'service.name': 'klex',
      'service.namespace': 'stagewise',
    },
  },
});

const spanProcessor = createTelemetrySpanProcessor();

async function main(): Promise<void> {
  logger.info('Klex Agent v1.0.0');

  const tracing = createTracing({
    logging: logger,
    otlpUrl: 'http://localhost:4318/v1/traces',
    serviceName: 'klex',
    resourceAttributes: {
      'deployment.environment': 'development',
      'service.namespace': 'stagewise',
    },
    spanProcessor,
  });
  await tracing.start();

  const cli: CliOptions = parseCliArgs(process.argv.slice(2));

  const config = createConfig({
    logging: logger,
    dataDirectory: cli.dataDirectory,
  });
  const modelProvider = createModelProvider({ logging: logger, config });
  const mcp = createMcp({ logging: logger, config });
  const introspector = createIntrospector({ logging: logger });

  const router = createRouter({
    logging: logger,
    mcp,
    introspection: introspector,
    createChatSession: (hooks: SessionHooks, introspectionScope) =>
      createChatSession({
        logging: logger,
        config: config,
        modelProvider: modelProvider,
        mcp,
        extensionFactories: [
          createJsReplSandboxExt,
          createContextCompactionExt,
          createImageInputOptimizerExt,
        ],
        dataDirectory: cli.dataDirectory,
        hooks,
        introspectionScope,
      }),
  });
  const adminApi = createAdminApi({
    logging: logger,
    config,
    mcp,
    introspector,
  });
  const telemetryManager = createTelemetryManager({
    logging: logger,
    config,
    spanProcessor,
  });
  const started: { close(): Promise<void> }[] = [];
  try {
    for (const resource of [config, adminApi, modelProvider, mcp]) {
      await resource.start();
      started.push(resource);
    }
    await telemetryManager.start();
    started.push(telemetryManager);
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
  logger.fatal({ error }, 'Klex Agent startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

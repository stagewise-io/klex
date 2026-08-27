import { createLogger } from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { type CliOptions, parseCliArgs } from '@/cli';
import { createCloudConnectivity } from '@/cloud-connectivity';
import { createConfig } from '@/config';
import { createDirectoryLock } from '@/directory-lock';
import { createIntrospector } from '@/introspection';
import { createMcp } from '@/mcp';
import { createModelCallLogger } from '@/model-call-logger';
import { createModelProvider } from '@/model-provider';
import { createRouter, type RouterApi } from '@/router';
import { createChatSession } from '@/session/chat';
import { createAudioInputOptimizerExt } from '@/session/chat/extensions/audio-input-optimizer';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import { createImageInputOptimizerExt } from '@/session/chat/extensions/image-input-optimizer';
import { createJsReplSandboxExt } from '@/session/chat/extensions/js-repl-sandbox';
import { createRemindersExt } from '@/session/chat/extensions/reminders';
import { createSoulExt } from '@/session/chat/extensions/soul';
import {
  createProductionMediaTransportConnector,
  createRealtime,
  PRODUCTION_REALTIME_MEDIA_CAPABILITY,
} from '@/session/realtime';
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

  // Acquire directory lock before any module starts — prevents concurrent
  // instances from using the same working directory.
  const dirLock = createDirectoryLock({
    logging: logger,
    dataDirectory: cli.dataDirectory,
  });
  await dirLock.acquire();

  const config = createConfig({
    logging: logger,
    dataDirectory: cli.dataDirectory,
  });
  const started: { close(): Promise<void> }[] = [];
  let router: ReturnType<typeof createRouter> | undefined;

  try {
    await config.start();
    started.push(config);

    // Cloud connectivity: identity is always created; enrollment + token
    // client are initialized only when cloud is enabled.
    const cloudConnectivity = createCloudConnectivity({
      logging: logger,
      dataDirectory: cli.dataDirectory,
      cloudEnabled: cli.cloudEnabled,
      cloudBaseUrl: cli.cloudBaseUrl,
      enrollmentToken: cli.cloudEnrollToken,
    });
    await cloudConnectivity.start();
    started.push(cloudConnectivity);
    const realtimeProvider = config.resolveRealtimeProvider();
    const realtimeComposition = realtimeProvider
      ? {
          provider: realtimeProvider,
          ownedConnector: createProductionMediaTransportConnector(),
        }
      : undefined;
    const realtimeMediaCapability = realtimeComposition
      ? PRODUCTION_REALTIME_MEDIA_CAPABILITY
      : undefined;
    const modelProvider = createModelProvider({ logging: logger, config });
    const mcp = createMcp({
      logging: logger,
      config,
      realtimeMediaCapability,
    });
    const introspector = createIntrospector({ logging: logger });

    const modelCallLogger = createModelCallLogger({
      logging: logger,
      dataDirectory: cli.dataDirectory,
    });

    tracing.setModelCallSink((record) => modelCallLogger.recordCall(record));

    router = createRouter({
      logging: logger,
      mcp,
      introspection: introspector,
      createChatSession: (
        hooks: SessionHooks,
        introspectionScope,
        router: RouterApi,
      ) =>
        createChatSession({
          logging: logger,
          config,
          modelProvider,
          mcp,
          router,
          extensionFactories: [
            createSoulExt,
            createJsReplSandboxExt,
            createContextCompactionExt,
            createImageInputOptimizerExt,
            createAudioInputOptimizerExt,
            createRemindersExt,
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
      modelCallLogger,
    });
    const telemetryManager = createTelemetryManager({
      logging: logger,
      config,
      spanProcessor,
    });
    const realtime = realtimeComposition
      ? createRealtime({
          logging: logger,
          mcp,
          provider: realtimeComposition.provider,
          ownedConnector: realtimeComposition.ownedConnector,
        })
      : undefined;
    for (const resource of [modelCallLogger, modelProvider, adminApi]) {
      await resource.start();
      started.push(resource);
    }
    await realtime?.start();
    try {
      await mcp.start();
    } catch (error) {
      await realtime?.close();
      throw error;
    }
    started.push(mcp);
    if (realtime) started.push(realtime);
    await telemetryManager.start();
    started.push(telemetryManager);
    await router.start();
  } catch (error) {
    await router?.close().catch((error: unknown) => {
      logger.error({ error }, 'Router shutdown failed');
    });
    await closeReverse(started);
    await dirLock.release();
    throw error;
  }

  const runningRouter = router;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runningRouter.close().catch((error: unknown) => {
      logger.error({ error }, 'Router shutdown failed');
    });
    await closeReverse(started);
    await dirLock.release().catch((error: unknown) => {
      logger.error({ error }, 'Lock release failed');
    });
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

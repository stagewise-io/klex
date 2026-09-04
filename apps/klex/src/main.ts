import { createLogger } from '@stagewise/logger';

import { type AdminApi, createAdminApi } from '@/admin-api';
import { type CliOptions, parseCliArgs } from '@/cli';
import { createCliUi } from '@/cli-ui';
import { createCloudConnectivity } from '@/cloud-connectivity';
import { createConfig } from '@/config';
import { createDirectoryLock } from '@/directory-lock';
import { createIntrospector } from '@/introspection';
import { createMcp } from '@/mcp';
import { createModelCallLogger } from '@/model-call-logger';
import { createModelProvider } from '@/model-provider';
import { KLEX_VERSION } from '@/release';
import { runNativeVerification } from '@/release/verify-native';
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

const cli: CliOptions = parseCliArgs(process.argv.slice(2));

const logger = createLogger({
  name: 'klex',
  verbose: cli.verbose,
  // In interactive (non-headless) mode, suppress all console output so the
  // Ink TUI has exclusive access to stdout/stderr. OTel transport still sends
  // logs to the collector. Fatal errors re-enable console output in the
  // catch handler below.
  console: cli.headless,
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
  logger.info(`Klex Bot v${KLEX_VERSION}`);

  // Diagnostic path: load every native dependency and exit without starting any
  // subsystem. Used by the packaged executable smoke test to prove native addons
  // actually load, which existence checks cannot.
  if (cli.verifyNative) {
    process.exit(await runNativeVerification());
  }

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
  let adminApiForUi: AdminApi | undefined;
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
      allowDangerousUnsecureCloud: cli.allowDangerousUnsecureCloud,
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
      dataDirectory: cli.dataDirectory,
      cloudConnectivity,
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
      cloudConnectivity,
      cloudEnabled: cli.cloudEnabled,
      port: cli.adminPort,
    });
    adminApiForUi = adminApi;
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
  let cliUi: { start(): void; close(): void } | undefined;

  // Graceful shutdown with a hard timeout. Called from UI q/Ctrl+C and
  // from OS signals. Attempts orderly cleanup for 3 seconds; if it hasn't
  // completed by then, hard-exit so the process never hangs.
  const quitImmediately = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cliUi?.close();
    } catch {
      // Best-effort teardown — must not block process exit.
    }

    const cleanup = Promise.allSettled([
      runningRouter.close().catch((error: unknown) => {
        logger.error({ error }, 'Router shutdown failed');
      }),
      closeReverse(started),
      dirLock.release().catch((error: unknown) => {
        logger.error({ error }, 'Lock release failed');
      }),
      tracing.close(),
      logger[Symbol.asyncDispose](),
    ]);

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));

    Promise.race([cleanup, timeout]).finally(() => process.exit(0));
  };

  process.on('SIGINT', quitImmediately);
  process.on('SIGTERM', quitImmediately);

  // Interactive CLI UI — default mode. Headless mode skips the UI.
  if (!cli.headless) {
    // The ESM SEA entry bundles the interactive UI together with the
    // application. This keeps the executable self-contained; only native
    // addons and runtime binaries remain external filesystem assets.
    const ui = createCliUi({
      logging: logger,
      onQuit: quitImmediately,
      adminApi: adminApiForUi!,
    });
    cliUi = ui;
    ui.start();
  }
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
  // In interactive mode the logger is hidden. Re-enable console output so
  // startup errors are visible instead of silently swallowed.
  logger.settings.type = 'pretty';
  logger.fatal({ error }, 'Klex Bot startup failed');
  await logger[Symbol.asyncDispose]();
  process.exitCode = 1;
});

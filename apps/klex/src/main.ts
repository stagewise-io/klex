import { randomUUID } from 'node:crypto';

import {
  attachOtelTransport,
  createLogger,
  type LogLevel,
} from '@stagewise/logger';

import { type AdminApi, createAdminApi } from '@/admin-api';
import { createAgentDirectory, defaultAgentRoot } from '@/agent-directory';
import { createAgentPicker } from '@/agent-picker';
import { type CliOptions, parseCliArgs } from '@/cli';
import { createCliUi } from '@/cli-ui';
import {
  type CloudConnectivity,
  createCloudConnectivity,
} from '@/cloud-connectivity';
import { type RuntimeHandle, startRuntime } from '@/composition/runtime';
import {
  createConfig,
  getDefaultTelemetryLevel,
  type RuntimeTelemetryLevel,
} from '@/config';
import { ensureDataDirectory } from '@/data-directory';
import { createDirectoryLock, type DirectoryLock } from '@/directory-lock';
import { createGodMessages } from '@/god-messages';
import { createIntrospector } from '@/introspection';
import { createLocalData, type LocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';
import { createLogStore } from '@/log-store';
import { createMcp } from '@/mcp';
import { createModelCallLogger } from '@/model-call-logger';
import {
  builtInProviderDefinitions,
  createProviderRegistry,
} from '@/provider-registry';
import { KLEX_VERSION, resolveReleaseTarget } from '@/release';
import { runNativeVerification } from '@/release/verify-native';
import { discoverManagedInstallation, UpdateManager } from '@/self-update';
import { createChatSession } from '@/session/chat';
import { createAudioInputOptimizerExt } from '@/session/chat/extensions/audio-input-optimizer';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import type { ExtensionFactory } from '@/session/chat/extensions/extension-api';
import {
  createGodMessagesDistrustExt,
  createGodMessagesTrustExt,
} from '@/session/chat/extensions/god-messages';
import { createImageInputOptimizerExt } from '@/session/chat/extensions/image-input-optimizer';
import { createJsReplSandboxExt } from '@/session/chat/extensions/js-repl-sandbox';
import { createMcpIngressExt } from '@/session/chat/extensions/mcp-ingress';
import { createMemoryExt } from '@/session/chat/extensions/memory';
import { createNameLoaderExt } from '@/session/chat/extensions/name-loader';
import {
  createSoulExt,
  createSoulExtGod,
} from '@/session/chat/extensions/soul';
import {
  createTimeExt,
  createTimeExtGod,
} from '@/session/chat/extensions/time';
import { createTodosExt } from '@/session/chat/extensions/todos';
import systemPrompt from '@/session/chat/utils/system-prompt.md';
import {
  createProductionMediaTransportConnector,
  createRealtime,
  PRODUCTION_REALTIME_MEDIA_CAPABILITY,
} from '@/session/realtime';
import { createSessionHost } from '@/session/session-host';
import type { SessionFactory } from '@/session/types';
import { createShutdownCoordinator } from '@/shutdown-coordinator';
import { createTelemetryExportConfiguration } from '@/telemetry-config';
import {
  createTelemetryManager,
  createTelemetrySpanProcessor,
} from '@/telemetry-manager';
import { createTelemetryMetrics } from '@/telemetry-metrics';
import { createTracing, mapProviderName } from '@/tracing';

/** Minimum seconds between time updates before executable generations. */
const TIME_UPDATE_PERIOD_SECONDS = 300;

const cli: CliOptions = parseCliArgs(process.argv.slice(2));
const logStore = createLogStore(500);

const logger = createLogger({
  name: 'klex',
  verbose: cli.verbose,
  capture: cli.headless ? undefined : (entry) => logStore.add(entry),
  // In interactive (non-headless) mode, suppress all console output so the
  // Ink TUI has exclusive access to stdout/stderr. The OTLP transport is
  // attached only after persisted telemetry configuration is loaded.
  console: cli.headless,
  mask: { caseInsensitive: true },
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

  let interactiveCloud: CloudConnectivity | undefined;
  let interactiveLocalData: LocalData | undefined;
  let interactiveLock: DirectoryLock | undefined;
  const agentDirectory = createAgentDirectory({
    logging: logger,
    rootDirectory: cli.agentRoot || defaultAgentRoot(),
  });
  if (cli.dataDirectory === undefined) {
    if (cli.headless) {
      throw new Error(
        'Headless mode requires --data-dir or KLEX_DATA_DIR to identify an agent directory',
      );
    }
    const selectedDirectory = await createAgentPicker({
      agentDirectory,
      prepareAgent: async (directory) => {
        await interactiveCloud?.close().catch(() => undefined);
        interactiveCloud = undefined;
        await interactiveLocalData?.close().catch(() => undefined);
        interactiveLocalData = undefined;
        await interactiveLock?.release().catch(() => undefined);
        interactiveLock = undefined;

        await ensureDataDirectory(directory);
        const lock = createDirectoryLock({
          logging: logger,
          dataDirectory: directory,
        });
        await lock.acquire();
        interactiveLock = lock;

        let cloud: CloudConnectivity | undefined;
        try {
          const localData = createLocalData({
            logging: logger,
            dataDirectory: directory,
            klexVersion: KLEX_VERSION,
            stores: KLEX_LOCAL_DATA_STORES,
          });
          interactiveLocalData = localData;
          await localData.start();
          if (!cli.cloudEnabled) return false;

          cloud = createCloudConnectivity({
            logging: logger,
            dataDirectory: directory,
            cloudEnabled: true,
            cloudBaseUrl: cli.cloudBaseUrl,
            // A supplied token completes enrollment without another prompt;
            // otherwise the wizard collects one below.
            enrollmentToken: cli.cloudEnrollToken,
            allowDangerousUnsecureCloud: cli.allowDangerousUnsecureCloud,
          });
          interactiveCloud = cloud;
          await cloud.start();
          return !cloud.isEnrolled();
        } catch (error) {
          await cloud?.close().catch(() => undefined);
          interactiveCloud = undefined;
          await interactiveLocalData?.close().catch(() => undefined);
          interactiveLocalData = undefined;
          await lock.release().catch(() => undefined);
          interactiveLock = undefined;
          throw error;
        }
      },
      enrollCloud: async (_directory, token) => {
        await interactiveCloud?.enroll(token);
      },
    }).choose();
    if (selectedDirectory === undefined) {
      await interactiveCloud?.close().catch(() => undefined);
      await interactiveLocalData?.close().catch(() => undefined);
      await interactiveLock?.release().catch(() => undefined);
      return;
    }
    cli.dataDirectory = selectedDirectory;
  }

  // The data directory is the first thing every subsystem writes into, and on a
  // fresh machine it does not exist yet. Create it before the lock, whose
  // exclusive open would otherwise fail with ENOENT.
  const dataDirectory = cli.dataDirectory;
  await ensureDataDirectory(dataDirectory);

  // Acquire directory lock before any module starts — prevents concurrent
  // instances from using the same working directory.
  const dirLock =
    interactiveLock ??
    createDirectoryLock({
      logging: logger,
      dataDirectory: cli.dataDirectory,
    });
  if (!interactiveLock) await dirLock.acquire();

  const localData =
    interactiveLocalData ??
    createLocalData({
      logging: logger,
      dataDirectory,
      klexVersion: KLEX_VERSION,
      stores: KLEX_LOCAL_DATA_STORES,
    });
  if (!interactiveLocalData) {
    try {
      await localData.start();
    } catch (error) {
      await dirLock.release().catch(() => undefined);
      throw error;
    }
  }

  const config = createConfig({
    logging: logger,
    dataDirectory: cli.dataDirectory,
  });
  // Resources started before the runtime modules. The runtime adopts them for
  // shutdown; this list only drives rollback while the pre-runtime phase runs.
  const preRuntime: { close(): Promise<void> }[] = [localData];
  let adminApiForUi: AdminApi | undefined;
  let runtime: RuntimeHandle | undefined;
  let tracing: ReturnType<typeof createTracing> | undefined;

  try {
    await config.start();
    preRuntime.push(config);
    const configuredTelemetry = config.get().telemetry;
    const telemetryLevel: RuntimeTelemetryLevel = cli.telemetryDisabled
      ? 'no'
      : cli.telemetryDebug
        ? 'debug'
        : (configuredTelemetry?.level ?? getDefaultTelemetryLevel());
    spanProcessor.setLevel(telemetryLevel);
    spanProcessor.setContentAllowed(() => {
      if (cli.telemetryDisabled) return false;
      return cli.telemetryDebug;
    });
    if (cli.resetTelemetryIdentity || !configuredTelemetry?.instanceId) {
      await config.mutate((current) => ({
        ...current,
        telemetry: {
          ...current.telemetry,
          level: current.telemetry?.level ?? getDefaultTelemetryLevel(),
          instanceId: randomUUID(),
        },
      }));
    }
    const telemetryExport = createTelemetryExportConfiguration(
      cli.telemetryEndpoint,
    );
    const telemetryInstanceId = config.get().telemetry?.instanceId ?? 'unknown';
    let telemetryLogsAttached = false;
    const getTelemetryLogMinLevel = (
      level: RuntimeTelemetryLevel,
    ): LogLevel | number | undefined => {
      switch (level) {
        case 'no':
          return 999;
        case 'basic':
          return 'WARN';
        case 'advanced':
          return 'INFO';
        case 'debug':
          return undefined;
      }
    };
    const attachTelemetryLogs = (level: RuntimeTelemetryLevel): void => {
      if (telemetryLogsAttached) return;
      telemetryLogsAttached = true;
      attachOtelTransport(
        logger,
        {
          url: telemetryExport.logsUrl,
          headers: { ...telemetryExport.headers },
          minLevel: getTelemetryLogMinLevel(level),
          resourceAttributes: {
            'service.name': 'klex',
            'service.namespace': 'stagewise',
            'service.instance.id': telemetryInstanceId,
          },
        },
        cli.verbose,
      );
    };
    if (telemetryLevel !== 'no') attachTelemetryLogs(telemetryLevel);
    tracing = createTracing({
      logging: logger,
      otlpUrl: telemetryExport.tracesUrl,
      otlpHeaders: { ...telemetryExport.headers },
      serviceName: 'klex',
      resourceAttributes: {
        'service.namespace': 'stagewise',
        'service.instance.id': telemetryInstanceId,
      },
      spanProcessor,
      enabled: telemetryLevel !== 'no',
      recordContent: true,
      contentAllowed: () => {
        if (telemetryLevel !== 'debug') return false;
        return cli.telemetryDebug;
      },
    });
    await tracing.start();
    const telemetryMetrics = createTelemetryMetrics({
      logging: logger.child({ name: 'telemetry-metrics' }),
      endpoint: telemetryExport.metricsUrl,
      headers: { ...telemetryExport.headers },
      dataDirectory,
      enabled: telemetryLevel !== 'no',
      instanceId: telemetryInstanceId,
      serviceVersion: KLEX_VERSION,
    });
    await telemetryMetrics.start();
    await telemetryMetrics.setLevel(telemetryLevel);
    preRuntime.push(telemetryMetrics);
    const timezone = config.get().timezone;
    const providerRegistry = createProviderRegistry({
      logging: logger,
      config,
      definitions: builtInProviderDefinitions,
    });
    await providerRegistry.start();
    preRuntime.push(providerRegistry);

    // Cloud connectivity: identity is always created; enrollment + token
    // client are initialized only when cloud is enabled.
    const cloudConnectivity =
      interactiveCloud ??
      createCloudConnectivity({
        logging: logger,
        dataDirectory: cli.dataDirectory,
        cloudEnabled: cli.cloudEnabled,
        cloudBaseUrl: cli.cloudBaseUrl,
        enrollmentToken: cli.cloudEnrollToken,
        allowDangerousUnsecureCloud: cli.allowDangerousUnsecureCloud,
      });
    const realtimeComposition = {
      resolveProvider: () => providerRegistry.resolveRealtimeProvider(),
      ownedConnector: createProductionMediaTransportConnector(),
    };
    const realtimeMediaCapability = PRODUCTION_REALTIME_MEDIA_CAPABILITY;
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

    tracing.setModelCallSink((record) => {
      modelCallLogger.recordCall(record);
      telemetryMetrics.recordModelCall({
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        inputCacheReadTokens: record.inputCacheReadTokens,
        inputCacheWriteTokens: record.inputCacheWriteTokens,
        operationName: 'generate_content',
        providerName: mapProviderName(record.providerType),
        source: record.source,
        finishReason: record.finishReason,
        isError: record.isError,
        errorType: record.errorType,
        totalDurationMs: record.totalDurationMs,
        ttftMs: record.ttftMs,
      });
    });

    /** Shared deps captured by every session created through the factory. */
    const sharedSessionDeps = {
      logging: logger,
      config,
      modelResolver: providerRegistry,
      dataDirectory,
    };

    /**
     * Creates a SessionFactory that prepends `baseExtensions` to every
     * session it creates, then appends the per-session extensions supplied
     * by the caller (the session host or god-messages module).
     *
     * Every session gets a child-capable factory with no implicit base
     * extensions. The spawning extension chooses the child's complete
     * extension list; ChatSession enforces MCP isolation.
     */
    const makeSessionFactory =
      (baseExtensions: ExtensionFactory[]): SessionFactory =>
      (params) =>
        createChatSession({
          ...sharedSessionDeps,
          mcp: params.mcp,
          sessionContext: params.sessionContext,
          extensionFactories: [...baseExtensions, ...params.extensionFactories],
          introspectionScope: params.introspectionScope,
          hooks: params.hooks,
          sessionFactory: makeSessionFactory([]),
          modelPurpose: params.modelPurpose,
          basePrompt: params.basePrompt,
        });

    // Default session: full extension set + MCP access.
    const defaultSessionFactory = makeSessionFactory([
      createNameLoaderExt,
      createSoulExt,
      createGodMessagesDistrustExt,
      createJsReplSandboxExt,
      createContextCompactionExt,
      createTimeExt({
        timeUpdatePeriod: TIME_UPDATE_PERIOD_SECONDS,
        timezone,
      }),
      createImageInputOptimizerExt,
      createAudioInputOptimizerExt,
      createTodosExt,
      createMcpIngressExt(),
      createMemoryExt({ timezone }),
    ]);

    const sessionHost = createSessionHost({
      logging: logger,
      mcp,
      introspection: introspector,
      sessionFactory: defaultSessionFactory,
      basePrompt: systemPrompt,
    });

    // God session: no MCP, trust-mode god-messages, soul-god variant.
    // js-repl-sandbox excluded — it requires MCP access.
    const godMessages = createGodMessages({
      logging: logger,
      introspection: introspector,
      sessionFactory: makeSessionFactory([
        createNameLoaderExt,
        createSoulExtGod,
        createGodMessagesTrustExt,
      ]),
      basePrompt: systemPrompt,
      extensionFactories: [
        createContextCompactionExt,
        createTimeExtGod({
          timeUpdatePeriod: TIME_UPDATE_PERIOD_SECONDS,
          timezone,
        }),
        createImageInputOptimizerExt,
        createAudioInputOptimizerExt,
        createTodosExt,
      ],
    });
    const adminApi = createAdminApi({
      logging: logger,
      config,
      mcp,
      introspector,
      modelCallLogger,
      providerRegistry,
      cloudConnectivity,
      godMessages,
      localPort: cli.dangerousLocalAdminApiPort,
      timezone,
    });
    adminApiForUi = adminApi;
    const telemetryManager = createTelemetryManager({
      logging: logger,
      config,
      spanProcessor,
      effectiveLevel:
        cli.telemetryDisabled || cli.telemetryDebug
          ? telemetryLevel
          : undefined,
      onLevelChange: async (level) => {
        await telemetryMetrics.setLevel(level);
        if (level === 'no') {
          await tracing?.setEnabled(false);
          return;
        }
        attachTelemetryLogs(level);
        await tracing?.setEnabled(true);
      },
    });
    const realtime = createRealtime({
      logging: logger,
      mcp,
      resolveProvider: realtimeComposition.resolveProvider,
      ownedConnector: realtimeComposition.ownedConnector,
      conversationHost: sessionHost,
    });
    cloudConnectivity.setTunnelRequestHandler(adminApi.handle.bind(adminApi));
    runtime = await startRuntime({
      logging: logger,
      adopted: preRuntime,
      modules: {
        modelCallLogger,
        adminApi,
        cloudConnectivity,
        sessionHost,
        realtime,
        mcp,
        telemetryManager,
        godMessages,
      },
    });
  } catch (error) {
    // `startRuntime` already unwound whatever it started; this rolls back the
    // pre-runtime phase only. `close()` is idempotent on every module here.
    await closeReverse(preRuntime);
    await interactiveCloud?.close().catch((closeError: unknown) => {
      logger.error({ error: closeError }, 'Interactive cloud shutdown failed');
    });
    await dirLock.release();
    await tracing?.close().catch((closeError: unknown) => {
      logger.error({ error: closeError }, 'Tracing shutdown failed');
    });
    throw error;
  }

  const runningRuntime = runtime;
  const runningAdminApi = adminApiForUi;
  let cliUi: { start(): void; close(): void } | undefined;
  let updateManager: UpdateManager | undefined;

  const shutdown = createShutdownCoordinator({
    closeUi: () => cliUi?.close(),
    cleanup: async () => {
      const updateState = updateManager?.getState();
      updateManager?.stop();
      if (updateState?.status !== 'restarting') {
        await updateManager?.cancelInstall();
      }
      // Ordered teardown: event ingress and realtime sessions stop before the
      // default session and its extensions close.
      await runningRuntime?.close();
      const [lockRelease] = await Promise.allSettled([
        dirLock.release(),
        tracing?.close(),
        logger[Symbol.asyncDispose](),
      ]);
      if (lockRelease.status === 'rejected') {
        throw new Error('Could not release the agent-directory lock', {
          cause: lockRelease.reason,
        });
      }
    },
    exit: (code) => process.exit(code),
    onRestartError: (error) => {
      process.stderr.write(
        `\nKlex update installed but restart failed: ${error.message}\n` +
          'Run Klex again from your terminal to start the installed version.\n',
      );
    },
  });

  process.on('SIGINT', shutdown.requestExit);
  process.on('SIGTERM', shutdown.requestExit);

  // Interactive CLI UI — default mode. Headless mode skips the UI.
  if (!cli.headless) {
    const installation = await discoverManagedInstallation({
      executablePath: process.execPath,
      platform: process.platform,
      target: resolveReleaseTarget().target,
      version: KLEX_VERSION,
      onDiagnostic: (error) =>
        logger.debug(
          { error },
          'Self-update is unavailable for this installation',
        ),
    });
    if (installation) {
      updateManager = new UpdateManager({
        installation,
        onRestartRequested: (updatedInstallation) =>
          shutdown.requestRestart({
            arguments: process.argv.slice(2),
            cwd: process.cwd(),
            environment: process.env,
            launcher: updatedInstallation.currentExecutable,
          }),
      });
    }

    // The ESM SEA entry bundles the interactive UI together with the
    // application. This keeps the executable self-contained; only native
    // addons and runtime binaries remain external filesystem assets.
    const ui = createCliUi({
      logging: logger,
      onQuit: shutdown.requestExit,
      adminApi: runningAdminApi,
      dataDirectory: cli.dataDirectory,
      logStore,
      dangerousLocalAdminApiPort: cli.dangerousLocalAdminApiPort,
      debugTracingEnabled: cli.telemetryDebug && !cli.telemetryDisabled,
      updateManager,
    });
    cliUi = ui;
    ui.start();
    updateManager?.start();
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

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type {
  ModuleLogger,
  OTelLoggerOptions,
  OTelTransportControl,
  RootLogger,
} from '@stagewise/logger';

import { createAdminApi } from '@/admin-api';
import { createAgentDirectory, defaultAgentRoot } from '@/agent-directory';
import { createAgentPicker } from '@/agent-picker';
import { type AutoUpdate, createAutoUpdate } from '@/auto-update';
import type { CliOptions } from '@/cli';
import { createCliUi } from '@/cli-ui';
import {
  type CloudConnectivity,
  createCloudConnectivity,
} from '@/cloud-connectivity';
import { startRuntime } from '@/composition/runtime';
import { createConfig } from '@/config';
import { ensureDataDirectory } from '@/data-directory';
import { createDirectoryLock, type DirectoryLock } from '@/directory-lock';
import {
  createDrain,
  DEFAULT_TERMINATION_DRAIN_TIMEOUT_MS,
  type Drain,
} from '@/drain';
import { createGodMessages } from '@/god-messages';
import type { HealthServer } from '@/health-server';
import { createIntrospector } from '@/introspection';
import { createLocalData, type LocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';
import type { LogStore } from '@/log-store';
import { createMcp } from '@/mcp';
import { createModelCallLogger } from '@/model-call-logger';
import {
  createProductAnalytics,
  type EnrollmentTracker,
  resolvePostHogBuildConfig,
  type TrackEnrollment,
} from '@/product-analytics';
import {
  builtInProviderDefinitions,
  createProviderRegistry,
} from '@/provider-registry';
import { KLEX_VERSION, resolveReleaseTarget } from '@/release';
import { discoverManagedInstallation, UpdateManager } from '@/self-update';
import { createChatSession } from '@/session/chat';
import { createAudioInputOptimizerExt } from '@/session/chat/extensions/audio-input-optimizer';
import { createConsultExt } from '@/session/chat/extensions/consult';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import {
  createEpisodeSummaryExt,
  createEpisodeSummaryLog,
} from '@/session/chat/extensions/episode-summary';
import type { ExtensionFactory } from '@/session/chat/extensions/extension-api';
import {
  createGodMessagesDistrustExt,
  createGodMessagesTrustExt,
} from '@/session/chat/extensions/god-messages';
import { createImageInputOptimizerExt } from '@/session/chat/extensions/image-input-optimizer';
import { createJsReplSandboxExt } from '@/session/chat/extensions/js-repl-sandbox';
import {
  createLearningExt,
  createSkillCatalog,
} from '@/session/chat/extensions/learning';
import { createMcpIngressExt } from '@/session/chat/extensions/mcp-ingress';
import {
  createEpisodeFeed,
  createMemoryExt,
} from '@/session/chat/extensions/memory';
import { createNameLoaderExt } from '@/session/chat/extensions/name-loader';
import { createReadAttachmentExt } from '@/session/chat/extensions/read-attachment/read-attachment';
import {
  createSoulExt,
  createSoulExtGod,
  readSoul,
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
import { createSessionHistory } from '@/session-history';
import {
  closeWithTimeout,
  createShutdownCoordinator,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from '@/shutdown-coordinator';
import {
  createTelemetryExportConfiguration,
  describeTelemetryWarning,
  formatTelemetryWarning,
} from '@/telemetry-config';
import {
  createTelemetryManager,
  createTelemetrySpanProcessor,
  otlpMinLevel,
} from '@/telemetry-manager';
import { createTelemetryMetrics } from '@/telemetry-metrics';
import {
  createTelemetryPolicy,
  TELEMETRY_EVENT_LOG_NAMES,
} from '@/telemetry-policy';
import {
  createIdentityResourceAttributes,
  createTelemetryResourceAttributes,
} from '@/telemetry-resource';
import { createTracing, mapProviderName } from '@/tracing';

export interface ApplicationDependencies {
  cli: CliOptions;
  logging: RootLogger;
  logStore: LogStore;
  updateManager?: UpdateManager;
  disposeLogging: () => Promise<void>;
  closeInfrastructure: () => Promise<void>;
  healthServer?: HealthServer;
  attachTelemetryLogging: (options: OTelLoggerOptions) => OTelTransportControl;
}

export interface Application {
  start(): Promise<boolean>;
  close(): Promise<void>;
  requestExit(): void;
  requestTermination(): void;
  requestRestart(installation: {
    currentExecutable: string;
  }): Promise<void> | void;
}

class ApplicationModule implements Application {
  private readonly resources: (() => Promise<void>)[] = [];
  private starting: Promise<boolean> | undefined;
  private closing: Promise<void> | undefined;
  private shuttingDown = false;
  private exitHandler: (() => void) | undefined;
  private terminationHandler: (() => void) | undefined;
  private restartHandler:
    | ((installation: { currentExecutable: string }) => Promise<void> | void)
    | undefined;

  constructor(
    private readonly deps: ApplicationDependencies & { logger: ModuleLogger },
  ) {}

  start(): Promise<boolean> {
    this.starting ??= this.run().catch(async (error: unknown) => {
      await this.close();
      throw error;
    });
    return this.starting;
  }

  close(): Promise<void> {
    if (!this.starting) return Promise.resolve();
    this.closing ??= closeReverse(this.resources, this.deps.logger);
    return this.closing;
  }

  requestExit(): void {
    this.exitHandler?.();
  }
  requestTermination(): void {
    this.terminationHandler?.();
  }
  requestRestart(installation: {
    currentExecutable: string;
  }): Promise<void> | void {
    return this.restartHandler?.(installation);
  }

  private own(resource: { close(): Promise<void> }): () => Promise<void> {
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= Promise.resolve().then(() => resource.close()));
    // Rollback may stop waiting, but must not replace the actual cleanup result.
    // Normal shutdown is bounded only by the coordinator's overall deadline.
    this.resources.push(() =>
      this.shuttingDown ? close() : closeWithTimeout(close),
    );
    return close;
  }

  private async run(): Promise<boolean> {
    const { cli, logging, logger, logStore } = this.deps;
    const healthServer = this.deps.healthServer;
    const telemetryWarning = describeTelemetryWarning(
      cli.telemetryLevel,
      cli.telemetryEndpoint,
    );

    /** Minimum seconds between time updates before executable generations. */
    const TIME_UPDATE_PERIOD_SECONDS = 300;

    if (telemetryWarning) {
      // Headless output is the only place a human sees this; the interactive UI
      // renders its own persistent banner instead.
      if (cli.headless) {
        process.stderr.write(formatTelemetryWarning(telemetryWarning));
      }
      logger.warn(
        {
          telemetryLevel: cli.telemetryLevel,
          telemetryEndpoint: cli.telemetryEndpoint,
        },
        `${telemetryWarning.title}. ${telemetryWarning.lines.join(' ')}`,
      );
    }
    logger.info(
      {
        'event.name': 'klex.started',
        'service.version': KLEX_VERSION,
      },
      'Klex Bot started',
    );

    if (cli.dataDirectory === undefined && cli.headless) {
      throw new Error(
        'Headless mode requires --data-dir or KLEX_DATA_DIR to identify an agent directory',
      );
    }

    let runtimeCloud: CloudConnectivity | undefined;
    let runtimeMcp: ReturnType<typeof createMcp> | undefined;
    // Aggregate-only product analytics. On by default, independent of the
    // opt-in OTel telemetry. Started before the agent picker so its enrollment
    // flow is observable; `klex_agent_started` is sent only once an agent
    // directory has been opened. Every input is the CLI-resolved value (flag
    // over env), never re-read from env. MCP and cloud are late-bound.
    const productAnalytics = createProductAnalytics({
      ...resolvePostHogBuildConfig(),
      enabled: cli.analyticsEnabled,
      logging,
      klexVersion: KLEX_VERSION,
      deployment: cli.deployment,
      telemetryEnabledAtStart: cli.telemetryLevel !== 'no',
      cloudEnabled: cli.cloudEnabled,
      getConnectedMcpCount: () =>
        runtimeMcp
          ?.getServerStatuses()
          .filter((server) => server.status === 'connected').length,
      getCloudEnrolled: () => runtimeCloud?.isEnrolled(),
    });
    this.own(productAnalytics);
    await productAnalytics.start();
    const trackEnrollment: TrackEnrollment = (method) =>
      productAnalytics.trackEnrollment(method);

    let interactiveCloud: CloudConnectivity | undefined;
    let interactiveLocalData: LocalData | undefined;
    let interactiveLock: DirectoryLock | undefined;
    this.resources.push(async () => {
      await closeWithTimeout(async () => {
        await interactiveLock?.release();
      });
    });
    this.resources.push(async () => {
      await closeWithTimeout(async () => {
        await interactiveLocalData?.close();
      });
    });
    this.resources.push(async () => {
      await closeWithTimeout(async () => {
        await interactiveCloud?.close();
      });
    });
    const agentDirectory = createAgentDirectory({
      logging,
      rootDirectory: cli.agentRoot || defaultAgentRoot(),
    });
    if (cli.dataDirectory === undefined) {
      // The picker's enrollment wizard. Open while the token prompt is shown.
      let pickerEnrollment: EnrollmentTracker | undefined;
      const finishPickerEnrollment = (
        outcome: Parameters<EnrollmentTracker['finish']>[0],
      ) => {
        pickerEnrollment?.finish(outcome);
        pickerEnrollment = undefined;
      };
      const selectedDirectory = await createAgentPicker({
        agentDirectory,
        prepareAgent: async (directory) => {
          finishPickerEnrollment('aborted');
          await interactiveCloud?.close().catch(() => undefined);
          interactiveCloud = undefined;
          await interactiveLocalData?.close().catch(() => undefined);
          interactiveLocalData = undefined;
          await interactiveLock?.release().catch(() => undefined);
          interactiveLock = undefined;

          await ensureDataDirectory(directory);
          const lock = createDirectoryLock({
            logging,
            dataDirectory: directory,
          });
          await lock.acquire();
          interactiveLock = lock;

          let cloud: CloudConnectivity | undefined;
          try {
            const localData = createLocalData({
              logging,
              dataDirectory: directory,
              klexVersion: KLEX_VERSION,
              stores: KLEX_LOCAL_DATA_STORES,
            });
            interactiveLocalData = localData;
            await localData.start();
            if (!cli.cloudEnabled) return false;

            cloud = createCloudConnectivity({
              logging,
              dataDirectory: directory,
              cloudEnabled: true,
              cloudBaseUrl: cli.cloudBaseUrl,
              // A supplied token completes enrollment without another prompt;
              // otherwise the wizard collects one below.
              enrollmentToken: cli.cloudEnrollToken,
              allowDangerousUnsecureCloud: cli.allowDangerousUnsecureCloud,
              onTokenEnrollment: () => trackEnrollment('token'),
            });
            interactiveCloud = cloud;
            await cloud.start();
            const needsEnrollment = !cloud.isEnrolled();
            // The picker shows its token prompt exactly when this is true.
            if (needsEnrollment) {
              pickerEnrollment = trackEnrollment('agent_picker');
            }
            return needsEnrollment;
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
          try {
            await interactiveCloud?.enroll(token);
          } catch (error) {
            // The picker keeps the prompt open for another attempt.
            pickerEnrollment?.attemptFailed();
            throw error;
          }
          finishPickerEnrollment('enrolled');
        },
        onEnrollmentCancelled: () => finishPickerEnrollment('aborted'),
      }).choose();
      finishPickerEnrollment('aborted');
      if (selectedDirectory === undefined) return false;
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
        logging,
        dataDirectory: cli.dataDirectory,
      });
    const releaseLock = this.own({ close: () => dirLock.release() });
    if (!interactiveLock) await dirLock.acquire();
    interactiveLock = undefined;

    const localData =
      interactiveLocalData ??
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: KLEX_VERSION,
        stores: KLEX_LOCAL_DATA_STORES,
      });
    this.own(localData);
    if (!interactiveLocalData) await localData.start();
    interactiveLocalData = undefined;

    const config = createConfig({
      logging,
      dataDirectory: cli.dataDirectory,
    });
    this.own(config);
    let tracing: ReturnType<typeof createTracing> | undefined;
    let telemetryMetrics: ReturnType<typeof createTelemetryMetrics> | undefined;

    await config.start();
    // The agent directory is now locked, migrated and has a valid config:
    // headless with a valid --data-dir, or the agent the user picked.
    productAnalytics.agentStarted();
    // Telemetry is resolved from CLI/env only. Any legacy `telemetry` entry in
    // config.json is ignored. No endpoint means no exporter is ever built.
    const telemetryLevel = cli.telemetryLevel;
    const telemetryPolicy = createTelemetryPolicy(telemetryLevel);
    const spanProcessor = createTelemetrySpanProcessor(telemetryLevel);
    const telemetryExport = cli.telemetryEndpoint
      ? createTelemetryExportConfiguration(cli.telemetryEndpoint, process.env, {
          allowInsecure: cli.telemetryAllowInsecure,
        })
      : undefined;
    // OTel `service.instance.id` is per process instance; the stable identity
    // is the enrolled cloud client id carried in the resource attributes.
    const telemetryInstanceId = randomUUID();
    const telemetryResourceAttributes = createTelemetryResourceAttributes({
      serviceName: 'klex',
      serviceNamespace: 'stagewise',
      serviceVersion: KLEX_VERSION,
      serviceInstanceId: telemetryInstanceId,
    });
    // Identity attributes shared by all signals: enrolled cloud client id from
    // basic, agent name from advanced, data directory at debug. Evaluated per
    // export so runtime level changes and later enrollment are picked up.
    const getCloudClientId = () =>
      runtimeCloud?.getEnrollmentState().clientId ?? null;
    const identityResourceAttributes = createIdentityResourceAttributes({
      getLevel: () => telemetryPolicy.getSnapshot().level,
      agent: {
        agentName: config.get().officialName,
        dataDirectory: resolve(dataDirectory),
      },
      getCloudClientId,
    });
    spanProcessor.setDynamicResourceAttributes(identityResourceAttributes);
    const telemetryLogTransport = telemetryExport
      ? this.deps.attachTelemetryLogging({
          url: telemetryExport.logsUrl,
          headers: { ...telemetryExport.headers },
          minLevel: otlpMinLevel(telemetryPolicy.getSnapshot().logThreshold),
          telemetryLevel: () => telemetryPolicy.getSnapshot().level,
          eventsBelowMinLevel: TELEMETRY_EVENT_LOG_NAMES,
          resourceAttributes: telemetryResourceAttributes,
          dynamicResourceAttributes: identityResourceAttributes,
        })
      : undefined;
    tracing = createTracing({
      logging,
      otlpUrl: telemetryExport?.tracesUrl,
      otlpHeaders: { ...telemetryExport?.headers },
      serviceName: 'klex',
      resourceAttributes: telemetryResourceAttributes,
      spanProcessor,
      policy: telemetryPolicy,
      // Traces are exported only at advanced and debug, so span-level agent
      // identity never reaches basic telemetry.
      agentName: config.get().officialName,
      getAgentId: getCloudClientId,
      enabled: telemetryPolicy.getSnapshot().tracesEnabled,
    });
    const closeTracing = this.own(tracing);
    await tracing.start();
    telemetryMetrics = createTelemetryMetrics({
      logging,
      endpoint: telemetryExport?.metricsUrl,
      headers: { ...telemetryExport?.headers },
      dataDirectory,
      enabled: telemetryLevel !== 'no',
      instanceId: telemetryInstanceId,
      serviceVersion: KLEX_VERSION,
      resourceAttributes: telemetryResourceAttributes,
      dynamicResourceAttributes: identityResourceAttributes,
      policy: telemetryPolicy,
    });
    this.own(telemetryMetrics);
    await telemetryMetrics.start();
    const timezone = config.get().timezone;
    const providerRegistry = createProviderRegistry({
      logging,
      config,
      definitions: builtInProviderDefinitions,
      getSoul: () =>
        readSoul(join(dataDirectory, 'extensions', createSoulExt.identifier)),
    });
    this.own(providerRegistry);
    await providerRegistry.start();

    // Cloud connectivity: identity is always created; enrollment + token
    // client are initialized only when cloud is enabled.
    const cloudConnectivity =
      interactiveCloud ??
      createCloudConnectivity({
        logging,
        dataDirectory: cli.dataDirectory,
        cloudEnabled: cli.cloudEnabled,
        cloudBaseUrl: cli.cloudBaseUrl,
        enrollmentToken: cli.cloudEnrollToken,
        allowDangerousUnsecureCloud: cli.allowDangerousUnsecureCloud,
        onTokenEnrollment: () => trackEnrollment('token'),
      });
    runtimeCloud = cloudConnectivity;
    const realtimeComposition = {
      resolveProvider: () => providerRegistry.resolveRealtimeProvider(),
      ownedConnector: createProductionMediaTransportConnector(),
    };
    const realtimeMediaCapability = PRODUCTION_REALTIME_MEDIA_CAPABILITY;
    const mcp = createMcp({
      logging,
      config,
      realtimeMediaCapability,
      dataDirectory: cli.dataDirectory,
      cloudConnectivity,
    });
    runtimeMcp = mcp;
    const introspector = createIntrospector({ logging });

    const modelCallLogger = createModelCallLogger({
      logging,
      dataDirectory: cli.dataDirectory,
    });

    const sessionHistory = createSessionHistory({
      logging,
      dataDirectory: cli.dataDirectory,
      config,
    });

    tracing.setModelCallSink((record) => {
      modelCallLogger.recordCall(record);
      telemetryMetrics?.recordModelCall({
        sessionId: record.sessionId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        inputCacheReadTokens: record.inputCacheReadTokens,
        inputCacheWriteTokens: record.inputCacheWriteTokens,
        operationName:
          record.api === 'evaluation' ? 'evaluate' : 'generate_content',
        tokenUsageReported: record.tokenUsageReported === true,
        cacheUsageReported: record.cacheUsageReported === true,
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
      logging,
      config,
      modelResolver: providerRegistry,
      dataDirectory,
      telemetryMetrics,
      productAnalytics,
      sessionHistory,
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
          parentSpanContext: params.parentSpanContext,
        });

    const defaultTimeExt = createTimeExt({
      timeUpdatePeriod: TIME_UPDATE_PERIOD_SECONDS,
      timezone,
    });

    // Agent-wide hubs: memory publishes episodes, learning publishes skills,
    // episode-summary publishes episode titles.
    const episodeFeed = createEpisodeFeed();
    const skillCatalog = createSkillCatalog();
    const episodeSummaryLog = createEpisodeSummaryLog();

    // Default session: full extension set + MCP access.
    const defaultSessionFactory = makeSessionFactory([
      createNameLoaderExt,
      createSoulExt,
      createGodMessagesDistrustExt,
      createJsReplSandboxExt,
      createContextCompactionExt,
      defaultTimeExt,
      createImageInputOptimizerExt,
      createAudioInputOptimizerExt,
      createReadAttachmentExt,
      createTodosExt,
      createMcpIngressExt(),
      createMemoryExt({ episodeFeed }),
      createLearningExt({
        episodes: episodeFeed,
        skillCatalog,
        getSoul: () =>
          readSoul(join(dataDirectory, 'extensions', createSoulExt.identifier)),
      }),
      createEpisodeSummaryExt({
        episodes: episodeFeed,
        summaryLog: episodeSummaryLog,
      }),
      createConsultExt({
        childExtensionFactories: [createSoulExt, defaultTimeExt],
        maxActiveSessions: 2,
        maxReportsPerSession: 3,
        maxContextMessages: 5,
      }),
    ]);

    const sessionHost = createSessionHost({
      logging,
      mcp,
      introspection: introspector,
      sessionFactory: defaultSessionFactory,
      basePrompt: systemPrompt,
    });

    // God session: no MCP, trust-mode god-messages, soul-god variant.
    // js-repl-sandbox excluded — it requires MCP access.
    const godMessages = createGodMessages({
      logging,
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
      logging,
      config,
      mcp,
      introspector,
      modelCallLogger,
      providerRegistry,
      cloudConnectivity,
      godMessages,
      sessionHistory,
      skillCatalog,
      episodeSummaryLog,
      localPort: cli.dangerousLocalAdminApiPort,
      timezone,
    });
    const telemetryManager = createTelemetryManager({
      logging,
      level: telemetryLevel,
      spanProcessor,
      policy: telemetryPolicy,
      logTransport: telemetryLogTransport,
      metrics: telemetryMetrics,
      tracing,
    });
    const realtime = createRealtime({
      logging,
      mcp,
      resolveProvider: realtimeComposition.resolveProvider,
      ownedConnector: realtimeComposition.ownedConnector,
      conversationHost: sessionHost,
    });
    cloudConnectivity.setTunnelRequestHandler(adminApi.handle.bind(adminApi));
    const runtime = await startRuntime({
      logging,
      modules: {
        modelCallLogger,
        sessionHistory,
        adminApi,
        cloudConnectivity,
        sessionHost,
        realtime,
        mcp,
        telemetryManager,
        godMessages,
      },
    });
    interactiveCloud = undefined;
    // Normal runtime shutdown must preserve dependency ordering, even when a
    // session takes longer than the partial-startup cleanup deadline.
    const runningRuntime = runtime;
    this.resources.push(() => runningRuntime.close());
    const runningAdminApi = adminApi;
    let cliUi: { start(): void; close(): void } | undefined;
    let updateManager: UpdateManager | undefined = this.deps.updateManager;
    let autoUpdate: AutoUpdate | undefined;
    const drain: Drain | undefined =
      sessionHost && godMessages && mcp
        ? createDrain({
            logging,
            sessionHost,
            godMessages,
            mcp,
            onBegin: () => healthServer?.markNotReady(),
          })
        : undefined;

    const flushTelemetry = async (): Promise<void> => {
      const telemetryFlushes = await Promise.allSettled([
        telemetryMetrics?.forceFlush(),
        tracing?.forceFlush(),
      ]);
      for (const result of telemetryFlushes) {
        if (result.status === 'rejected') {
          logger.warn({ error: result.reason }, 'Telemetry flush failed');
        }
      }
    };

    const shutdown = createShutdownCoordinator({
      beforeCleanup: async () => {
        healthServer?.markNotReady();
        await flushTelemetry();
      },
      closeUi: () => cliUi?.close(),
      cleanup: async () => {
        this.shuttingDown = true;
        // Tell Klex Cloud first: the agent stops accepting tunneled work now,
        // and a slow teardown below must not consume the shutdown deadline
        // before the cloud learns about it. Token access stays available for
        // modules that still close authenticated connections.
        await runtimeCloud?.disconnect().catch((error: unknown) => {
          logger.warn({ error }, 'Klex Cloud disconnect failed');
        });
        const updateState = updateManager?.getState();
        autoUpdate?.close();
        if (!this.deps.updateManager) {
          updateManager?.stop();
          if (updateState?.status !== 'restarting') {
            await updateManager?.cancelInstall();
          }
        }
        // Ordered teardown: event ingress and realtime sessions stop before the
        // default session and its extensions close.
        await runningRuntime?.close();
        // Flush telemetry after producers stop, while providers are still alive.
        // This avoids relying solely on provider shutdown hooks under the outer
        // shutdown deadline.
        await flushTelemetry();
        // Dispose pre-runtime providers only after the explicit flush phase.
        await this.close();
        await this.deps.closeInfrastructure();
        // Observe the original cleanup results. Retrying these idempotent
        // methods would hide a failed first attempt behind a successful no-op.
        const [lockRelease, tracingClose] = await Promise.allSettled([
          releaseLock(),
          closeTracing(),
        ]);
        // Logger disposal is last so shutdown diagnostics and buffered OTLP logs
        // are drained after every other telemetry provider has stopped.
        await this.deps.disposeLogging();
        if (lockRelease.status === 'rejected') {
          throw new Error('Could not release the agent-directory lock', {
            cause: lockRelease.reason,
          });
        }
        if (tracingClose.status === 'rejected') throw tracingClose.reason;
      },
      exit: (code) => process.exit(code),
      timeoutMs: resolveShutdownTimeoutMs(
        process.env.KLEX_SHUTDOWN_TIMEOUT_MS,
        logger,
      ),
      onRestartError: (error) => {
        process.stderr.write(
          `\nKlex update installed but restart failed: ${error.message}\n` +
            'Run Klex again from your terminal to start the installed version.\n',
        );
      },
    });

    const requestExit = () => {
      healthServer?.markNotReady();
      shutdown.requestExit();
    };
    this.exitHandler = requestExit;
    // Headless (hosted agents, Kubernetes rollouts): SIGTERM lets the current
    // work finish within a wall-clock budget, because the orchestrator sends
    // SIGKILL at its own deadline. A second SIGTERM or a SIGINT exits at once.
    const terminationDrainTimeoutMs = resolveTerminationDrainTimeoutMs(
      process.env.KLEX_DRAIN_TIMEOUT_MS,
      logger,
    );
    this.terminationHandler = () => {
      healthServer?.markNotReady();
      if (!cli.headless || !drain || terminationDrainTimeoutMs === 0) {
        shutdown.requestExit();
        return;
      }
      shutdown.requestGracefulExit(() =>
        drain.drain({
          reason: 'termination',
          timeoutMs: terminationDrainTimeoutMs,
          pauseWhileLeased: false,
        }),
      );
    };
    // Closing the terminal (or the console window on Windows) sends SIGHUP.
    // Without a handler Node terminates immediately and skips cloud notification.

    // Self-update: offered in the interactive UI, or installed automatically
    // with --auto-update (TUI and headless).
    this.restartHandler = (updatedInstallation) => {
      const restart = () =>
        shutdown.requestRestart({
          arguments: process.argv.slice(2),
          cwd: process.cwd(),
          environment: {
            ...process.env,
            KLEX_DATA_DIR: resolve(dataDirectory),
          },
          launcher: updatedInstallation.currentExecutable,
        });
      return autoUpdate
        ? autoUpdate.drainForRestart().then(restart)
        : restart();
    };
    if (!updateManager && !cli.headless && !cli.autoUpdate) {
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
        const manualUpdateManager = new UpdateManager({
          installation,
          onRestartRequested: (updatedInstallation) => {
            this.requestRestart(updatedInstallation);
          },
        });
        updateManager = manualUpdateManager;
        this.resources.push(async () => {
          const restarting =
            manualUpdateManager.getState().status === 'restarting';
          manualUpdateManager.stop();
          if (!restarting) await manualUpdateManager.cancelInstall();
        });
      }
    }

    if (cli.autoUpdate && updateManager && drain) {
      autoUpdate = createAutoUpdate({ logging, updateManager, drain });
      this.resources.push(async () => {
        autoUpdate?.close();
      });
    }

    // Interactive CLI UI — default mode. Headless mode skips the UI.
    if (!cli.headless) {
      // The ESM SEA entry bundles the interactive UI together with the
      // application. This keeps the executable self-contained; only native
      // addons and runtime binaries remain external filesystem assets.
      const ui = createCliUi({
        logging,
        onQuit: requestExit,
        adminApi: runningAdminApi,
        dataDirectory: cli.dataDirectory,
        logStore,
        dangerousLocalAdminApiPort: cli.dangerousLocalAdminApiPort,
        telemetryWarning,
        updateManager,
        trackEnrollment,
      });
      cliUi = ui;
      this.resources.push(async () => {
        ui.close();
      });
      ui.start();
    }
    if (!cli.autoUpdate) updateManager?.start();
    // Readiness signal for orchestrators and the container smoke test: every
    // runtime module has started and SIGTERM now drains instead of exiting.
    healthServer?.markReady();
    logger.info(
      {
        'event.name': 'klex.ready',
        'service.version': KLEX_VERSION,
        headless: cli.headless,
      },
      'Klex Bot ready',
    );
    return true;
  }
}

export function createApplication(deps: ApplicationDependencies): Application {
  return new ApplicationModule({
    ...deps,
    logger: deps.logging.child({
      name: 'application',
      bindings: { module: 'application' },
    }),
  });
}

function resolveShutdownTimeoutMs(
  value: string | undefined,
  logger: Pick<ModuleLogger, 'warn' | 'error'>,
): number {
  if (!value) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) {
    return Math.floor(parsed);
  }
  logger.warn(
    { value, fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS },
    'Ignoring invalid KLEX_SHUTDOWN_TIMEOUT_MS',
  );
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function resolveTerminationDrainTimeoutMs(
  value: string | undefined,
  logger: Pick<ModuleLogger, 'warn' | 'error'>,
): number {
  if (!value) return DEFAULT_TERMINATION_DRAIN_TIMEOUT_MS;
  const parsed = Number(value);
  // 0 disables the drain; the upper bound keeps a typo from parking a pod.
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 3_600_000) {
    return Math.floor(parsed);
  }
  logger.warn(
    { value, fallback: DEFAULT_TERMINATION_DRAIN_TIMEOUT_MS },
    'Ignoring invalid KLEX_DRAIN_TIMEOUT_MS',
  );
  return DEFAULT_TERMINATION_DRAIN_TIMEOUT_MS;
}

async function closeReverse(
  resources: readonly (() => Promise<void>)[],
  logger: Pick<ModuleLogger, 'warn' | 'error'>,
): Promise<void> {
  for (const resource of [...resources].reverse()) {
    await resource().catch((error: unknown) => {
      logger.error({ error }, 'Resource shutdown failed');
    });
  }
}

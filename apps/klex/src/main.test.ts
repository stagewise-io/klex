import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RestartRequest,
  ShutdownCoordinatorOptions,
} from '@/shutdown-coordinator';

const mocks = vi.hoisted(() => {
  const resource = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    acquire: vi.fn(async () => undefined),
    release: vi.fn(async (): Promise<void> => undefined),
    get: () => ({ officialName: 'Selected agent', timezone: 'UTC' }),
    agentStarted: vi.fn(),
    trackEnrollment: vi.fn(() => ({ attemptFailed: vi.fn(), finish: vi.fn() })),
    setDynamicResourceAttributes: vi.fn(),
    setModelCallSink: vi.fn(),
    handle: vi.fn(),
    setTunnelRequestHandler: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    forceFlush: vi.fn(async () => undefined),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    settings: {},
    [Symbol.asyncDispose]: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    resource,
    bootstraps: [] as { close(): Promise<void> }[],
    createConfig: vi.fn(),
    createTracing: vi.fn(),
    shutdowns: [] as ShutdownCoordinatorOptions[],
    checkForUpdates: vi.fn(async () => undefined),
    healthServer: {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      markReady: vi.fn(),
      markNotReady: vi.fn(),
    },
    logger,
    selectedDirectory: 'agents/selected agent',
    createLearningExt:
      vi.fn<(options: { getSoul: () => string | null }) => void>(),
    readSoul: vi.fn((_directory: string) => 'Current soul'),
    createAgent: vi.fn(),
    createCloudConnectivity: vi.fn(),
    createAgentPicker: vi.fn(),
    createCliUi: vi.fn(),
    ensureDataDirectory: vi.fn(),
    requestRestart: vi.fn<(request: RestartRequest) => void>(),
    onRestartRequested: undefined as
      | ((installation: { currentExecutable: string }) => void)
      | undefined,
  };
});

vi.mock('@stagewise/logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('@/admin-api', () => ({ createAdminApi: () => mocks.resource }));
vi.mock('@/agent-directory', () => ({
  createAgentDirectory: () => ({ create: mocks.createAgent }),
  defaultAgentRoot: () => '/unused/agents',
}));
vi.mock('@/agent-picker', () => ({
  createAgentPicker: mocks.createAgentPicker,
}));
vi.mock('@/cli-ui', () => ({ createCliUi: mocks.createCliUi }));
vi.mock('@/cloud-connectivity', () => ({
  createCloudConnectivity: mocks.createCloudConnectivity,
}));
vi.mock('@/composition/runtime', () => ({
  startRuntime: () => mocks.resource,
}));
vi.mock('@/config', () => ({ createConfig: mocks.createConfig }));
vi.mock('@/data-directory', () => ({
  ensureDataDirectory: mocks.ensureDataDirectory,
}));
vi.mock('@/directory-lock', () => ({
  createDirectoryLock: () => mocks.resource,
}));
vi.mock('@/god-messages', () => ({ createGodMessages: vi.fn() }));
vi.mock('@/health-server', () => ({
  createHealthServer: () => mocks.healthServer,
}));
vi.mock('@/introspection', () => ({ createIntrospector: vi.fn() }));
vi.mock('@/local-data', () => ({ createLocalData: () => mocks.resource }));
vi.mock('@/local-data-registry', () => ({ KLEX_LOCAL_DATA_STORES: [] }));
vi.mock('@/log-store', () => ({ createLogStore: vi.fn() }));
vi.mock('@/mcp', () => ({ createMcp: vi.fn() }));
vi.mock('@/model-call-logger', () => ({ createModelCallLogger: vi.fn() }));
vi.mock('@/product-analytics', () => ({
  createProductAnalytics: () => mocks.resource,
  resolveDeployment: () => 'self_hosted',
  resolvePostHogBuildConfig: vi.fn(),
}));
vi.mock('@/provider-registry', () => ({
  builtInProviderDefinitions: [],
  createProviderRegistry: () => mocks.resource,
  PROVIDER_CREDENTIALS_STORE_DEFINITION: {
    relativePath: 'credentials/providers.json',
  },
  ProviderCredentialStore: class {},
}));
vi.mock('@/release/verify-native', () => ({ runNativeVerification: vi.fn() }));
vi.mock('@/self-update', () => ({
  discoverManagedInstallation: () => ({ currentExecutable: '/managed/klex' }),
  UpdateManager: class {
    constructor(options: {
      onRestartRequested: typeof mocks.onRestartRequested;
    }) {
      mocks.onRestartRequested = options.onRestartRequested;
    }
    start() {}
    check = mocks.checkForUpdates;
    getState() {
      return { status: 'up-to-date' };
    }
    stop() {}
    async cancelInstall() {}
  },
}));
vi.mock('@/session/chat', () => ({ createChatSession: vi.fn() }));
vi.mock('@/session/chat/extensions/audio-input-optimizer', () => ({
  createAudioInputOptimizerExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/consult', () => ({
  createConsultExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/context-compaction', () => ({
  createContextCompactionExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/episode-summary', () => ({
  createEpisodeSummaryExt: vi.fn(),
  createEpisodeSummaryLog: vi.fn(),
}));
vi.mock('@/session/chat/extensions/god-messages', () => ({
  createGodMessagesDistrustExt: vi.fn(),
  createGodMessagesTrustExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/image-input-optimizer', () => ({
  createImageInputOptimizerExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/js-repl-sandbox', () => ({
  createJsReplSandboxExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/learning', () => ({
  createLearningExt: mocks.createLearningExt,
}));
vi.mock('@/session/chat/extensions/skills', () => ({
  createSkillsExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/mcp-ingress', () => ({
  createMcpIngressExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/memory', () => ({
  createMemoryExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/name-loader', () => ({
  createNameLoaderExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/read-attachment/read-attachment', () => ({
  createReadAttachmentExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/soul', () => ({
  createSoul: vi.fn(() => ({ get: () => null })),
  createSoulExt: { identifier: 'io.stagewise/soul', create: vi.fn() },
  createSoulExtGod: vi.fn(),
  readSoul: mocks.readSoul,
}));
vi.mock('@/session/chat/extensions/time', () => ({
  createTimeExt: vi.fn(),
  createTimeExtGod: vi.fn(),
}));
vi.mock('@/session/chat/extensions/todos', () => ({ createTodosExt: vi.fn() }));
vi.mock('@/skills', () => ({ createSkillRegistry: () => mocks.resource }));
vi.mock('@/session/realtime', () => ({
  createProductionMediaTransportConnector: vi.fn(),
  createRealtime: vi.fn(),
  PRODUCTION_REALTIME_MEDIA_CAPABILITY: {},
}));
vi.mock('@/session/session-host', () => ({ createSessionHost: vi.fn() }));
vi.mock('@/session/chat/utils/system-prompt.md', () => ({ default: '' }));
vi.mock('@/shutdown-coordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shutdown-coordinator')>()),
  createShutdownCoordinator: (options: ShutdownCoordinatorOptions) => {
    mocks.shutdowns.push(options);
    return {
      requestExit: vi.fn(),
      requestRestart: mocks.requestRestart,
    };
  },
  DEFAULT_SHUTDOWN_TIMEOUT_MS: 15_000,
}));
vi.mock('@/telemetry-manager', () => ({
  createTelemetryManager: vi.fn(),
  createTelemetrySpanProcessor: () => mocks.resource,
}));
vi.mock('@/telemetry-metrics', () => ({
  createTelemetryMetrics: () => mocks.resource,
}));
vi.mock('@/telemetry-policy', () => ({
  createTelemetryPolicy: () => ({
    getSnapshot: () => ({ tracesEnabled: false }),
  }),
}));
vi.mock('@/telemetry-resource', () => ({
  createIdentityResourceAttributes: vi.fn(),
  createTelemetryResourceAttributes: vi.fn(),
}));
vi.mock('@/tracing', () => ({ createTracing: mocks.createTracing }));
vi.mock('@/update-bootstrap', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/update-bootstrap')>();
  return {
    ...original,
    createUpdateBootstrap: (
      deps: Parameters<typeof original.createUpdateBootstrap>[0],
    ) => {
      const bootstrap = original.createUpdateBootstrap(deps);
      mocks.bootstraps.push(bootstrap);
      return bootstrap;
    },
  };
});

describe('managed-update agent continuity', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('KLEX_DATA_DIR', '');
    vi.stubEnv('KLEX_HOME', '/custom/klex-home');
    vi.stubEnv('KLEX_HEADLESS', '0');
    vi.stubEnv('KLEX_NO_CLOUD', '1');
    vi.stubEnv('KLEX_DISABLE_TELEMETRY', '1');
    vi.stubEnv('KLEX_NO_ANALYTICS', '1');
    vi.stubEnv('KLEX_HEALTH_PORT', '');
    vi.spyOn(process, 'on').mockReturnValue(process);
    mocks.onRestartRequested = undefined;
    mocks.createAgentPicker.mockImplementation(
      (options: { prepareAgent: (directory: string) => Promise<boolean> }) => ({
        choose: async () => {
          await options.prepareAgent(mocks.selectedDirectory);
          return mocks.selectedDirectory;
        },
      }),
    );
    mocks.createAgent.mockResolvedValue({
      directory: mocks.selectedDirectory,
      officialName: 'Agent',
      inUse: false,
    });
    mocks.createCloudConnectivity.mockReturnValue(mocks.resource);
    mocks.createCliUi.mockReturnValue(mocks.resource);
    mocks.createConfig.mockReturnValue(mocks.resource);
    mocks.createTracing.mockReturnValue(mocks.resource);
    mocks.shutdowns.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      mocks.bootstraps.splice(0).map((bootstrap) => bootstrap.close()),
    );
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function launch(arguments_: string[] = []): Promise<void> {
    mocks.onRestartRequested = undefined;
    process.argv = [process.execPath, 'klex', ...arguments_];
    await import('./main');
    await vi.waitFor(() => {
      expect(mocks.logger.fatal).not.toHaveBeenCalled();
      expect(mocks.onRestartRequested).toBeTypeOf('function');
    });
  }

  function requestRestart(): RestartRequest {
    expect(mocks.onRestartRequested).toBeTypeOf('function');
    mocks.onRestartRequested?.({ currentExecutable: '/managed/updated/klex' });
    expect(mocks.requestRestart).toHaveBeenCalledOnce();
    const request = mocks.requestRestart.mock.calls[0]?.[0];
    if (!request) throw new Error('No restart request was captured');
    return request;
  }

  it.each([false, true])(
    'closes the health listener on picker cancellation after preparation=%s',
    async (prepareAgent) => {
      mocks.createAgentPicker.mockImplementation(
        (options: {
          prepareAgent: (directory: string) => Promise<boolean>;
        }) => ({
          choose: async () => {
            expect(mocks.healthServer.start).toHaveBeenCalledOnce();
            if (prepareAgent) {
              await options.prepareAgent(mocks.selectedDirectory);
            }
            return undefined;
          },
        }),
      );
      process.argv = [process.execPath, 'klex', '--health-port', '8081'];
      await import('./main');
      await vi.waitFor(
        () => {
          expect(mocks.resource.close).toHaveBeenCalled();
          expect(mocks.healthServer.close).toHaveBeenCalledOnce();
        },
        { timeout: 5_000 },
      );
      expect(mocks.logger.fatal).not.toHaveBeenCalled();
      expect(mocks.healthServer.markReady).not.toHaveBeenCalled();
      expect(mocks.createCliUi).not.toHaveBeenCalled();
      expect(mocks.onRestartRequested).toBeUndefined();
      if (prepareAgent) {
        expect(mocks.resource.release).toHaveBeenCalledOnce();
      }
    },
  );

  it('releases enrollment resources on cancellation before reopening the same bot', async () => {
    vi.stubEnv('KLEX_NO_CLOUD', '0');
    mocks.createCloudConnectivity.mockReturnValue({
      ...mocks.resource,
      isEnrolled: () => false,
    });
    mocks.createAgentPicker.mockImplementation(
      (options: {
        prepareAgent: (directory: string) => Promise<boolean>;
        onEnrollmentCancelled: (directory: string) => Promise<void>;
      }) => ({
        choose: async () => {
          await options.prepareAgent(mocks.selectedDirectory);
          expect(mocks.resource.acquire).toHaveBeenCalledTimes(1);
          await options.onEnrollmentCancelled(mocks.selectedDirectory);
          expect(mocks.resource.release).toHaveBeenCalledTimes(1);
          expect(mocks.resource.close).toHaveBeenCalledTimes(2);
          await options.prepareAgent(mocks.selectedDirectory);
          expect(mocks.resource.acquire).toHaveBeenCalledTimes(2);
          await options.onEnrollmentCancelled(mocks.selectedDirectory);
          expect(mocks.resource.release).toHaveBeenCalledTimes(2);
          return undefined;
        },
      }),
    );
    process.argv = [process.execPath, 'klex'];
    await import('./main');
    await vi.waitFor(() =>
      expect(mocks.resource.release).toHaveBeenCalledTimes(2),
    );
    expect(mocks.logger.fatal).not.toHaveBeenCalled();
  });

  it.each(['cloud', 'local data', 'lock'])(
    'attempts all enrollment cleanup after a failed %s teardown and retries before reopening',
    async (failure) => {
      vi.stubEnv('KLEX_NO_CLOUD', '0');
      const error = new Error('Cleanup failed');
      const cloudClose = vi.fn(async () => undefined);
      mocks.createCloudConnectivity.mockReturnValue({
        ...mocks.resource,
        close: cloudClose,
        isEnrolled: () => false,
      });
      const completed = vi.fn();
      mocks.createAgentPicker.mockImplementation(
        (options: {
          prepareAgent: (directory: string) => Promise<boolean>;
          onEnrollmentCancelled: (directory: string) => Promise<void>;
        }) => ({
          choose: async () => {
            await options.prepareAgent(mocks.selectedDirectory);
            const failedClose =
              failure === 'cloud'
                ? cloudClose
                : failure === 'local data'
                  ? mocks.resource.close
                  : mocks.resource.release;
            failedClose.mockRejectedValueOnce(error);
            await expect(
              options.onEnrollmentCancelled(mocks.selectedDirectory),
            ).rejects.toThrow('Could not close bot enrollment resources');
            expect(cloudClose).toHaveBeenCalledTimes(1);
            expect(mocks.resource.close).toHaveBeenCalledTimes(1);
            expect(mocks.resource.release).toHaveBeenCalledTimes(1);
            await options.prepareAgent(mocks.selectedDirectory);
            expect(failedClose).toHaveBeenCalledTimes(2);
            expect(mocks.resource.acquire).toHaveBeenCalledTimes(2);
            await options.onEnrollmentCancelled(mocks.selectedDirectory);
            completed();
            return undefined;
          },
        }),
      );
      process.argv = [process.execPath, 'klex'];
      await import('./main');
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      expect(mocks.logger.fatal).not.toHaveBeenCalled();
    },
  );

  it('checks for updates before config loading and survives a config startup failure', async () => {
    const failure = new Error('Existing configuration cannot be loaded');
    const configClose = vi.fn(async () => undefined);
    const configStart = vi.fn(async () => {
      throw failure;
    });
    mocks.createConfig.mockReturnValue({
      ...mocks.resource,
      start: configStart,
      close: configClose,
    });
    process.argv = [
      process.execPath,
      'klex',
      '--headless',
      '--auto-update',
      '--data-dir',
      'existing/agent',
      '--health-port',
      '8081',
    ];
    await import('./main');
    await vi.waitFor(() => {
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('update-recovery mode'),
      );
    });
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(configStart).toHaveBeenCalledOnce();
    const startOrder = configStart.mock.invocationCallOrder[0];
    if (startOrder === undefined) throw new Error('Config did not start');
    expect(mocks.checkForUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      startOrder,
    );
    expect(configClose).toHaveBeenCalledOnce();
    expect(mocks.resource.release).toHaveBeenCalledOnce();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { error: failure },
      'Agent startup failed',
    );
    expect(mocks.logger.fatal).not.toHaveBeenCalled();
    expect(mocks.healthServer.start).toHaveBeenCalledOnce();
    expect(mocks.healthServer.markReady).not.toHaveBeenCalled();
    expect(mocks.healthServer.close).not.toHaveBeenCalled();
    expect(mocks.createCliUi).not.toHaveBeenCalled();
  });

  it('bounds stalled provider cleanup during startup rollback', async () => {
    const closed = Promise.withResolvers<void>();
    const close = vi.fn(() => closed.promise);
    mocks.createConfig.mockReturnValue({
      ...mocks.resource,
      start: vi.fn(async () => {
        throw new Error('Configuration startup failed');
      }),
      close,
    });
    process.argv = [
      process.execPath,
      'klex',
      '--headless',
      '--auto-update',
      '--data-dir',
      'existing/agent',
    ];
    vi.useFakeTimers();
    try {
      await import('./main');
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(mocks.resource.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.resource.release).toHaveBeenCalledOnce();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('update-recovery mode'),
      );
      expect(mocks.logger.fatal).not.toHaveBeenCalled();
    } finally {
      closed.resolve();
      vi.useRealTimers();
    }
  });

  it('preserves the first lock-release failure during normal shutdown', async () => {
    await launch();
    const failure = new Error('Cannot unlink the agent lock');
    mocks.resource.release.mockRejectedValueOnce(failure);
    const shutdown = mocks.shutdowns.at(-1);
    expect(shutdown).toBeDefined();
    await expect(shutdown?.cleanup()).rejects.toThrow(
      'Could not release the bot-directory lock',
    );
    expect(mocks.resource.release).toHaveBeenCalledOnce();
    expect(mocks.logger[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it('preserves the first tracing-close failure during normal shutdown', async () => {
    const failure = new Error('Tracing shutdown failed');
    const close = vi.fn(async () => undefined).mockRejectedValueOnce(failure);
    mocks.createTracing.mockReturnValue({ ...mocks.resource, close });
    await launch();
    const shutdown = mocks.shutdowns.at(-1);
    expect(shutdown).toBeDefined();
    await expect(shutdown?.cleanup()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.resource.release).toHaveBeenCalledOnce();
    expect(mocks.logger[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it.each(['lock', 'tracing'] as const)(
    'waits for a slow %s cleanup without recording a rollback timeout',
    async (resource) => {
      const closed = Promise.withResolvers<void>();
      const close = vi.fn(() => closed.promise);
      if (resource === 'tracing') {
        mocks.createTracing.mockReturnValue({ ...mocks.resource, close });
      }
      await launch();
      if (resource === 'lock')
        mocks.resource.release.mockImplementationOnce(close);
      const shutdown = mocks.shutdowns.at(-1);
      if (!shutdown) throw new Error('No shutdown coordinator was captured');
      vi.useFakeTimers();
      let settled = false;
      const cleanup = shutdown.cleanup().finally(() => {
        settled = true;
      });
      const completed = expect(cleanup).resolves.toBeUndefined();
      try {
        await vi.advanceTimersByTimeAsync(6_000);
        expect(close).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger[Symbol.asyncDispose]).not.toHaveBeenCalled();
        closed.resolve();
        await completed;
        expect(close).toHaveBeenCalledOnce();
        expect(mocks.logger[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      } finally {
        closed.resolve();
        vi.useRealTimers();
        await completed;
      }
    },
  );

  it('wires a lazy soul reader for the selected agent into learning', async () => {
    await launch();
    const options = mocks.createLearningExt.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(mocks.readSoul).not.toHaveBeenCalled();
    expect(options?.getSoul()).toBe('Current soul');
    expect(mocks.readSoul).toHaveBeenCalledWith(
      join(mocks.selectedDirectory, 'extensions', 'io.stagewise/soul'),
    );
  });

  it.each([false, true])(
    'creates and enrolls a cloud agent without the picker, headless=%s',
    async (headless) => {
      await launch([
        '--create-bot',
        '--cloud',
        '--cloud-enroll-token',
        'test-token',
        ...(headless ? ['--headless', '--auto-update'] : []),
      ]);
      await vi.waitFor(() =>
        expect(mocks.createAgent).toHaveBeenCalledExactlyOnceWith(undefined),
      );
      await vi.waitFor(() =>
        expect(mocks.resource.setTunnelRequestHandler).toHaveBeenCalled(),
      );
      expect(mocks.createAgentPicker).not.toHaveBeenCalled();
      expect(mocks.createCloudConnectivity).toHaveBeenCalledWith(
        expect.objectContaining({
          dataDirectory: mocks.selectedDirectory,
          enrollmentToken: 'test-token',
          cloudEnabled: true,
        }),
      );
      expect(mocks.resource.acquire).toHaveBeenCalledOnce();
      expect(mocks.createConfig).toHaveBeenCalled();
      const restart = requestRestart();
      expect(restart.arguments).not.toContain('--create-bot');
      vi.stubEnv('KLEX_DATA_DIR', restart.environment.KLEX_DATA_DIR);
      vi.resetModules();
      vi.clearAllMocks();
      await launch([...restart.arguments]);
      expect(mocks.createAgent).not.toHaveBeenCalled();
      expect(mocks.createAgentPicker).not.toHaveBeenCalled();
    },
  );

  it.each(['enrolled', 'failed', 'aborted'] as const)(
    'shows the startup handoff only for successful token enrollment: %s',
    async (outcome) => {
      mocks.createCloudConnectivity.mockImplementationOnce(
        (options: {
          onTokenEnrollment: () => { finish(outcome: string): void };
        }) => {
          options.onTokenEnrollment().finish(outcome);
          return mocks.resource;
        },
      );
      await launch([
        '--create-bot',
        '--cloud',
        '--cloud-enroll-token',
        'test-token',
      ]);
      await vi.waitFor(() => expect(mocks.createCliUi).toHaveBeenCalled());
      expect(mocks.createCliUi).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudEnrollmentCompleted: outcome === 'enrolled',
        }),
      );
    },
  );

  it('shows the startup handoff after picker enrollment', async () => {
    mocks.createCloudConnectivity.mockReturnValueOnce({
      ...mocks.resource,
      isEnrolled: () => false,
      enroll: vi.fn().mockResolvedValue(undefined),
    });
    mocks.createAgentPicker.mockImplementationOnce(
      (options: {
        prepareAgent(directory: string): Promise<boolean>;
        enrollCloud(directory: string, token: string): Promise<void>;
      }) => ({
        choose: async () => {
          await options.prepareAgent(mocks.selectedDirectory);
          await options.enrollCloud(mocks.selectedDirectory, 'test-token');
          return mocks.selectedDirectory;
        },
      }),
    );
    await launch(['--cloud']);
    await vi.waitFor(() => expect(mocks.createCliUi).toHaveBeenCalled());
    expect(mocks.createCliUi).toHaveBeenCalledWith(
      expect.objectContaining({ cloudEnrollmentCompleted: true }),
    );
  });

  it('creates a named local agent without the picker', async () => {
    await launch(['--create-bot', '--no-cloud', '--bot-name', 'Ada']);
    await vi.waitFor(() => expect(mocks.createCliUi).toHaveBeenCalled());
    expect(mocks.createCliUi).toHaveBeenCalledWith(
      expect.objectContaining({ cloudEnrollmentCompleted: false }),
    );
    expect(mocks.createAgent).toHaveBeenCalledExactlyOnceWith('Ada');
    expect(mocks.createAgentPicker).not.toHaveBeenCalled();
    expect(requestRestart().arguments).toEqual(['--no-cloud']);
  });

  it('carries the picker selection only in the restart environment', async () => {
    await launch(['--verbose']);
    expect(mocks.createAgentPicker).toHaveBeenCalledOnce();
    expect(mocks.ensureDataDirectory).toHaveBeenCalledWith(
      mocks.selectedDirectory,
    );
    expect(mocks.createCliUi).toHaveBeenCalledWith(
      expect.objectContaining({ dataDirectory: mocks.selectedDirectory }),
    );
    const parentEnvironment = { ...process.env };
    const restart = requestRestart();
    expect(restart).toEqual({
      arguments: ['--verbose'],
      cwd: process.cwd(),
      environment: {
        ...parentEnvironment,
        KLEX_DATA_DIR: resolve(mocks.selectedDirectory),
      },
      launcher: '/managed/updated/klex',
    });
    expect(process.env).toEqual(parentEnvironment);

    vi.stubEnv('KLEX_DATA_DIR', restart.environment.KLEX_DATA_DIR);
    vi.resetModules();
    vi.clearAllMocks();
    await launch([...restart.arguments]);
    expect(mocks.createAgentPicker).not.toHaveBeenCalled();
    expect(mocks.createCliUi).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDirectory: resolve(mocks.selectedDirectory),
      }),
    );

    vi.stubEnv('KLEX_DATA_DIR', parentEnvironment.KLEX_DATA_DIR);
    vi.resetModules();
    vi.clearAllMocks();
    await launch();
    expect(mocks.createAgentPicker).toHaveBeenCalledOnce();
  });

  it.each([
    { arguments: [], environmentDirectory: 'env/agent', expected: 'env/agent' },
    {
      arguments: ['--data-dir', 'explicit/agent'],
      environmentDirectory: '',
      expected: 'explicit/agent',
    },
    {
      arguments: ['-d', 'explicit/agent'],
      environmentDirectory: 'env/agent',
      expected: 'explicit/agent',
    },
  ])(
    'preserves explicit selection: $arguments / $environmentDirectory',
    async ({ arguments: arguments_, environmentDirectory, expected }) => {
      vi.stubEnv('KLEX_DATA_DIR', environmentDirectory);
      await launch(arguments_);
      expect(mocks.createAgentPicker).not.toHaveBeenCalled();
      expect(mocks.createCliUi).toHaveBeenCalledWith(
        expect.objectContaining({ dataDirectory: expected }),
      );
      const restart = requestRestart();
      expect(restart.arguments).toEqual(arguments_);
      expect(restart.environment.KLEX_DATA_DIR).toBe(resolve(expected));
      expect(process.env.KLEX_DATA_DIR).toBe(environmentDirectory);

      vi.stubEnv('KLEX_DATA_DIR', restart.environment.KLEX_DATA_DIR);
      vi.resetModules();
      vi.clearAllMocks();
      await launch([...restart.arguments]);
      expect(mocks.createAgentPicker).not.toHaveBeenCalled();
      expect(mocks.createCliUi).toHaveBeenCalledWith(
        expect.objectContaining({
          dataDirectory: arguments_.length === 0 ? resolve(expected) : expected,
        }),
      );
    },
  );
});

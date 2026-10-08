import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartRequest } from '@/shutdown-coordinator';

const mocks = vi.hoisted(() => {
  const resource = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    acquire: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    get: () => ({ officialName: 'Selected agent', timezone: 'UTC' }),
    agentStarted: vi.fn(),
    setDynamicResourceAttributes: vi.fn(),
    setModelCallSink: vi.fn(),
    handle: vi.fn(),
    setTunnelRequestHandler: vi.fn(),
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
    healthServer: {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      markReady: vi.fn(),
      markNotReady: vi.fn(),
    },
    logger,
    selectedDirectory: 'agents/selected agent',
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
  createAgentDirectory: vi.fn(),
  defaultAgentRoot: () => '/unused/agents',
}));
vi.mock('@/agent-picker', () => ({
  createAgentPicker: mocks.createAgentPicker,
}));
vi.mock('@/cli-ui', () => ({ createCliUi: mocks.createCliUi }));
vi.mock('@/cloud-connectivity', () => ({
  createCloudConnectivity: () => mocks.resource,
}));
vi.mock('@/composition/runtime', () => ({
  startRuntime: () => mocks.resource,
}));
vi.mock('@/config', () => ({ createConfig: () => mocks.resource }));
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
  createSoulExt: vi.fn(),
  createSoulExtGod: vi.fn(),
}));
vi.mock('@/session/chat/extensions/time', () => ({
  createTimeExt: vi.fn(),
  createTimeExtGod: vi.fn(),
}));
vi.mock('@/session/chat/extensions/todos', () => ({ createTodosExt: vi.fn() }));
vi.mock('@/session/realtime', () => ({
  createProductionMediaTransportConnector: vi.fn(),
  createRealtime: vi.fn(),
  PRODUCTION_REALTIME_MEDIA_CAPABILITY: {},
}));
vi.mock('@/session/session-host', () => ({ createSessionHost: vi.fn() }));
vi.mock('@/session/chat/utils/system-prompt.md', () => ({ default: '' }));
vi.mock('@/shutdown-coordinator', () => ({
  createShutdownCoordinator: () => ({
    requestExit: vi.fn(),
    requestRestart: mocks.requestRestart,
  }),
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
vi.mock('@/tracing', () => ({ createTracing: () => mocks.resource }));

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
    mocks.createCliUi.mockReturnValue(mocks.resource);
  });

  afterEach(() => {
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
      await vi.waitFor(() => {
        expect(mocks.resource.close).toHaveBeenCalled();
        expect(mocks.healthServer.close).toHaveBeenCalledOnce();
      });
      expect(mocks.logger.fatal).not.toHaveBeenCalled();
      expect(mocks.healthServer.markReady).not.toHaveBeenCalled();
      expect(mocks.createCliUi).not.toHaveBeenCalled();
      expect(mocks.onRestartRequested).toBeUndefined();
      if (prepareAgent) {
        expect(mocks.resource.release).toHaveBeenCalledOnce();
      }
    },
  );

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

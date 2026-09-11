import type { RootLogger } from '@stagewise/logger';

/** Shutdown contract shared by runtime modules and adopted resources. */
export interface ClosableResource {
  close(): Promise<void>;
}

/** Lifecycle contract every composed runtime module satisfies. */
export interface RuntimeResource extends ClosableResource {
  start(): Promise<void>;
}

/** Modules the runtime starts, in dependency-injected form. */
export interface RuntimeStartupModules {
  modelCallLogger: RuntimeResource;
  adminApi: RuntimeResource;
  cloudConnectivity: RuntimeResource;
  router: RuntimeResource;
  /** Absent when no realtime provider is configured. */
  realtime?: RuntimeResource | undefined;
  mcp: RuntimeResource;
  telemetryManager: RuntimeResource;
  godMessages: RuntimeResource;
}

export interface RuntimeStartupStep {
  readonly name: string;
  readonly resource: RuntimeResource;
}

/**
 * Startup order of the runtime modules.
 *
 * The router owns the primary session, installs the MCP Push Notification
 * listener, and grants interaction leases. It therefore starts before the
 * realtime coordinator (which acquires a lease per accepted offer) and before
 * MCP (whose workers publish events as soon as they connect). Starting MCP
 * first would let worker events arrive while no listener is installed, and the
 * pending-queue drain is the only recovery path for that gap.
 *
 * Shutdown uses an explicit dependency order: active realtime sessions stop
 * before MCP, then the router closes the primary session and its extensions.
 */
export function runtimeStartupOrder(
  modules: RuntimeStartupModules,
): readonly RuntimeStartupStep[] {
  return [
    { name: 'model-call-logger', resource: modules.modelCallLogger },
    { name: 'admin-api', resource: modules.adminApi },
    { name: 'cloud-connectivity', resource: modules.cloudConnectivity },
    { name: 'router', resource: modules.router },
    ...(modules.realtime
      ? [{ name: 'realtime', resource: modules.realtime }]
      : []),
    { name: 'mcp', resource: modules.mcp },
    { name: 'telemetry-manager', resource: modules.telemetryManager },
    { name: 'god-messages', resource: modules.godMessages },
  ];
}

export interface RuntimeHandle {
  /**
   * Closes runtime modules in explicit dependency order, then adopted resources
   * in reverse adoption order. Realtime and MCP stop before the router so no
   * external work can reach a closing primary session.
   */
  close(): Promise<void>;
}

export interface StartRuntimeOptions {
  logging: RootLogger;
  /**
   * Resources started before the runtime, in start order. The runtime closes
   * them after its own modules but never on a startup failure — the caller
   * that started them owns that rollback.
   */
  adopted?: readonly ClosableResource[];
  modules: RuntimeStartupModules;
}

/**
 * Starts every runtime module in {@link runtimeStartupOrder}. A failure closes
 * the modules already started, in reverse, and rethrows.
 */
export async function startRuntime(
  options: StartRuntimeOptions,
): Promise<RuntimeHandle> {
  const logger = options.logging.child({
    name: 'composition',
    bindings: { module: 'composition' },
  });
  const started: RuntimeStartupStep[] = [];

  for (const step of runtimeStartupOrder(options.modules)) {
    started.push(step);
    try {
      await step.resource.start();
    } catch (error) {
      logger.error({ error, module: step.name }, 'Runtime startup failed');
      await closeReverse(
        started.map(({ resource }) => resource),
        logger,
      );
      throw error;
    }
  }

  const shutdownResources: ClosableResource[] = [
    ...runtimeShutdownOrder(started),
    ...(options.adopted ?? []).toReversed(),
  ];
  let closing: Promise<void> | undefined;
  return {
    close: () => (closing ??= closeInOrder(shutdownResources, logger)),
  };
}

function runtimeShutdownOrder(
  started: readonly RuntimeStartupStep[],
): readonly RuntimeResource[] {
  const byName = new Map(started.map((step) => [step.name, step.resource]));
  return [
    'god-messages',
    'telemetry-manager',
    'realtime',
    'mcp',
    'router',
    'cloud-connectivity',
    'admin-api',
    'model-call-logger',
  ].flatMap((name) => {
    const resource = byName.get(name);
    return resource ? [resource] : [];
  });
}

async function closeReverse(
  resources: readonly ClosableResource[],
  logger: Pick<RootLogger, 'error'>,
): Promise<void> {
  await closeInOrder(resources.toReversed(), logger);
}

async function closeInOrder(
  resources: readonly ClosableResource[],
  logger: Pick<RootLogger, 'error'>,
): Promise<void> {
  for (const resource of resources) {
    await resource.close().catch((error: unknown) => {
      logger.error({ error }, 'Resource shutdown failed');
    });
  }
}

import { resolve } from 'node:path';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Application } from '@/application';
import type { CliOptions } from '@/cli';
import { createHealthServer, type HealthServer } from '@/health-server';
import { KLEX_VERSION, resolveReleaseTarget } from '@/release';
import {
  discoverManagedInstallation,
  type ManagedInstallation,
  UpdateManager,
  type UpdateManagerOptions,
} from '@/self-update';
import {
  createShutdownCoordinator,
  type ShutdownCoordinator,
  type ShutdownCoordinatorOptions,
} from '@/shutdown-coordinator';

const CHECK_INTERVAL_MS = 5 * 60_000;
const RETRY_MIN_MS = 30_000;

export interface UpdateBootstrapDependencies {
  logging: RootLogger;
  cli: CliOptions;
  loadApplication: (
    updateManager: UpdateManager | undefined,
    healthServer: HealthServer | undefined,
  ) => Promise<Application>;
  discoverInstallation?: typeof discoverManagedInstallation;
  createUpdateManager?: (options: UpdateManagerOptions) => UpdateManager;
  exit?: (code: number) => void;
  restartProcess?: ShutdownCoordinatorOptions['restartProcess'];
  disposeLogging: () => Promise<void>;
  onStartupFailure: () => void;
}

export interface UpdateBootstrap {
  start(): Promise<void>;
  close(): Promise<void>;
}

class UpdateBootstrapModule implements UpdateBootstrap {
  private application: Application | undefined;
  private manager: UpdateManager | undefined;
  private healthServer: HealthServer | undefined;
  private shutdown: ShutdownCoordinator | undefined;
  private phase:
    | 'starting'
    | 'running'
    | 'recovering'
    | 'restarting'
    | 'stopped' = 'starting';
  private timer: NodeJS.Timeout | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private retryDelay = RETRY_MIN_MS;

  constructor(
    private readonly deps: UpdateBootstrapDependencies & {
      logger: ModuleLogger;
    },
  ) {}

  start(): Promise<void> {
    this.starting ??= this.run().catch(async (error: unknown) => {
      await this.close();
      throw error;
    });
    return this.starting;
  }

  close(): Promise<void> {
    if (!this.starting) return Promise.resolve();
    this.closing ??= this.cleanup();
    return this.closing;
  }

  private readonly requestExit = () => {
    if (this.phase === 'running') this.application?.requestExit();
    else this.shutdown?.requestExit();
  };

  private readonly requestTermination = () => {
    if (this.phase === 'running') this.application?.requestTermination();
    else this.shutdown?.requestExit();
  };

  private async run(): Promise<void> {
    this.shutdown = createShutdownCoordinator({
      closeUi: () => {},
      cleanup: async () => {
        await this.close();
        await this.deps.disposeLogging();
      },
      exit: this.deps.exit ?? ((code) => process.exit(code)),
      restartProcess: this.deps.restartProcess,
      onRestartError: (error) =>
        this.deps.logger.error({ error }, 'Update restart failed'),
    });
    process.on('SIGINT', this.requestExit);
    process.on('SIGTERM', this.requestTermination);
    process.on('SIGHUP', this.requestExit);

    if (this.deps.cli.autoUpdate) {
      const installation = await (
        this.deps.discoverInstallation ?? discoverManagedInstallation
      )({
        executablePath: process.execPath,
        platform: process.platform,
        target: resolveReleaseTarget().target,
        version: KLEX_VERSION,
        onDiagnostic: (error) =>
          this.deps.logger.debug(
            { error },
            'Self-update is unavailable for this installation',
          ),
      });
      if (this.phase !== 'starting') return;
      if (installation) {
        const options: UpdateManagerOptions = {
          installation,
          onRestartRequested: (updated) => this.requestRestart(updated),
        };
        this.manager =
          this.deps.createUpdateManager?.(options) ??
          new UpdateManager(options);
        // No background subscription: await both discovery and installation before
        // importing the agent runtime or opening its durable data.
        await this.checkAndInstall();
        if (this.phase !== 'starting') return;
      } else {
        this.deps.logger.warn(
          'Auto-update was requested but this is not a managed installation; continuing without updates',
        );
      }
    }

    try {
      // Liveness belongs to the process, not the agent. Keep /livez available
      // and /readyz false while a broken agent waits for a healing release.
      if (this.deps.cli.healthPort !== undefined) {
        this.healthServer = createHealthServer({
          logging: this.deps.logging,
          port: this.deps.cli.healthPort,
          host: this.deps.cli.healthHost,
        });
        await this.healthServer.start();
      }
      this.application = await this.deps.loadApplication(
        this.manager,
        this.healthServer,
      );
      if (this.phase !== 'starting') {
        await this.application.close();
        return;
      }
      const running = await this.application.start();
      if (this.phase !== 'starting') return;
      if (!running) {
        await this.close();
        await this.deps.disposeLogging();
        return;
      }
      this.phase = 'running';
    } catch (error) {
      if (this.phase !== 'starting') return;
      // Interactive logging is normally hidden behind Ink. There is no UI in
      // recovery, so expose the original startup failure and all update logs.
      this.healthServer?.markNotReady();
      this.deps.onStartupFailure();
      this.deps.logger.error({ error }, 'Agent startup failed');
      await this.application?.close();
      if (this.phase !== 'starting') return;
      if (!this.manager) {
        await this.close();
        throw error;
      }
      this.phase = 'recovering';
      this.deps.logger.warn(
        'Agent is unhealthy; waiting for a healing update (update-recovery mode)',
      );
    }
    this.scheduleCheck();
  }

  private requestRestart(
    installation: ManagedInstallation,
  ): Promise<void> | void {
    if (this.phase === 'stopped' || this.phase === 'restarting') return;
    if (this.phase === 'running') {
      return this.application?.requestRestart(installation);
    }
    this.phase = 'restarting';
    this.shutdown?.requestRestart({
      arguments: process.argv.slice(2),
      cwd: process.cwd(),
      environment: {
        ...process.env,
        ...(this.deps.cli.dataDirectory === undefined
          ? {}
          : { KLEX_DATA_DIR: resolve(this.deps.cli.dataDirectory) }),
      },
      launcher: installation.currentExecutable,
    });
  }

  private async checkAndInstall(): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    await manager.check(); // UpdateManager aborts network checks after 10 seconds.
    if (this.phase === 'stopped' || this.phase === 'restarting') return;
    if (manager.getState().status === 'available') {
      this.deps.logger.info('Installing update before the next agent restart');
      await manager.install();
    }
    const state = manager.getState();
    if (state.status === 'idle') {
      this.deps.logger.warn(
        'Automatic update check did not complete; retrying later',
      );
    }
    if (state.status === 'failed') {
      this.deps.logger.warn(
        { error: state.message, version: state.version },
        'Automatic update failed; retrying later',
      );
    }
    this.retryDelay =
      state.status === 'up-to-date'
        ? CHECK_INTERVAL_MS
        : Math.min(this.retryDelay * 2, CHECK_INTERVAL_MS);
  }

  private scheduleCheck(): void {
    if (
      !this.manager ||
      (this.phase !== 'running' && this.phase !== 'recovering')
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.checkAndInstall()
          .catch((error: unknown) => {
            this.deps.logger.error({ error }, 'Automatic update check failed');
          })
          .finally(() => this.scheduleCheck());
      },
      this.phase === 'running' ? CHECK_INTERVAL_MS : this.retryDelay,
    );
    // Recovery must keep an otherwise idle process alive. A healthy runtime owns
    // its own handles; its update timer must not prevent a normal exit.
    if (this.phase === 'running') this.timer.unref();
  }

  private async cleanup(): Promise<void> {
    this.phase = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    process.off('SIGINT', this.requestExit);
    process.off('SIGTERM', this.requestTermination);
    process.off('SIGHUP', this.requestExit);
    const restarting = this.manager?.getState().status === 'restarting';
    this.manager?.stop();
    if (!restarting) await this.manager?.cancelInstall();
    await this.application?.close();
    await this.healthServer?.close();
  }
}

export function createUpdateBootstrap(
  deps: UpdateBootstrapDependencies,
): UpdateBootstrap {
  return new UpdateBootstrapModule({
    ...deps,
    logger: deps.logging.child({
      name: 'update-bootstrap',
      bindings: { module: 'update-bootstrap' },
    }),
  });
}

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Drain, DrainOutcome } from '@/drain';
import type { UpdateManager, UpdateState } from '@/self-update';

/** Busy time after which a drain gives up and the restart proceeds anyway. */
export const AUTO_UPDATE_DRAIN_TIMEOUT_MS = 10 * 60_000;

export interface AutoUpdateDependencies {
  logging: RootLogger;
  updateManager: Pick<UpdateManager, 'getState' | 'subscribe' | 'install'>;
  drain: Pick<Drain, 'drain'>;
  /** Busy time budget. Time spent in a realtime call does not count. */
  drainTimeoutMs?: number;
}

export interface AutoUpdate {
  /** Installs every offered update in the background. Idempotent. */
  start(): void;
  /** Stops reacting to update offers. Does not abort a running drain. */
  close(): void;
  /**
   * Drains the agent with the update budget. Call right before the restart.
   * Repeated calls share one drain.
   */
  drainForRestart(): Promise<DrainOutcome>;
}

interface AutoUpdateModuleDependencies
  extends Omit<AutoUpdateDependencies, 'logging'> {
  logger: ModuleLogger;
}

class AutoUpdateModule implements AutoUpdate {
  private unsubscribe: (() => void) | undefined;
  private drainPromise: Promise<DrainOutcome> | undefined;

  constructor(private readonly deps: AutoUpdateModuleDependencies) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.updateManager.subscribe((state) =>
      this.handleState(state),
    );
    this.handleState(this.deps.updateManager.getState());
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  drainForRestart(): Promise<DrainOutcome> {
    this.drainPromise ??= this.deps.drain.drain({
      reason: 'update',
      timeoutMs: this.deps.drainTimeoutMs ?? AUTO_UPDATE_DRAIN_TIMEOUT_MS,
      // No outside deadline: a live call may finish before the restart.
      pauseWhileLeased: true,
    });
    return this.drainPromise;
  }

  private handleState(state: UpdateState): void {
    // A failed install is retried when the next periodic check re-offers
    // the release, so only `available` triggers an install.
    if (state.status !== 'available') return;
    this.deps.logger.info(
      { event: 'auto_update.install_started', version: state.version },
      'Installing update automatically',
    );
    void this.deps.updateManager.install();
  }
}

export function createAutoUpdate(deps: AutoUpdateDependencies): AutoUpdate {
  const { logging, ...rest } = deps;
  return new AutoUpdateModule({
    ...rest,
    logger: logging.child({
      name: 'auto-update',
      bindings: { module: 'auto-update' },
    }),
  });
}

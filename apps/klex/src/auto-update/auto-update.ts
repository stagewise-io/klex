import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';
import type { UpdateManager, UpdateState } from '@/self-update';
import type { SessionHost } from '@/session/session-host';

/** Busy time after which a drain gives up and the restart proceeds anyway. */
export const AUTO_UPDATE_DRAIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const ACK_FLUSH_TIMEOUT_MS = 5_000;

export type DrainOutcome = 'drained' | 'timed-out';

export interface AutoUpdateDependencies {
  logging: RootLogger;
  updateManager: Pick<UpdateManager, 'getState' | 'subscribe' | 'install'>;
  sessionHost: Pick<
    SessionHost,
    'isQuiescent' | 'isInteractionLeased' | 'beginDrain'
  >;
  mcp: Pick<Mcp, 'pausePushDelivery' | 'acknowledgeDeliveredEvents'>;
  /** Busy time budget. Time spent in a realtime call does not count. */
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AutoUpdate {
  /** Installs every offered update in the background. Idempotent. */
  start(): void;
  /** Stops reacting to update offers. Does not abort a running drain. */
  close(): void;
  /**
   * Stops new work, waits until the agent is quiescent (or the busy budget
   * is spent), then acknowledges handled Push Notifications. Call right before
   * the restart. Repeated calls share one drain.
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
    this.drainPromise ??= this.drain();
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

  private async drain(): Promise<DrainOutcome> {
    const timeoutMs = this.deps.drainTimeoutMs ?? AUTO_UPDATE_DRAIN_TIMEOUT_MS;
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    this.deps.sessionHost.beginDrain();
    this.deps.mcp.pausePushDelivery();
    this.deps.logger.info(
      { event: 'auto_update.drain_started', timeoutMs },
      'Draining agent before update restart',
    );

    let busyMs = 0;
    let leasedMs = 0;
    let outcome: DrainOutcome;
    for (;;) {
      if (this.deps.sessionHost.isQuiescent()) {
        // Quiescence and the ACK snapshot happen in the same tick.
        await this.flushAcknowledgements();
        outcome = 'drained';
        break;
      }
      if (busyMs >= timeoutMs) {
        // Unfinished events stay unacknowledged and are redelivered.
        outcome = 'timed-out';
        break;
      }
      const sliceStart = Date.now();
      await sleep(pollIntervalMs);
      const elapsed = Date.now() - sliceStart;
      // A live realtime call pauses the deadline clock.
      if (this.deps.sessionHost.isInteractionLeased()) leasedMs += elapsed;
      else busyMs += elapsed;
    }

    this.deps.logger.info(
      {
        event: 'auto_update.drain_finished',
        outcome,
        durationMs: Date.now() - startedAt,
        leasedMs,
      },
      'Agent drain finished',
    );
    return outcome;
  }

  private async flushAcknowledgements(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ACK_FLUSH_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        this.deps.mcp.acknowledgeDeliveredEvents(),
        timeout,
      ]);
      if (result === 'timeout') {
        this.deps.logger.warn(
          { timeoutMs: ACK_FLUSH_TIMEOUT_MS },
          'Push Notification acknowledgement timed out before restart',
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'Push Notification acknowledgement failed before restart',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

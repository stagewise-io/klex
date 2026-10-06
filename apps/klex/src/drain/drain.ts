import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { GodMessages } from '@/god-messages';
import type { Mcp } from '@/mcp';
import type { SessionHost } from '@/session/session-host';

/** Default wall-clock budget for a drain triggered by SIGTERM. */
export const DEFAULT_TERMINATION_DRAIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const ACK_FLUSH_TIMEOUT_MS = 5_000;

export type DrainOutcome = 'drained' | 'timed-out';
export type DrainReason = 'update' | 'termination';

export interface DrainRequest {
  reason: DrainReason;
  /** Budget after which the wait gives up. Unfinished events stay unacknowledged. */
  timeoutMs: number;
  /**
   * When true, time spent in a live realtime call does not count toward the
   * budget. Use only when nothing outside the process enforces a deadline.
   */
  pauseWhileLeased: boolean;
}

export interface DrainDependencies {
  logging: RootLogger;
  sessionHost: Pick<
    SessionHost,
    'isQuiescent' | 'isInteractionLeased' | 'beginDrain'
  >;
  /** Separate god session; drained alongside the default session tree. */
  godMessages: Pick<GodMessages, 'isQuiescent' | 'beginDrain'>;
  mcp: Pick<Mcp, 'pausePushDelivery' | 'acknowledgeDeliveredEvents'>;
  pollIntervalMs?: number;
}

export interface Drain {
  /**
   * Stops new work for the rest of the process, waits until the agent is
   * quiescent or the request's budget is spent, and acknowledges handled Push
   * Notifications once quiescent. Stopping new work is irreversible and happens
   * once; concurrent requests each wait with their own budget and share the
   * acknowledgement flush.
   */
  drain(request: DrainRequest): Promise<DrainOutcome>;
}

interface DrainModuleDependencies extends Omit<DrainDependencies, 'logging'> {
  logger: ModuleLogger;
}

class DrainModule implements Drain {
  private begun = false;
  private ackFlush: Promise<void> | undefined;

  constructor(private readonly deps: DrainModuleDependencies) {}

  async drain(request: DrainRequest): Promise<DrainOutcome> {
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    this.begin();
    this.deps.logger.info(
      {
        event: 'drain.started',
        reason: request.reason,
        timeoutMs: request.timeoutMs,
        pauseWhileLeased: request.pauseWhileLeased,
      },
      'Draining agent',
    );

    let budgetMs = 0;
    let leasedMs = 0;
    let outcome: DrainOutcome;
    for (;;) {
      if (this.isQuiescent()) {
        // Quiescence and the ACK snapshot happen in the same tick.
        this.ackFlush ??= this.flushAcknowledgements();
        await this.ackFlush;
        outcome = 'drained';
        break;
      }
      if (budgetMs >= request.timeoutMs) {
        // Unfinished events stay unacknowledged and are redelivered.
        outcome = 'timed-out';
        break;
      }
      const sliceStart = Date.now();
      await sleep(Math.min(pollIntervalMs, request.timeoutMs - budgetMs));
      const elapsed = Date.now() - sliceStart;
      if (
        request.pauseWhileLeased &&
        this.deps.sessionHost.isInteractionLeased()
      ) {
        leasedMs += elapsed;
      } else {
        budgetMs += elapsed;
      }
    }

    this.deps.logger.info(
      {
        event: 'drain.finished',
        reason: request.reason,
        outcome,
        durationMs: Date.now() - startedAt,
        leasedMs,
      },
      'Agent drain finished',
    );
    return outcome;
  }

  private begin(): void {
    if (this.begun) return;
    this.begun = true;
    this.deps.sessionHost.beginDrain();
    this.deps.godMessages.beginDrain();
    this.deps.mcp.pausePushDelivery();
  }

  private isQuiescent(): boolean {
    return (
      this.deps.sessionHost.isQuiescent() && this.deps.godMessages.isQuiescent()
    );
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
          'Push Notification acknowledgement timed out after drain',
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'Push Notification acknowledgement failed after drain',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDrain(deps: DrainDependencies): Drain {
  const { logging, ...rest } = deps;
  return new DrainModule({
    ...rest,
    logger: logging.child({
      name: 'drain',
      bindings: { module: 'drain' },
    }),
  });
}

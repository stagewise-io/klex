import type { Span } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

/**
 * Default schedule parameters.
 *
 * Backoff starts from the first failure — no immediate retries. The delay
 * doubles each failure starting from {@link DEFAULT_BASE_DELAY_MS}, capped
 * at {@link DEFAULT_MAX_DELAY_MS}.
 */
const DEFAULT_IMMEDIATE_RETRIES = 0;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * Tracks consecutive generation failures and computes an exponential
 * backoff delay.
 *
 * The first {@link immediateRetries} failures produce a delay of 0 (immediate
 * retry). After that, the delay doubles with each subsequent failure, capped
 * at {@link maxDelayMs}.
 *
 * Schedule with defaults (base 2 s, cap 60 s, 0 immediate):
 *
 * | Failure # | Delay  |
 * |-----------|--------|
 * | 1         | 2 s    |
 * | 2         | 4 s    |
 * | 3         | 8 s    |
 * | 4         | 16 s   |
 * | 5         | 32 s   |
 * | 6+        | 60 s   |
 *
 * A call to {@link recordSuccess} resets the failure counter to 0.
 */
export class BackoffManager {
  private consecutiveFailures = 0;
  private readonly immediateRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      span: Span;
      sessionId: string;
    },
    options: {
      immediateRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    } = {},
  ) {
    this.immediateRetries =
      options.immediateRetries ?? DEFAULT_IMMEDIATE_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /** Increments the consecutive failure counter. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.deps.span.addEvent('session.backoff_failure', {
      'session.consecutiveFailures': this.consecutiveFailures,
    });
  }

  /** Resets the consecutive failure counter to 0. */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.deps.span.addEvent('session.backoff_reset', {
        'session.previousFailures': this.consecutiveFailures,
      });
    }
    this.consecutiveFailures = 0;
  }

  /** Returns the current consecutive failure count. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns the delay in milliseconds to wait before the next retry.
   *
   * 0 for the first {@link immediateRetries} failures, then exponential
   * growth: `baseDelayMs * 2^(failures - immediateRetries - 1)`, capped at
   * `maxDelayMs`.
   */
  getDelay(): number {
    if (this.consecutiveFailures <= this.immediateRetries) {
      return 0;
    }
    const exponent = this.consecutiveFailures - this.immediateRetries - 1;
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }
}

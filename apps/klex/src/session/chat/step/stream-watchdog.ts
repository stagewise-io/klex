import { GenerationStallError } from '@/utils/llm';

import type { StreamProgress } from '../utils/run-streamed-generation';
import type { StreamDeadlines } from './stream-deadlines';

/**
 * Aborts one generation attempt that makes no usable progress: first within
 * `firstOutputMs` of the start (covering the header wait), then within
 * `idleMs` of the previous usable output. Only usable output resets it, so
 * a stream that keeps producing output is never cut off.
 */
export class StreamWatchdog {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private responseAt: number | undefined;
  private firstOutputAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stallError: GenerationStallError | undefined;

  constructor(private readonly deadlines: StreamDeadlines) {
    this.arm(deadlines.firstOutputMs);
  }

  /** Aborted with a {@link GenerationStallError} when the attempt stalls. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stall(): GenerationStallError | undefined {
    return this.stallError;
  }

  /** Milliseconds from the start until the provider began streaming. */
  get timeToResponseMs(): number | undefined {
    return this.responseAt === undefined
      ? undefined
      : this.responseAt - this.startedAt;
  }

  /** Milliseconds from the start until the first usable output. */
  get timeToFirstOutputMs(): number | undefined {
    return this.firstOutputAt === undefined
      ? undefined
      : this.firstOutputAt - this.startedAt;
  }

  /** Returns true for the first usable output of the attempt. */
  record(progress: StreamProgress): boolean {
    if (this.stallError !== undefined || this.timer === undefined) return false;
    const now = Date.now();
    if (progress === 'response') {
      this.responseAt ??= now;
      return false;
    }
    const first = this.firstOutputAt === undefined;
    this.firstOutputAt ??= now;
    this.arm(this.deadlines.idleMs);
    return first;
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(budgetMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const stage =
        this.firstOutputAt !== undefined
          ? 'idle'
          : this.responseAt !== undefined
            ? 'first-output'
            : 'response';
      this.stallError = new GenerationStallError(
        stage,
        Date.now() - this.startedAt,
        budgetMs,
      );
      this.controller.abort(this.stallError);
    }, budgetMs);
  }
}

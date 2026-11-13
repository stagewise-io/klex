/**
 * Where a streamed generation stalled:
 * - `response`: the provider never started streaming (e.g. a header stall).
 * - `first-output`: it streamed, but produced no usable output.
 * - `idle`: usable output stopped arriving.
 */
export type GenerationStallStage = 'response' | 'first-output' | 'idle';

/**
 * A generation made no usable progress within its deadline. Raised by the
 * stream watchdog, never by a caller cancellation, so it is a model error
 * that falls back rather than an abort.
 */
export class GenerationStallError extends Error {
  override readonly name = 'GenerationStallError';

  constructor(
    readonly stage: GenerationStallStage,
    readonly elapsedMs: number,
    readonly budgetMs: number,
  ) {
    super(
      `Generation stalled (${stage}): no usable progress for ${budgetMs}ms, ${elapsedMs}ms after the request started.`,
    );
  }
}

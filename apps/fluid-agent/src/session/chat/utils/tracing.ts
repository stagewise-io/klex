import {
  context,
  type Span,
  type SpanOptions,
  trace,
} from '@opentelemetry/api';

/**
 * Shared tracer for the chat module. All spans in the session → turn → step
 * hierarchy are created through this tracer.
 *
 * Use {@link startChildSpan} inside a `context.with` block to create spans
 * that nest under the ambient context. Use `tracer.startSpan` directly only
 * in constructors, where the parent context must be passed explicitly (no
 * ambient context exists yet).
 */
export const tracer = trace.getTracer('fluid-agent');

/**
 * Starts a child span under the currently active OTel context.
 *
 * This is the idiomatic way to create spans inside a `context.with` block:
 * the `context.with` establishes the parent span as ambient, and
 * `startChildSpan` nests under it automatically. Callers must ensure they
 * are inside a `context.with` block — otherwise the span will have no parent.
 *
 * @example
 * ```ts
 * async run() {
 *   try {
 *     return await context.with(this.stepContext, async () => {
 *       const span = startChildSpan('step.decision', { attributes: { ... } });
 *       // ... work ...
 *       span.end();
 *     });
 *   } finally {
 *     this.stepSpan.end();
 *   }
 * }
 * ```
 */
export function startChildSpan(name: string, options?: SpanOptions): Span {
  return tracer.startSpan(name, options, context.active());
}

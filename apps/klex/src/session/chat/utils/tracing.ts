import {
  type Context,
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
export const tracer = trace.getTracer('klex');

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

// ---------------------------------------------------------------------------
// Extension context key
// ---------------------------------------------------------------------------

/**
 * OTel context key carrying the identifier of the extension that initiated
 * the current generation call. Set by the extension handler's `generateText`
 * wrapper and read by `ChatSessionModule.generateTextForExtension` to set
 * `gen_ai.agent.name` as `extension:{identifier}` on the trace span.
 *
 * Uses a symbol so the key is collision-proof across modules.
 */
const extensionIdentifierKey = Symbol('extensionIdentifier');

/**
 * Returns a context with the given extension identifier set.
 * Pass the result to `context.with(ctx, fn)` so code running inside can
 * read it via {@link getExtensionIdentifier}.
 */
export function withExtensionIdentifier(
  ctx: Context,
  identifier: string,
): Context {
  return ctx.setValue(extensionIdentifierKey, identifier);
}

/**
 * Reads the extension identifier from the given (or active) context.
 * Returns `undefined` when no extension identifier is set — e.g. when the
 * call was not initiated by an extension.
 */
export function getExtensionIdentifier(
  ctx: Context = context.active(),
): string | undefined {
  return ctx.getValue(extensionIdentifierKey) as string | undefined;
}

import { type Context, context } from '@opentelemetry/api';

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

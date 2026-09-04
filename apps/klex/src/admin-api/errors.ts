/**
 * Shared error shaping for the admin API.
 *
 * Every error response carries a machine-readable `code` next to the human
 * `error` message, so clients can branch without matching on prose. The test
 * apps use the same handler as the real server — a divergence here would let
 * route tests assert a shape production never emits.
 */
import type { Hook } from '@hono/zod-openapi';
import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Hono's own body validator raises this before our handlers run, with no cause
 * to key on, so the message is the only available signal.
 */
const MALFORMED_JSON_MESSAGE = 'Malformed JSON in request body';

/**
 * Formats Zod validation failures as `{ error, code }` with 400.
 */
// biome-ignore lint/suspicious/noExplicitAny: Hook generic parameters are opaque validation types
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((i) =>
        i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
      )
      .join('; ');
    return c.json({ error: message, code: 'validation_failed' }, 400);
  }
};

/**
 * Builds the admin API `onError` handler.
 *
 * @param onUnhandled - Invoked for errors that are neither HTTP exceptions nor
 *   body parse failures, i.e. the ones worth logging.
 */
// biome-ignore lint/suspicious/noExplicitAny: the handler is shared across differently-typed apps
export function createErrorHandler(
  onUnhandled?: (error: Error) => void,
): ErrorHandler<any> {
  return (err, c) => {
    if (err instanceof HTTPException) {
      if (err.status === 400 && err.message === MALFORMED_JSON_MESSAGE) {
        return c.json({ error: err.message, code: 'malformed_json' }, 400);
      }
      return c.json({ error: err.message, code: 'http_error' }, err.status);
    }
    if (err instanceof SyntaxError) {
      return c.json(
        { error: MALFORMED_JSON_MESSAGE, code: 'malformed_json' },
        400,
      );
    }
    onUnhandled?.(err);
    return c.json(
      { error: 'Internal server error', code: 'internal_error' },
      500,
    );
  };
}

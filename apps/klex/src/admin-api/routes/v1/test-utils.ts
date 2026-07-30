import { type Hook, OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

/**
 * Shared validation hook for test apps.
 * Formats Zod validation errors as `{ error: string }` with 400 status.
 */
// biome-ignore lint/suspicious/noExplicitAny: Hook generic parameters are opaque validation types
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((i) =>
        i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
      )
      .join('; ');
    return c.json({ error: message }, 400);
  }
};

/**
 * Creates a test OpenAPIHono app with shared validation hook and error handler.
 * Routes are registered via the provided callback.
 */
export function setupTestApp(
  register: (app: OpenAPIHono) => void,
): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    return c.json({ error: 'Internal server error' }, 500);
  });
  register(app);
  return app;
}

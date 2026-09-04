import { OpenAPIHono } from '@hono/zod-openapi';

import { createErrorHandler, validationHook } from '../../errors';

export { validationHook };

/**
 * Creates a test OpenAPIHono app wired with the same validation hook and error
 * handler as the real admin server, so route tests assert the shapes production
 * emits. Routes are registered via the provided callback.
 */
export function setupTestApp(
  register: (app: OpenAPIHono) => void,
): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.onError(createErrorHandler());
  register(app);
  return app;
}

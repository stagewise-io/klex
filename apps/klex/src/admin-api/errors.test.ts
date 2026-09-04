import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createErrorHandler } from './errors';

describe('createErrorHandler', () => {
  it('does not misclassify domain SyntaxErrors as malformed request JSON', async () => {
    const onUnhandled = vi.fn();
    const app = new Hono();
    app.onError(createErrorHandler(onUnhandled));
    app.get('/failure', () => {
      throw new SyntaxError('invalid domain data');
    });

    const response = await app.request('/failure');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Internal server error',
      code: 'internal_error',
    });
    expect(onUnhandled).toHaveBeenCalledOnce();
    expect(onUnhandled.mock.calls[0]?.[0]).toBeInstanceOf(SyntaxError);
  });
});

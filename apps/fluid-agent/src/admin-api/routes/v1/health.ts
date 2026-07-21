import type { Context } from 'hono';

export function getHealth(c: Context) {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
}

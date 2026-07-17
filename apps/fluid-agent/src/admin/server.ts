import { Hono } from 'hono';
import { getHealth } from './routes/v1/health';

export function createAdminApp(): Hono {
  const app = new Hono();

  app.get('/v1/health', getHealth);

  return app;
}

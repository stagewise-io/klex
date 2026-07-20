import { serve } from '@hono/node-server';
import { createLogger } from '@stagewise/logger';
import { createApp } from './app.js';
import { createChatStore } from './chat-store.js';
import { createChatMcp } from './mcp.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const logger = createLogger({ name: 'chat-simulator' });
const store = createChatStore();
const mcp = createChatMcp(store);
const server = serve(
  { fetch: createApp(store, mcp).fetch, port },
  (address) => {
    logger.info(`Chat simulator listening on http://localhost:${address.port}`);
  },
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down`);
  server.close();
  store.close();
  await mcp.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

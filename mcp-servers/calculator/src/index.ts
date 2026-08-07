import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';

import { createLogger, type LogLevel } from '@stagewise/logger';

import { createCalculatorMcp } from './mcp.js';

const PORT = Number(process.env.PORT ?? 3125);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO') as LogLevel;

const logger = createLogger({ name: 'calculator', minLevel: LOG_LEVEL });

const mcp = createCalculatorMcp();

const app = createMcpHonoApp();
app.get('/health', (c) => c.json({ status: 'ok' }));
app.all('/mcp', (c) => mcp.fetch(c.req.raw));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, 'Calculator MCP server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down calculator MCP server');
  server.close();
  await mcp.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

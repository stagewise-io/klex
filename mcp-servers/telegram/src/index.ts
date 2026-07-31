import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { createLogger, type LogLevel } from '@stagewise/logger';

import { createTelegramRuntimeManager } from './runtime-manager/index.js';

const port = parsePort(process.env.PORT ?? '8789');
const logLevel = parseLogLevel(process.env.LOG_LEVEL ?? 'INFO');
const logger = createLogger({
  name: 'telegram',
  minLevel: logLevel,
  mask: {
    keys: [
      'password',
      'apiKey',
      'authorization',
      'token',
      'prompt',
      'x-telegram-bot-token',
      'x-telegram-allowed-user-ids',
    ],
    caseInsensitive: true,
  },
});

const runtimes = createTelegramRuntimeManager({
  logging: logger,
  idleTimeoutMs: parsePositiveInteger(
    process.env.TELEGRAM_RUNTIME_IDLE_TIMEOUT_MS ?? '5000',
    'TELEGRAM_RUNTIME_IDLE_TIMEOUT_MS',
  ),
});

const app = new Hono();
app.get('/health', (context) =>
  context.json({ status: 'ok', ...runtimes.health() }),
);
app.all('/mcp', (context) => runtimes.fetch(context.req.raw));

const server = serve({ fetch: app.fetch, port }, (address) => {
  logger.info({ port: address.port }, 'Telegram MCP server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down Telegram MCP server');
  server.close();
  await runtimes.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

function parsePort(value: string): number {
  const parsed = parsePositiveInteger(value, 'PORT');
  if (parsed > 65_535) throw new Error('Invalid PORT');
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function parseLogLevel(value: string): LogLevel {
  const normalized = value.toUpperCase();
  if (
    !['SILLY', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(
      normalized,
    )
  ) {
    throw new Error(`Invalid LOG_LEVEL: ${value}`);
  }
  return normalized as LogLevel;
}

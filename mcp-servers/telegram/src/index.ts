import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { createLogger, type LogLevel } from '@stagewise/logger';

import { createEventStore } from './event-store.js';
import { createTelegramMcp } from './mcp.js';
import { createTelegramChannel } from './telegram.js';

const port = parsePort(process.env.PORT ?? '8789');
const token = required('TELEGRAM_BOT_TOKEN');
const allowedUserIds = parseUserIds(required('TELEGRAM_ALLOWED_USER_IDS'));
const logLevel = parseLogLevel(process.env.LOG_LEVEL ?? 'INFO');
const logger = createLogger({
  name: 'telegram',
  minLevel: logLevel,
  mask: {
    keys: ['password', 'apiKey', 'authorization', 'token', 'prompt'],
    caseInsensitive: true,
  },
});

const eventStore = createEventStore();
let mcp: ReturnType<typeof createTelegramMcp> | undefined;
const channel = createTelegramChannel({
  token,
  allowedUserIds,
  logging: logger,
  onMessage(message) {
    const notification = eventStore.append(message);
    mcp?.publish(notification);
  },
});
mcp = createTelegramMcp(channel, eventStore);

const app = new Hono();
app.get('/health', (context) =>
  context.json({ status: 'ok', telegram: channel.status() }),
);
app.all('/mcp', async (context) => {
  if (!mcp) return context.text('MCP unavailable', 503);
  return mcp.fetch(context.req.raw);
});

const server = serve({ fetch: app.fetch, port }, (address) => {
  logger.info({ port: address.port }, 'Telegram MCP server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down Telegram MCP server');
  server.close();
  await mcp?.close();
  await channel.close();
  eventStore.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

try {
  await channel.start();
} catch (error) {
  logger.fatal({ error }, 'Telegram MCP server failed to start');
  await shutdown('startup-failure');
  throw error;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseUserIds(value: string): ReadonlySet<string> {
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain numeric IDs');
  }
  return new Set(ids);
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
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

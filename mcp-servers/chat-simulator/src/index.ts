import { readFile } from 'node:fs/promises';

import { serve } from '@hono/node-server';

import { createLogger } from '@stagewise/logger';

import { createApp } from './app.js';
import { createChatStore } from './chat-store.js';
import {
  createLiveKitSessionIssuer,
  loadLiveKitSessionConfig,
} from './livekit-session.js';
import { createChatMcp } from './mcp.js';
import { createRealtimeSessionStore } from './realtime-session-store.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const logger = createLogger({ name: 'chat-simulator' });
const store = createChatStore();
const liveKitConfig = loadLiveKitSessionConfig(process.env);
const liveKit = liveKitConfig
  ? createLiveKitSessionIssuer(liveKitConfig)
  : undefined;
const realtimeSessions = createRealtimeSessionStore((sessionId) =>
  liveKit
    ? liveKit.issueKlexTransport(sessionId)
    : {
        transport: {
          profile: 'livekit-room',
          url: 'wss://contract-only.livekit.invalid',
          token: 'contract-only-non-connectable-token',
        },
      },
);
const mcp = createChatMcp(
  store,
  realtimeSessions,
  liveKit?.issueBrowserTransport.bind(liveKit),
);
const realtimeClientScript = await readFile(
  new URL('../dist/realtime-client.js', import.meta.url),
  'utf8',
);
const server = serve(
  { fetch: createApp(store, mcp, realtimeClientScript).fetch, port },
  (address) => {
    logger.info(
      `Chat simulator listening on http://localhost:${address.port} (LiveKit ${liveKit ? 'enabled' : 'contract-only'})`,
    );
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

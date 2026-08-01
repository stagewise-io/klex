import { Hono } from 'hono';

import { RealtimeMediaProtocolError } from '@stagewise/mcp-extension-realtime-media/server';

import type { ChatStore } from './chat-store.js';
import { InvalidMessageError } from './chat-store.js';
import type { ChatMcp } from './mcp.js';
import { renderChatPage } from './ui.js';

export function createApp(
  store: ChatStore,
  mcp: ChatMcp,
  realtimeClientScript = '',
): Hono {
  const app = new Hono();

  app.get('/', (context) => context.html(renderChatPage()));
  app.get('/realtime-client.js', (context) =>
    context.body(realtimeClientScript, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  );
  app.get('/health', (context) => context.json({ status: 'ok' }));
  app.get('/api/messages', (context) =>
    context.json({ messages: store.listMessages() }),
  );
  app.post('/api/messages', async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('message' in body) ||
      typeof body.message !== 'string'
    ) {
      return context.json({ error: 'Expected a message string' }, 400);
    }
    try {
      const created = store.addUserMessage(body.message);
      mcp.publishUserEvent(created.notification);
      return context.json({ message: created.message }, 201);
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  app.post('/api/realtime/sessions', async (context) => {
    const offer = await mcp.createRealtimeOffer();
    return context.json(offer, 201);
  });
  app.delete('/api/realtime/sessions/:sessionId', (context) => {
    try {
      const ended = mcp.endRealtimeSession(
        context.req.param('sessionId'),
        'remote-ended',
      );
      return context.json({ session: ended });
    } catch (error) {
      if (error instanceof RealtimeMediaProtocolError) {
        return context.json(
          { error: error.message, code: error.code, data: error.data },
          409,
        );
      }
      throw error;
    }
  });
  app.get('/api/stream', (_context) => {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        unsubscribe = store.subscribe((message) => {
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify(message)}\n\n`,
            ),
          );
        });
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      },
    });
  });
  app.all('/mcp', (context) => mcp.fetch(context.req.raw));

  return app;
}

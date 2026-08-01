import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeMediaNotification } from '@stagewise/mcp-extension-realtime-media';
import { registerRealtimeMediaClient } from '@stagewise/mcp-extension-realtime-media/client';

import { createApp } from '../src/app.js';
import { type ChatStore, createChatStore } from '../src/chat-store.js';
import { type ChatMcp, createChatMcp } from '../src/mcp.js';

type Setup = {
  store: ChatStore;
  mcp: ChatMcp;
  app: ReturnType<typeof createApp>;
};

const instances: Setup[] = [];
function setup(): Setup {
  const store = createChatStore();
  const mcp = createChatMcp(store);
  const result = { store, mcp, app: createApp(store, mcp) };
  instances.push(result);
  return result;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.store.close();
    await instance.mcp.close();
  }
});

async function jsonRpc(
  app: ReturnType<typeof setup>['app'],
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      ...body,
      params: {
        ...(typeof body.params === 'object' ? body.params : {}),
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: {
              'io.stagewise/push-notifications': {},
              'io.stagewise/realtime-media': {
                transports: ['livekit-room'],
                media: ['audio'],
              },
            },
          },
        },
      },
    }),
  });
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return JSON.parse(data ?? text);
}

describe('chat simulator', () => {
  it('serves the chat UI and health endpoint', async () => {
    const { app } = setup();
    expect(await (await app.request('/health')).json()).toEqual({
      status: 'ok',
    });
    expect(await (await app.request('/')).text()).toContain(
      'Klex Chat Simulator',
    );
  });

  it('validates and stores browser messages as Push Notifications', async () => {
    const { app } = setup();
    const invalid = await app.request('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(invalid.status).toBe(400);

    const created = await app.request('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '  hello  ' }),
    });
    expect(created.status).toBe(201);
    const listing = await (await app.request('/api/messages')).json();
    expect(listing.messages).toMatchObject([
      { sender: 'user', message: 'hello' },
    ]);

    const events = await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/get',
      params: { limit: 100 },
    });
    expect(events).toMatchObject({
      result: {
        events: [
          {
            type: 'chat.message.received',
            content: [{ type: 'text', text: 'hello' }],
            data: { messageId: expect.any(String) },
          },
        ],
        hasMore: false,
      },
    });
  });

  it('hides acknowledged events and accepts repeated or unknown acknowledgements', async () => {
    const { app } = setup();
    await app.request('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const pending = (await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/get',
      params: { limit: 1 },
    })) as { result: { events: Array<{ eventId: string }> } };
    const eventId = pending.result.events[0]?.eventId;
    expect(eventId).toBeDefined();

    for (const eventIds of [[eventId], [eventId], ['unknown-event']]) {
      const acknowledged = await jsonRpc(app, {
        method: 'io.stagewise/push-notifications/ack',
        params: { eventIds },
      });
      expect(acknowledged).toMatchObject({ result: {} });
    }

    const drained = await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/get',
      params: { limit: 1 },
    });
    expect(drained).toMatchObject({
      result: { events: [], hasMore: false },
    });
  });

  it('pages over the oldest unacknowledged events without cursors', async () => {
    const { app } = setup();
    for (const message of ['first', 'second', 'third']) {
      await app.request('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    }

    const first = (await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/get',
      params: { limit: 2 },
    })) as {
      result: {
        events: Array<{
          eventId: string;
          content: Array<{ type: 'text'; text: string }>;
        }>;
        hasMore: boolean;
      };
    };
    expect(first.result.events.map((event) => event.content[0]?.text)).toEqual([
      'first',
      'second',
    ]);
    expect(first.result.hasMore).toBe(true);
    await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/ack',
      params: { eventIds: first.result.events.map((event) => event.eventId) },
    });

    const second = await jsonRpc(app, {
      method: 'io.stagewise/push-notifications/get',
      params: { limit: 2 },
    });
    expect(second).toMatchObject({
      result: {
        events: [{ content: [{ type: 'text', text: 'third' }] }],
        hasMore: false,
      },
    });
  });

  it('negotiates the modern protocol and delivers realtime subscriptions', async () => {
    const { app } = setup();
    let resolveNotification:
      | ((notification: RealtimeMediaNotification) => void)
      | undefined;
    const notification = new Promise<RealtimeMediaNotification>((resolve) => {
      resolveNotification = resolve;
    });
    const client = new Client(
      { name: 'chat-simulator-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const realtime = registerRealtimeMediaClient(client, {
      onNotification: (received) => resolveNotification?.(received),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://chat-simulator.test/mcp'),
      {
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      },
    );

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      expect(await realtime.serverSupportsRealtimeMedia()).toBe(true);
      const subscription = await realtime.listen();
      const closed = subscription.closed.catch(() => undefined);

      const created = await app.request('/api/realtime/sessions', {
        method: 'POST',
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        session: { sessionId: string };
      };
      await expect(notification).resolves.toMatchObject({
        method: 'io.stagewise/realtime-media/session-offered',
        params: { sessionId: body.session.sessionId },
      });

      await client.close();
      await closed;
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('enforces the realtime offer lifecycle idempotently', async () => {
    const { app } = setup();
    const created = await app.request('/api/realtime/sessions', {
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      session: { sessionId: string; expiresAt: string };
    };
    expect(body.session.expiresAt).toBeDefined();

    const accept = () =>
      jsonRpc(app, {
        method: 'io.stagewise/realtime-media/accept',
        params: { sessionId: body.session.sessionId },
      });
    const first = await accept();
    const repeated = await accept();
    expect(first).toMatchObject({
      result: {
        transport: {
          profile: 'livekit-room',
          url: 'wss://contract-only.livekit.invalid',
        },
      },
    });
    expect(repeated).toEqual(first);

    const conflicting = await jsonRpc(app, {
      method: 'io.stagewise/realtime-media/reject',
      params: { sessionId: body.session.sessionId },
    });
    expect(conflicting).toMatchObject({ error: { code: -32_022 } });

    await expect(
      (
        await app.request(`/api/realtime/sessions/${body.session.sessionId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    const ended = await jsonRpc(app, {
      method: 'io.stagewise/realtime-media/end',
      params: { sessionId: body.session.sessionId },
    });
    expect(ended).toMatchObject({ result: {} });
  });

  it('rejects expired realtime offers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T18:00:00.000Z'));
    const { app } = setup();
    const created = (await (
      await app.request('/api/realtime/sessions', { method: 'POST' })
    ).json()) as { session: { sessionId: string } };
    await vi.advanceTimersByTimeAsync(30_001);
    const accepted = await jsonRpc(app, {
      method: 'io.stagewise/realtime-media/accept',
      params: { sessionId: created.session.sessionId },
    });
    expect(accepted).toMatchObject({ error: { code: -32_021 } });
    vi.useRealTimers();
  });

  it('requires realtime capability metadata', async () => {
    const { app, mcp } = setup();
    const offer = mcp.createRealtimeOffer();
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'io.stagewise/realtime-media/reject',
        params: { sessionId: offer.sessionId },
      }),
    });
    expect(await response.text()).toContain('-32003');
  });

  it('exposes only the sendMessage tool for agent replies', async () => {
    const { app } = setup();
    const tools = await jsonRpc(app, { method: 'tools/list' });
    expect(tools).toMatchObject({
      result: { tools: [{ name: 'sendMessage' }] },
    });

    const call = await jsonRpc(app, {
      method: 'tools/call',
      params: { name: 'sendMessage', arguments: { message: 'agent reply' } },
    });
    expect(call).toMatchObject({
      result: { content: [{ type: 'text' }] },
    });
    const listing = await (await app.request('/api/messages')).json();
    expect(listing.messages).toMatchObject([
      { sender: 'agent', message: 'agent reply' },
    ]);
  });
});

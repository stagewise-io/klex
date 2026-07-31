import { afterEach, describe, expect, it } from 'vitest';

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
            payload: { message: 'hello' },
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
        events: Array<{ eventId: string; payload: { message: string } }>;
        hasMore: boolean;
      };
    };
    expect(first.result.events.map((event) => event.payload.message)).toEqual([
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
        events: [{ payload: { message: 'third' } }],
        hasMore: false,
      },
    });
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

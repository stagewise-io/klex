import { describe, expect, it, vi } from 'vitest';

import {
  createPushNotificationsHttpSubscriptionManager,
  PUSH_NOTIFICATIONS_EXTENSION_ID,
  withPushNotificationsClientCapability,
} from '../src/index.js';

const event = {
  eventId: 'event-1',
  sourceId: 'chat-simulator:local',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
  payload: { message: 'Hello' },
};

function listenRequest(
  id: string | number = 1,
  options: {
    capability?: boolean;
    progressToken?: string | number;
    subscription?: unknown;
  } = {},
): Request {
  const metadata =
    options.capability === false
      ? {}
      : withPushNotificationsClientCapability(
          options.progressToken === undefined
            ? {}
            : { progressToken: options.progressToken },
        );
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: {
        notifications: {
          [PUSH_NOTIFICATIONS_EXTENSION_ID]: options.subscription ?? {
            afterCursor: '0',
          },
        },
        _meta: metadata,
      },
    }),
  });
}

async function readSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE stream closed');
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  const data = buffer
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  if (data === undefined) throw new Error('SSE frame has no data');
  return JSON.parse(data);
}

describe('Push Notifications HTTP subscriptions', () => {
  it('delegates unrelated requests unchanged', async () => {
    const delegate = vi.fn(async () => new Response('delegated'));
    const manager = createPushNotificationsHttpSubscriptionManager(delegate);
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      body: JSON.stringify({ method: 'tools/list' }),
    });

    expect(await (await manager.fetch(request)).text()).toBe('delegated');
    expect(delegate).toHaveBeenCalledWith(request);
  });

  it('rejects invalid filters and missing capabilities', async () => {
    const manager = createPushNotificationsHttpSubscriptionManager(async () =>
      Response.json({}),
    );
    const invalid = await manager.fetch(
      listenRequest(1, { subscription: { afterCursor: 5 } }),
    );
    expect(await invalid.json()).toMatchObject({ error: { code: -32602 } });

    const missing = await manager.fetch(
      listenRequest(2, { capability: false }),
    );
    expect(await missing.json()).toMatchObject({ error: { code: -32003 } });
  });

  it('acknowledges first and stamps published events', async () => {
    const manager = createPushNotificationsHttpSubscriptionManager(async () =>
      Response.json({}),
    );
    const response = await manager.fetch(listenRequest('subscription-1'));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response body');

    expect(await readSseMessage(reader)).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: {
          'io.modelcontextprotocol/subscriptionId': 'subscription-1',
        },
      },
    });

    manager.publish({ event, cursor: '1' });
    expect(await readSseMessage(reader)).toMatchObject({
      method: 'io.stagewise/push-notifications/event',
      params: {
        event,
        cursor: '1',
        _meta: {
          'io.modelcontextprotocol/subscriptionId': 'subscription-1',
        },
      },
    });
    await reader.cancel();
    expect(manager.subscriberCount).toBe(0);
  });

  it('emits MCP progress keepalives when requested', async () => {
    vi.useFakeTimers();
    const manager = createPushNotificationsHttpSubscriptionManager(
      async () => Response.json({}),
      { keepAliveMs: 1_000 },
    );
    const response = await manager.fetch(
      listenRequest('subscription-1', { progressToken: 42 }),
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response body');
    await readSseMessage(reader);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readSseMessage(reader)).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 42 },
    });
    await reader.cancel();
    vi.useRealTimers();
  });

  it('publishes to multiple subscribers and closes gracefully', async () => {
    const manager = createPushNotificationsHttpSubscriptionManager(
      async () => Response.json({}),
      { keepAliveMs: 0 },
    );
    const first = (await manager.fetch(listenRequest(1))).body?.getReader();
    const second = (await manager.fetch(listenRequest(2))).body?.getReader();
    if (first === undefined || second === undefined) {
      throw new Error('Missing response body');
    }
    await Promise.all([readSseMessage(first), readSseMessage(second)]);
    expect(manager.subscriberCount).toBe(2);

    manager.publish({ event, cursor: '1' });
    const notifications = await Promise.all([
      readSseMessage(first),
      readSseMessage(second),
    ]);
    expect(notifications).toHaveLength(2);

    manager.close();
    expect(await readSseMessage(first)).toMatchObject({
      id: 1,
      result: { resultType: 'complete' },
    });
    expect(await readSseMessage(second)).toMatchObject({
      id: 2,
      result: { resultType: 'complete' },
    });
    expect(manager.subscriberCount).toBe(0);
  });
});

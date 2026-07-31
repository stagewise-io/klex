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
    consumerKey?: string;
    progressToken?: string | number;
    subscription?: unknown;
    signal?: AbortSignal;
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
    headers: {
      'Content-Type': 'application/json',
      ...(options.consumerKey === undefined
        ? {}
        : { 'X-Consumer-Key': options.consumerKey }),
    },
    signal: options.signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: {
        notifications: {
          [PUSH_NOTIFICATIONS_EXTENSION_ID]: options.subscription ?? {},
        },
        _meta: metadata,
      },
    }),
  });
}

function createManager(options: { keepAliveMs?: number } = {}) {
  return createPushNotificationsHttpSubscriptionManager(
    async () => Response.json({}),
    {
      ...options,
      resolveConsumerKey: (request) => {
        const key = request.headers.get('X-Consumer-Key');
        if (!key) throw new Error('Unauthenticated');
        return key;
      },
    },
  );
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

async function subscribe(
  manager: ReturnType<typeof createManager>,
  id: string | number,
  consumerKey: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await manager.fetch(listenRequest(id, { consumerKey }));
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Missing response body');
  await readSseMessage(reader);
  return reader;
}

describe('Push Notifications HTTP subscriptions', () => {
  it('delegates unrelated requests unchanged', async () => {
    const delegate = vi.fn(async () => new Response('delegated'));
    const manager = createPushNotificationsHttpSubscriptionManager(delegate, {
      resolveConsumerKey: () => 'unused',
    });
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      body: JSON.stringify({ method: 'tools/list' }),
    });

    expect(await (await manager.fetch(request)).text()).toBe('delegated');
    expect(delegate).toHaveBeenCalledWith(request);
  });

  it('rejects invalid filters, missing capabilities, and unresolved consumers', async () => {
    const manager = createManager();
    const invalid = await manager.fetch(
      listenRequest(1, {
        consumerKey: 'agent-a',
        subscription: { afterCursor: 'removed' },
      }),
    );
    expect(await invalid.json()).toMatchObject({ error: { code: -32602 } });

    const missing = await manager.fetch(
      listenRequest(2, { capability: false, consumerKey: 'agent-a' }),
    );
    expect(await missing.json()).toMatchObject({ error: { code: -32003 } });

    const unresolved = await manager.fetch(listenRequest(3));
    expect(await unresolved.json()).toMatchObject({ error: { code: -32001 } });
  });

  it('acknowledges first and stamps cursor-free published events', async () => {
    const manager = createManager();
    const response = await manager.fetch(
      listenRequest('subscription-1', { consumerKey: 'agent-a' }),
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response body');

    expect(await readSseMessage(reader)).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
        _meta: {
          'io.modelcontextprotocol/subscriptionId': 'subscription-1',
        },
      },
    });

    manager.publish('agent-a', { event });
    expect(await readSseMessage(reader)).toMatchObject({
      method: 'io.stagewise/push-notifications/event',
      params: {
        event,
        _meta: {
          'io.modelcontextprotocol/subscriptionId': 'subscription-1',
        },
      },
    });
    await reader.cancel();
    expect(manager.subscriberCount).toBe(0);
  });

  it('routes events only to the targeted consumer', async () => {
    const manager = createManager({ keepAliveMs: 0 });
    const first = await subscribe(manager, 1, 'agent-a');
    const second = await subscribe(manager, 2, 'agent-b');

    manager.publish('agent-a', { event });
    expect(await readSseMessage(first)).toMatchObject({ params: { event } });
    expect(manager.subscriberCount).toBe(2);

    await first.cancel();
    await second.cancel();
  });

  it('replaces the active subscription for the same consumer', async () => {
    const manager = createManager({ keepAliveMs: 0 });
    const first = await subscribe(manager, 1, 'agent-a');
    const second = await subscribe(manager, 2, 'agent-a');

    expect(await readSseMessage(first)).toMatchObject({
      id: 1,
      result: { resultType: 'complete' },
    });
    expect(manager.subscriberCount).toBe(1);

    manager.publish('agent-a', { event });
    expect(await readSseMessage(second)).toMatchObject({ params: { event } });
    await second.cancel();
  });

  it('reports subscription lifecycle across replacement, abort, and shutdown', async () => {
    const changes: Array<[string, boolean]> = [];
    const manager = createPushNotificationsHttpSubscriptionManager(
      async () => Response.json({}),
      {
        keepAliveMs: 0,
        resolveConsumerKey: (request) =>
          request.headers.get('X-Consumer-Key') ?? 'agent-a',
        onSubscriptionStateChanged: (consumerKey, active) => {
          changes.push([consumerKey, active]);
        },
      },
    );

    const first = await subscribe(manager, 1, 'agent-a');
    const second = await subscribe(manager, 2, 'agent-a');
    expect(changes).toEqual([
      ['agent-a', true],
      ['agent-a', false],
      ['agent-a', true],
    ]);

    const controller = new AbortController();
    const response = await manager.fetch(
      listenRequest(3, {
        consumerKey: 'agent-b',
        signal: controller.signal,
      }),
    );
    const third = response.body?.getReader();
    if (third === undefined) throw new Error('Missing response body');
    await readSseMessage(third);
    controller.abort();
    await vi.waitFor(() => expect(manager.subscriberCount).toBe(1));
    expect(changes.at(-1)).toEqual(['agent-b', false]);

    manager.close();
    expect(changes.at(-1)).toEqual(['agent-a', false]);
    await first.cancel();
    await second.cancel();
  });

  it('isolates lifecycle callback failures from protocol handling', async () => {
    const manager = createPushNotificationsHttpSubscriptionManager(
      async () => Response.json({}),
      {
        keepAliveMs: 0,
        resolveConsumerKey: () => 'agent-a',
        onSubscriptionStateChanged: () => {
          throw new Error('observer failed');
        },
      },
    );
    const reader = await subscribe(manager, 1, 'agent-a');
    expect(manager.subscriberCount).toBe(1);
    await reader.cancel();
    expect(manager.subscriberCount).toBe(0);
  });

  it('emits MCP progress keepalives and closes gracefully', async () => {
    vi.useFakeTimers();
    const manager = createManager({ keepAliveMs: 1_000 });
    const response = await manager.fetch(
      listenRequest('subscription-1', {
        consumerKey: 'agent-a',
        progressToken: 42,
      }),
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response body');
    await readSseMessage(reader);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readSseMessage(reader)).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 42 },
    });

    manager.close();
    expect(await readSseMessage(reader)).toMatchObject({
      id: 'subscription-1',
      result: { resultType: 'complete' },
    });
    expect(manager.subscriberCount).toBe(0);
    vi.useRealTimers();
  });
});

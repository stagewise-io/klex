import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimeMediaHttpSubscriptionManager,
  withRealtimeMediaClientCapability,
} from '../src/index.js';

function listenRequest(id: number, consumerKey: string): Request {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'x-consumer': consumerKey },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: {
        notifications: { 'io.stagewise/realtime-media': {} },
        _meta: withRealtimeMediaClientCapability({}),
      },
    }),
  });
}

async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> {
  const decoder = new TextDecoder();
  while (true) {
    const result = await reader.read();
    if (result.done) throw new Error('stream ended');
    const frame = decoder.decode(result.value);
    const line = frame.split('\n').find((value) => value.startsWith('data: '));
    if (line) return JSON.parse(line.slice(6));
  }
}

describe('Realtime Media HTTP subscriptions', () => {
  it('targets offers and ended notifications by authenticated consumer', async () => {
    const delegate = vi.fn(async () => new Response('delegate'));
    const state = vi.fn();
    const manager = createRealtimeMediaHttpSubscriptionManager(delegate, {
      resolveConsumerKey: (request) => request.headers.get('x-consumer') ?? '',
      keepAliveMs: 0,
      onSubscriptionStateChanged: state,
    });
    const response = await manager.fetch(listenRequest(1, 'consumer-a'));
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing stream');
    expect(await readMessage(reader)).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    manager.publishSessionOffered('consumer-a', {
      sessionId: 'session-1',
      expiresAt: '2026-08-01T18:00:00.000Z',
    });
    expect(await readMessage(reader)).toMatchObject({
      method: 'io.stagewise/realtime-media/session-offered',
      params: { sessionId: 'session-1' },
    });
    manager.publishSessionEnded('consumer-a', {
      sessionId: 'session-1',
      reason: 'remote',
    });
    expect(await readMessage(reader)).toMatchObject({
      method: 'io.stagewise/realtime-media/session-ended',
    });
    manager.close();
    expect(state).toHaveBeenCalledWith('consumer-a', false);
  });

  it('delegates unrelated requests', async () => {
    const delegate = vi.fn(async () => new Response('delegate'));
    const manager = createRealtimeMediaHttpSubscriptionManager(delegate, {
      resolveConsumerKey: () => 'consumer-a',
    });
    const response = await manager.fetch(
      new Request('https://example.com/mcp', { method: 'GET' }),
    );
    expect(await response.text()).toBe('delegate');
    expect(delegate).toHaveBeenCalledOnce();
  });
});

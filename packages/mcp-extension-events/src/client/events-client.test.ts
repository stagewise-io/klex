import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_CAPABILITIES_META_KEY,
  EVENTS_EXTENSION_ID,
} from '../constants.js';
import {
  type EventsClientProtocol,
  EventsUnsupportedError,
  registerEventsClient,
} from './events-client.js';

type Handler = (request: {
  method: string;
  params: Record<string, unknown>;
}) => unknown;

function fakeClient(opts: {
  serverCapabilities?: Record<string, unknown>;
  era?: string;
  respond?: Handler;
}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const client = {
    getProtocolEra: () => opts.era,
    getServerCapabilities: () => opts.serverCapabilities,
    registerCapabilities: vi.fn(),
    request: vi.fn(
      async (
        req: never,
        schema: { parse(v: unknown): unknown },
        _options?: { signal?: AbortSignal },
      ) => {
        requests.push(req);
        return schema.parse(opts.respond?.(req) ?? {});
      },
    ),
  };
  return {
    client: client as unknown as EventsClientProtocol,
    requests,
    raw: client,
  };
}

const supported = { extensions: { [EVENTS_EXTENSION_ID]: {} } };

describe('registerEventsClient', () => {
  it('registers the client capability', () => {
    const f = fakeClient({});
    registerEventsClient(f.client);
    expect(f.raw.registerCapabilities).toHaveBeenCalledTimes(1);
  });

  it('never sends events/* to a server without the extension', async () => {
    const f = fakeClient({ serverCapabilities: {}, era: 'modern' });
    const events = registerEventsClient(f.client);
    await expect(
      events.poll({ name: 'x', cursor: null }),
    ).rejects.toBeInstanceOf(EventsUnsupportedError);
    await expect(events.listEvents()).rejects.toBeInstanceOf(
      EventsUnsupportedError,
    );
    expect(f.requests).toHaveLength(0);
  });

  it('attaches the per-request client capability to poll', async () => {
    const f = fakeClient({
      serverCapabilities: supported,
      respond: () => ({ events: [], cursor: 'c' }),
    });
    const events = registerEventsClient(f.client);
    const result = await events.poll({ name: 'x', cursor: null });
    expect(result.cursor).toBe('c');
    const meta = f.requests[0]?.params['_meta'] as Record<string, unknown>;
    expect(meta[CLIENT_CAPABILITIES_META_KEY]).toBeDefined();
    expect(f.requests[0]?.params['name']).toBe('x');
  });

  it('follows nextCursor pagination in listEvents', async () => {
    const descriptor = (name: string) => ({ name, delivery: ['poll'] });
    const pages = [
      { events: [descriptor('a')], nextCursor: 'p2' },
      { events: [descriptor('b')] },
    ];
    const f = fakeClient({
      serverCapabilities: supported,
      respond: () => pages.shift(),
    });
    const events = registerEventsClient(f.client);
    const list = await events.listEvents();
    expect(list.map((e) => e.name)).toEqual(['a', 'b']);
    expect(f.requests[1]?.params['cursor']).toBe('p2');
  });

  it('returns one catalogue page without conflating replay cursors', async () => {
    const f = fakeClient({
      serverCapabilities: supported,
      respond: () => ({
        events: [{ name: 'x', delivery: ['poll'] }],
        nextCursor: 'next',
      }),
    });
    const events = registerEventsClient(f.client);
    expect((await events.listEventsPage('page')).nextCursor).toBe('next');
    expect(f.requests[0]?.params['cursor']).toBe('page');
    expect(f.requests).toHaveLength(1);
  });

  it('rejects oversized pages and forwards cancellation', async () => {
    const f = fakeClient({
      serverCapabilities: supported,
      respond: () => ({
        events: [
          {
            name: 'x',
            description: 'x'.repeat(1024 * 1024),
            delivery: ['poll'],
          },
        ],
      }),
    });
    const signal = new AbortController().signal;
    await expect(
      registerEventsClient(f.client).listEventsPage(undefined, {
        request: { signal },
      }),
    ).rejects.toThrow('limit');
    expect(f.raw.request.mock.calls[0]?.[2]).toEqual({ signal });
  });

  it('discovers support when neither era nor capabilities are known', async () => {
    const f = fakeClient({
      respond: (req) =>
        req.method === 'server/discover'
          ? { capabilities: supported }
          : { events: [], cursor: null },
    });
    const events = registerEventsClient(f.client);
    expect(await events.serverSupportsEvents()).toBe(true);
    expect(f.requests[0]?.method).toBe('server/discover');
  });
});

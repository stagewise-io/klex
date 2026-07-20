import { describe, expect, it, vi } from 'vitest';
import {
  type FluidEventsClientProtocol,
  registerFluidEventsClient,
} from '../src/client/index.js';
import { FLUID_EVENTS_EXTENSION_ID } from '../src/index.js';

const event = {
  eventId: 'event-1',
  sourceId: 'computer:local',
  type: 'process.exited',
  createdAt: '2026-07-20T10:30:00.000Z',
  payload: { exitCode: 1 },
};

function fakeClient() {
  const handlers = new Map<string, (value: unknown) => unknown>();
  const requests: unknown[] = [];
  const client = {
    registerCapabilities: vi.fn(),
    assertCanSetRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn((method, _schema, handler) => {
      if (handlers.has(method)) throw new Error('duplicate');
      handlers.set(method, handler);
    }),
    request: vi.fn(async (request) => {
      requests.push(request);
      const method = (request as { method: string }).method;
      if (method === 'server/discover') {
        return {
          capabilities: {
            extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
          },
        };
      }
      if (method === 'io.stagewise.fluid/events/get') {
        return { events: [event], nextCursor: 'cursor-2', hasMore: false };
      }
      return {};
    }),
    getServerCapabilities: () => ({
      extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
    }),
  } as unknown as FluidEventsClientProtocol;
  return { client, handlers, requests };
}

describe('Fluid Events client', () => {
  it('injects per-request capability while preserving metadata', async () => {
    const { client, requests } = fakeClient();
    const fluid = registerFluidEventsClient(client);
    await fluid.getEvents(
      { cursor: 'durable-cursor', limit: 10 },
      { metadata: { trace: 'trace-1' } },
    );
    expect(requests[1]).toMatchObject({
      params: {
        cursor: 'durable-cursor',
        _meta: {
          trace: 'trace-1',
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
          },
        },
      },
    });
  });

  it('discovers support and exposes acknowledged subscriptions', async () => {
    const { client, handlers } = fakeClient();
    const fluid = registerFluidEventsClient(client);
    expect(await fluid.serverSupportsFluidEvents()).toBe(true);
    await fluid.listen({ afterCursor: 'cursor-2' });
    await handlers.get('notifications/subscriptions/acknowledged')?.({
      notifications: {
        [FLUID_EVENTS_EXTENSION_ID]: { afterCursor: 'cursor-2' },
      },
    });
    expect(fluid.acknowledgedSubscription()).toEqual({
      afterCursor: 'cursor-2',
    });
  });

  it('caches lazy discovery across concurrent operations', async () => {
    const { client, requests } = fakeClient();
    const fluid = registerFluidEventsClient(client);
    await Promise.all([
      fluid.serverSupportsFluidEvents(),
      fluid.getEvents(),
      fluid.listen({}),
    ]);
    expect(
      requests.filter(
        (request) =>
          (request as { method: string }).method === 'server/discover',
      ),
    ).toHaveLength(1);
  });

  it('does not acknowledge received events automatically', async () => {
    const { client, handlers } = fakeClient();
    const onEvent = vi.fn();
    registerFluidEventsClient(client, { onEvent });
    await handlers.get('io.stagewise.fluid/notifications/event')?.({
      event,
      cursor: 'cursor-2',
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects duplicate notification registration', () => {
    const { client } = fakeClient();
    registerFluidEventsClient(client);
    expect(() => registerFluidEventsClient(client)).toThrow('duplicate');
  });
});

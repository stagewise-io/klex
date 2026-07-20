import { describe, expect, it, vi } from 'vitest';
import {
  FLUID_EVENTS_EXTENSION_ID,
  FluidEventsProtocolError,
  type FluidEventsServerProtocol,
  registerFluidEventsServer,
  withFluidEventsClientCapability,
} from '../src/index.js';

function fakeServer(initializationSupport = false) {
  const handlers = new Map<
    string,
    (value: unknown, context: object) => unknown
  >();
  const notifications: unknown[] = [];
  const server = {
    registerCapabilities: vi.fn(),
    assertCanSetRequestHandler: vi.fn(),
    setRequestHandler: vi.fn((method, _schema, handler) => {
      if (handlers.has(method)) throw new Error('duplicate');
      handlers.set(method, handler);
    }),
    notification: vi.fn(async (notification) => {
      notifications.push(notification);
    }),
    getClientCapabilities: () =>
      initializationSupport
        ? { extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} } }
        : undefined,
  } as unknown as FluidEventsServerProtocol;
  return { server, handlers, notifications };
}

const metadata = withFluidEventsClientCapability({});

describe('Fluid Events server', () => {
  it('requires per-request capability by default', async () => {
    const { server, handlers } = fakeServer(true);
    registerFluidEventsServer(server, {
      getEvents: () => ({ events: [], nextCursor: 'cursor-1', hasMore: false }),
      acknowledgeEvents: () => undefined,
    });
    await expect(
      handlers.get('io.stagewise.fluid/events/get')?.({}, {}),
    ).rejects.toMatchObject({
      code: -32003,
      data: {
        requiredCapabilities: {
          extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
        },
      },
    });
  });

  it('supports explicit initialization fallback compatibility', async () => {
    const { server, handlers } = fakeServer(true);
    registerFluidEventsServer(
      server,
      {
        getEvents: () => ({
          events: [],
          nextCursor: 'cursor-1',
          hasMore: false,
        }),
        acknowledgeEvents: () => undefined,
      },
      { acceptInitializationCapabilities: true },
    );
    await expect(
      handlers.get('io.stagewise.fluid/events/get')?.({}, {}),
    ).resolves.toEqual({
      events: [],
      nextCursor: 'cursor-1',
      hasMore: false,
    });
  });

  it('keeps durability and acknowledgement in application handlers', async () => {
    const { server, handlers } = fakeServer();
    const getEvents = vi.fn(() => ({
      events: [],
      nextCursor: 'cursor-1',
      hasMore: false,
    }));
    const acknowledgeEvents = vi.fn();
    registerFluidEventsServer(server, { getEvents, acknowledgeEvents });
    const context = {
      mcpReq: {
        envelope: metadata,
      },
    };
    await handlers.get('io.stagewise.fluid/events/get')?.(
      { cursor: 'persistent-cursor', _meta: metadata },
      context,
    );
    await handlers.get('io.stagewise.fluid/events/ack')?.(
      { eventIds: ['event-1'], _meta: metadata },
      context,
    );
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'persistent-cursor' }),
      context,
    );
    expect(acknowledgeEvents).toHaveBeenCalledWith(
      expect.objectContaining({ eventIds: ['event-1'] }),
      context,
    );
  });

  it('rejects a push without negotiated client support', async () => {
    const { server } = fakeServer();
    const fluid = registerFluidEventsServer(server, {
      getEvents: () => ({ events: [], nextCursor: 'cursor-1', hasMore: false }),
      acknowledgeEvents: () => undefined,
    });
    await expect(
      fluid.sendEvent({
        event: {
          eventId: 'event-1',
          sourceId: 'computer:local',
          type: 'file.changed',
          createdAt: '2026-07-20T10:30:00.000Z',
          payload: {},
        },
        cursor: 'cursor-1',
      }),
    ).rejects.toBeInstanceOf(FluidEventsProtocolError);
  });
});

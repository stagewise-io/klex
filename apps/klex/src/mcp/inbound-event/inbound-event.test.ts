import { describe, expect, it, vi } from 'vitest';

import {
  createInboundEventSourceRegistry,
  type InboundEventSource,
  inboundEventKey,
} from './inbound-event';

function fakeSource(
  origin: InboundEventSource['origin'],
  initiallyUnsettled = false,
) {
  let unsettled = initiallyUnsettled;
  const source = {
    origin,
    hasUnsettled: () => unsettled,
    settleDelivered: vi.fn(async () => {
      unsettled = false;
    }),
    pause: vi.fn(),
  } satisfies InboundEventSource;
  return source;
}

describe('inboundEventKey', () => {
  it('scopes eventId by origin and source', () => {
    const base = { namespace: 'ns', eventId: 'e1' };
    const push = inboundEventKey({
      ...base,
      origin: 'push-notifications',
      sourceKey: 'queue',
    });
    const events = inboundEventKey({
      ...base,
      origin: 'events',
      sourceKey: 'queue',
    });
    const otherSub = inboundEventKey({
      ...base,
      origin: 'events',
      sourceKey: 'other',
    });
    expect(new Set([push, events, otherSub]).size).toBe(3);
  });

  it('does not collide when parts contain separators', () => {
    const a = inboundEventKey({
      namespace: 'a|b',
      origin: 'events',
      sourceKey: 'c',
      eventId: 'd',
    });
    const b = inboundEventKey({
      namespace: 'a',
      origin: 'events',
      sourceKey: 'b|c',
      eventId: 'd',
    });
    expect(a).not.toBe(b);
  });
});

describe('InboundEventSourceRegistry', () => {
  it('reports unsettled if any source has unsettled events', () => {
    const registry = createInboundEventSourceRegistry();
    registry.register(fakeSource('push-notifications'));
    expect(registry.hasUnsettled()).toBe(false);
    registry.register(fakeSource('events', true));
    expect(registry.hasUnsettled()).toBe(true);
  });

  it('settles every source and clears unsettled state', async () => {
    const registry = createInboundEventSourceRegistry();
    const push = fakeSource('push-notifications', true);
    const events = fakeSource('events', true);
    registry.register(push);
    registry.register(events);
    await registry.settleAll();
    expect(push.settleDelivered).toHaveBeenCalledOnce();
    expect(events.settleDelivered).toHaveBeenCalledOnce();
    expect(registry.hasUnsettled()).toBe(false);
  });

  it('settles the other sources when one fails, then rethrows', async () => {
    const registry = createInboundEventSourceRegistry();
    const failing = fakeSource('events', true);
    failing.settleDelivered.mockRejectedValueOnce(new Error('boom'));
    const healthy = fakeSource('push-notifications', true);
    registry.register(failing);
    registry.register(healthy);
    await expect(registry.settleAll()).rejects.toThrow('boom');
    expect(healthy.settleDelivered).toHaveBeenCalledOnce();
  });

  it('pauses existing and later-registered sources', () => {
    const registry = createInboundEventSourceRegistry();
    const early = fakeSource('push-notifications');
    registry.register(early);
    registry.pauseAll();
    const late = fakeSource('events');
    registry.register(late);
    expect(early.pause).toHaveBeenCalledOnce();
    expect(late.pause).toHaveBeenCalledOnce();
  });

  it('stops consulting an unregistered source', () => {
    const registry = createInboundEventSourceRegistry();
    const unregister = registry.register(fakeSource('events', true));
    unregister();
    expect(registry.hasUnsettled()).toBe(false);
  });
});

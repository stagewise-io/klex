import { describe, expect, it } from 'vitest';

import {
  eventsListChangedSupported,
  hasEventsCapability,
  resolveServerEventsSupport,
  withEventsClientCapability,
} from './capabilities.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  EVENTS_EXTENSION_ID,
} from './constants.js';
import {
  EventDescriptorSchema,
  EventsPollResultSchema,
  EventsTerminatedParamsSchema,
} from './generated/schema.js';

describe('capabilities', () => {
  it('detects the extension and prefers discovery over initialization', () => {
    const on = { extensions: { [EVENTS_EXTENSION_ID]: {} } };
    expect(hasEventsCapability(on)).toBe(true);
    expect(hasEventsCapability({})).toBe(false);
    expect(
      resolveServerEventsSupport({ discovery: {}, initialization: on }),
    ).toBe(false);
    expect(resolveServerEventsSupport({ initialization: on })).toBe(true);
  });

  it('reads listChanged', () => {
    expect(
      eventsListChangedSupported({
        extensions: { [EVENTS_EXTENSION_ID]: { listChanged: true } },
      }),
    ).toBe(true);
    expect(
      eventsListChangedSupported({ extensions: { [EVENTS_EXTENSION_ID]: {} } }),
    ).toBe(false);
  });

  it('adds the per-request client capability without dropping others', () => {
    const meta = withEventsClientCapability({
      other: 1,
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: { 'x/y': {} } },
    });
    expect(meta.other).toBe(1);
    expect(meta[CLIENT_CAPABILITIES_META_KEY].extensions).toEqual({
      'x/y': {},
      [EVENTS_EXTENSION_ID]: {},
    });
  });
});

describe('schemas', () => {
  it('accepts a poll result with absent cursor (absent means null)', () => {
    const parsed = EventsPollResultSchema.parse({
      events: [
        {
          eventId: 'e1',
          name: 'email.received',
          timestamp: '2026-02-19T15:30:00Z',
          data: { a: 1 },
        },
      ],
    });
    expect(parsed.cursor).toBeUndefined();
  });

  it('accepts an explicit null cursor', () => {
    expect(
      EventsPollResultSchema.safeParse({ events: [], cursor: null }).success,
    ).toBe(true);
  });

  it('rejects a descriptor without delivery modes shape', () => {
    expect(EventDescriptorSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('parses a terminated notification with subscription id', () => {
    const parsed = EventsTerminatedParamsSchema.parse({
      error: { code: -32024, message: 'Forbidden' },
      _meta: { 'io.modelcontextprotocol/subscriptionId': 1 },
    });
    expect(parsed.error.code).toBe(-32024);
  });
});

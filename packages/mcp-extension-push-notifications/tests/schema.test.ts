import { describe, expect, it } from 'vitest';

import {
  AcknowledgeEventsRequestSchema,
  AcknowledgeEventsResultSchema,
  GetEventsRequestSchema,
  GetEventsResultSchema,
  MissingRequiredClientCapabilityDataSchema,
  PushNotificationNotificationSchema,
  PushNotificationSchema,
  PushNotificationsExtensionCapabilitySchema,
  PushNotificationsSubscriptionAcknowledgedNotificationsSchema,
  PushNotificationsSubscriptionNotificationsSchema,
  ServerDiscoverRequestSchema,
  ServerDiscoverResultSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenRequestSchema,
} from '../src/generated/schema.js';

const event = {
  eventId: '01JZ8F4Q2M0QJ4V5NZ0V1QZV3B',
  sourceId: 'computer:local',
  type: 'process.exited',
  createdAt: '2026-07-20T10:30:00.000Z',
  payload: {
    command: 'pnpm test',
    exitCode: 1,
    signal: null,
    expected: false,
    tags: ['test', 'local'],
  },
};

const getRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'io.stagewise/push-notifications/get',
  params: {
    cursor: '01JZ8F2X3A',
    limit: 100,
  },
};

const getResult = {
  events: [event],
  nextCursor: '01JZ8F4Q2M',
  hasMore: false,
};

const ackRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'io.stagewise/push-notifications/ack',
  params: {
    eventIds: [event.eventId],
  },
};

const notification = {
  jsonrpc: '2.0',
  method: 'io.stagewise/push-notifications/event',
  params: {
    event,
    cursor: '01JZ8F4Q2M',
  },
};

describe('Push notification envelope', () => {
  it('accepts the specification fixture', () => {
    expect(PushNotificationSchema.parse(event)).toEqual(event);
  });

  it('rejects non-object payloads and invalid timestamps', () => {
    expect(
      PushNotificationSchema.safeParse({ ...event, payload: 'failure' })
        .success,
    ).toBe(false);
    expect(
      PushNotificationSchema.safeParse({ ...event, createdAt: 'last Tuesday' })
        .success,
    ).toBe(false);
  });

  it('rejects non-JSON payload values', () => {
    expect(
      PushNotificationSchema.safeParse({
        ...event,
        payload: { invalid: undefined },
      }).success,
    ).toBe(false);
  });

  it('accepts discovery and subscription protocol messages', () => {
    const capabilities = {
      extensions: { 'io.stagewise/push-notifications': {} },
    };
    expect(
      ServerDiscoverRequestSchema.parse({
        jsonrpc: '2.0',
        id: 3,
        method: 'server/discover',
        params: {},
      }),
    ).toBeDefined();
    expect(ServerDiscoverResultSchema.parse({ capabilities })).toBeDefined();
    expect(
      SubscriptionsListenRequestSchema.parse({
        jsonrpc: '2.0',
        id: 4,
        method: 'subscriptions/listen',
        params: {
          notifications: {
            'io.stagewise/push-notifications': { afterCursor: 'cursor' },
          },
        },
      }),
    ).toBeDefined();
    expect(
      SubscriptionsAcknowledgedNotificationSchema.parse({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: {
          notifications: {
            'io.stagewise/push-notifications': { afterCursor: 'cursor' },
          },
        },
      }),
    ).toBeDefined();
    expect(
      MissingRequiredClientCapabilityDataSchema.parse({
        requiredCapabilities: capabilities,
      }),
    ).toBeDefined();
  });
});

describe('retrieval', () => {
  it('accepts the specification request and result', () => {
    expect(GetEventsRequestSchema.parse(getRequest)).toEqual(getRequest);
    expect(GetEventsResultSchema.parse(getResult)).toEqual(getResult);
  });

  it('requires a positive integer page limit', () => {
    for (const limit of [0, -1, 1.5]) {
      expect(
        GetEventsRequestSchema.safeParse({
          ...getRequest,
          params: { limit },
        }).success,
      ).toBe(false);
    }
  });

  it('requires the page cursor fields', () => {
    expect(
      GetEventsResultSchema.safeParse({ events: [event], hasMore: false })
        .success,
    ).toBe(false);
  });
});

describe('acknowledgement', () => {
  it('accepts the specification request and empty result', () => {
    expect(AcknowledgeEventsRequestSchema.parse(ackRequest)).toEqual(
      ackRequest,
    );
    expect(AcknowledgeEventsResultSchema.parse({})).toEqual({});
  });

  it('rejects an empty identifier list', () => {
    expect(
      AcknowledgeEventsRequestSchema.safeParse({
        ...ackRequest,
        params: { eventIds: [] },
      }).success,
    ).toBe(false);
  });
});

describe('notifications and subscriptions', () => {
  it('accepts the specification notification', () => {
    expect(PushNotificationNotificationSchema.parse(notification)).toEqual(
      notification,
    );
  });

  it('rejects notification payloads without a cursor', () => {
    expect(
      PushNotificationNotificationSchema.safeParse({
        ...notification,
        params: { event },
      }).success,
    ).toBe(false);
  });

  it('accepts requested and acknowledged subscription cursors', () => {
    const filter = {
      'io.stagewise/push-notifications': {
        afterCursor: '01JZ8F2X3A',
      },
    };
    expect(
      PushNotificationsSubscriptionNotificationsSchema.parse(filter),
    ).toEqual(filter);
    expect(
      PushNotificationsSubscriptionAcknowledgedNotificationsSchema.parse(
        filter,
      ),
    ).toEqual(filter);
  });
});

describe('capability declaration', () => {
  it('accepts only the empty capability object', () => {
    expect(PushNotificationsExtensionCapabilitySchema.parse({})).toEqual({});
    expect(
      PushNotificationsExtensionCapabilitySchema.safeParse({ version: 1 })
        .success,
    ).toBe(false);
  });
});

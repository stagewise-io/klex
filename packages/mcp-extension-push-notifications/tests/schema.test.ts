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
  content: [{ type: 'text', text: 'pnpm test exited with code 1' }],
  data: {
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
    limit: 100,
  },
};

const getResult = {
  events: [event],
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
  },
};

describe('Push notification envelope', () => {
  it('accepts the specification fixture', () => {
    expect(PushNotificationSchema.parse(event)).toEqual(event);
  });

  it('accepts canonical multimodal and resource content blocks', () => {
    const content = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' },
      {
        type: 'resource',
        resource: { uri: 'file:///message.txt', text: 'embedded message' },
      },
      {
        type: 'resource_link',
        uri: 'mcp://telegram/file/1',
        name: 'voice.ogg',
        mimeType: 'audio/ogg',
      },
    ];
    expect(PushNotificationSchema.parse({ ...event, content }).content).toEqual(
      content,
    );
    expect(
      PushNotificationSchema.parse({ ...event, content: [] }).content,
    ).toEqual([]);
  });

  it('rejects legacy and malformed event fields', () => {
    const { content: _content, ...withoutContent } = event;
    expect(PushNotificationSchema.safeParse(withoutContent).success).toBe(
      false,
    );
    expect(
      PushNotificationSchema.safeParse({ ...event, payload: { legacy: true } })
        .success,
    ).toBe(false);
    expect(
      PushNotificationSchema.safeParse({
        ...event,
        content: [{ type: 'text' }],
      }).success,
    ).toBe(false);
    expect(
      PushNotificationSchema.safeParse({ ...event, data: 'failure' }).success,
    ).toBe(false);
    expect(
      PushNotificationSchema.safeParse({
        ...event,
        data: { invalid: undefined },
      }).success,
    ).toBe(false);
    expect(
      PushNotificationSchema.safeParse({ ...event, createdAt: 'last Tuesday' })
        .success,
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
            'io.stagewise/push-notifications': {},
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
            'io.stagewise/push-notifications': {},
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

  it('does not expose cursor fields', () => {
    expect(GetEventsResultSchema.parse(getResult)).not.toHaveProperty(
      'nextCursor',
    );
    expect(
      GetEventsRequestSchema.parse({
        ...getRequest,
        params: { cursor: 'ignored-extension-field', limit: 1 },
      }),
    ).toMatchObject({
      params: { cursor: 'ignored-extension-field', limit: 1 },
    });
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

  it('accepts cursor-free notifications', () => {
    expect(
      PushNotificationNotificationSchema.parse(notification),
    ).not.toHaveProperty('params.cursor');
  });

  it('accepts empty requested and acknowledged subscriptions', () => {
    const filter = {
      'io.stagewise/push-notifications': {},
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

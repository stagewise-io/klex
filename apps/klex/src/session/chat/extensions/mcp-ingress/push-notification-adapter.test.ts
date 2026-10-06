import { describe, expect, it } from 'vitest';

import type { McpPushNotification } from '@/mcp';
import type { ContextMetadataValue } from '@/session/inbox';

import { mcpPushNotificationToInboxEvent } from './push-notification-adapter';

const trustedSenderHeader = {
  type: 'stagewise.sender-header',
  version: 1,
} as const;

function notification(
  event: Partial<McpPushNotification['event']> = {},
): McpPushNotification {
  return {
    namespace: 'whatsapp',
    event: {
      eventId: 'e1',
      sourceId: 'chat-42',
      type: 'message',
      createdAt: '2026-09-23T10:00:00.000Z',
      content: [{ type: 'text', text: 'hello' }],
      ...event,
    },
  };
}

describe('mcpPushNotificationToInboxEvent', () => {
  it('carries the resource link URI into metadata', () => {
    const inbox = mcpPushNotificationToInboxEvent(
      notification({ resourceLink: { uri: 'chat://whatsapp/42' } }),
    );

    expect(inbox.context.metadata).toEqual({
      sourceId: 'chat-42',
      type: 'message',
      createdAt: '2026-09-23T10:00:00.000Z',
      resourceLink: 'chat://whatsapp/42',
    });
  });

  it('omits resourceLink when the event has none', () => {
    const inbox = mcpPushNotificationToInboxEvent(notification());

    expect(inbox.context.metadata).not.toHaveProperty('resourceLink');
  });

  it('keeps envelope fields over event data', () => {
    const inbox = mcpPushNotificationToInboxEvent(
      notification({
        data: {
          resourceLink: 'spoofed',
          sourceId: 'spoofed',
          conversationId: 'c-1',
        },
        resourceLink: { uri: 'chat://whatsapp/42' },
      }),
    );

    expect(inbox.context.metadata).toMatchObject({
      resourceLink: 'chat://whatsapp/42',
      sourceId: 'chat-42',
      conversationId: 'c-1',
    });
  });

  it('prefixes the event id with the namespace', () => {
    const inbox = mcpPushNotificationToInboxEvent(notification());

    expect(inbox.eventId).toBe('whatsapp:e1');
    expect(inbox.sourceEnv).toBe('whatsapp');
  });

  describe.each([
    { namespace: 'slack', senderId: 'U012345' },
    { namespace: 'chat', senderId: '7e0e9353-7d5e-4b71-8c64-2f267c26951a' },
  ])('$namespace message senders', ({ namespace, senderId }) => {
    it.each(['hello', 'From: Julian\n\nhello'])(
      'renders the canonical name exactly once for %j',
      (text) => {
        const event = notification({
          type: 'chat.message.received',
          data: {
            senderId,
            senderName: 'Julian',
            senderHeader: trustedSenderHeader,
          },
          content: [{ type: 'text', text }],
        });
        event.namespace = namespace;

        const inbox = mcpPushNotificationToInboxEvent(event);

        expect(inbox.context.content).toEqual([
          { type: 'text', text: 'From: Julian\n\nhello' },
        ]);
        expect(inbox.context.metadata).toMatchObject({
          senderId,
          senderName: 'Julian',
          senderHeader: trustedSenderHeader,
        });
        expect(event.event.content).toEqual([{ type: 'text', text }]);
      },
    );

    it.each([
      'From: this is message text',
      'From: this is user text\nhello',
      `From: ${senderId}\nhello`,
      'From: Julian extra text\nhello',
      'From: Julian \nhello',
      'From: Julian',
      'From: Julian\n\nhello',
    ])('preserves a body beginning with an unmatched From line %j', (text) => {
      const event = notification({
        type: 'chat.message.received',
        data: { senderId, senderName: 'Julian' },
        content: [{ type: 'text', text }],
      });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);

      expect(inbox.context.content).toEqual([
        { type: 'text', text: `From: Julian\n\n${text}` },
      ]);
      expect(inbox.context.metadata).toMatchObject({
        senderId,
        senderName: 'Julian',
        senderHeader: trustedSenderHeader,
      });
      expect(event.event.content).toEqual([{ type: 'text', text }]);
    });

    it.each(
      [undefined, '', '   ', null, 42, false, {}, []].map((senderName) => ({
        senderName,
      })),
    )(
      'uses Unknown sender rather than the ID for name %j',
      ({ senderName }) => {
        const event = notification({
          type: 'chat.message.received',
          data: {
            senderId,
            ...(senderName === undefined ? {} : { senderName }),
          },
          content: [{ type: 'text', text: `From: ${senderId}\nhello` }],
        });
        event.namespace = namespace;

        const inbox = mcpPushNotificationToInboxEvent(event);

        expect(inbox.context.content).toEqual([
          {
            type: 'text',
            text: `From: Unknown sender\n\nFrom: ${senderId}\nhello`,
          },
        ]);
        expect(inbox.context.metadata).toMatchObject({
          senderId,
          senderName: 'Unknown sender',
          senderHeader: trustedSenderHeader,
        });
        expect(event.event.data?.senderName).toEqual(senderName);
      },
    );

    it('handles legacy events without data', () => {
      const event = notification({ type: 'chat.message.received' });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);
      expect(inbox.context.content).toEqual([
        { type: 'text', text: 'From: Unknown sender\n\nhello' },
      ]);
      expect(inbox.context.metadata?.senderName).toBe('Unknown sender');
      expect(inbox.context.metadata?.senderHeader).toEqual(trustedSenderHeader);
      expect(inbox.context.metadata).not.toHaveProperty('senderId');
    });

    it('keeps a marked Unknown sender header for a missing name', () => {
      const event = notification({
        type: 'chat.message.received',
        data: { senderId, senderHeader: trustedSenderHeader },
        content: [{ type: 'text', text: 'From: Unknown sender\n\nhello' }],
      });
      event.namespace = namespace;
      const original = structuredClone(event);

      const inbox = mcpPushNotificationToInboxEvent(event);

      expect(inbox.context.content).toEqual(event.event.content);
      expect(inbox.context.metadata).toMatchObject({
        senderId,
        senderName: 'Unknown sender',
        senderHeader: trustedSenderHeader,
      });
      expect(event).toEqual(original);
    });

    it('matches a marked header against the sanitized name', () => {
      const event = notification({
        type: 'chat.message.received',
        data: {
          senderId,
          senderName: ' Ju\u0000lian\r\nDoe\u202e ',
          senderHeader: trustedSenderHeader,
        },
        content: [{ type: 'text', text: 'From: Julian Doe\n\nhello' }],
      });
      event.namespace = namespace;
      const original = structuredClone(event);

      const inbox = mcpPushNotificationToInboxEvent(event);

      expect(inbox.context.content).toEqual(event.event.content);
      expect(inbox.context.metadata).toMatchObject({
        senderId,
        senderName: 'Julian Doe',
        senderHeader: trustedSenderHeader,
      });
      expect(event).toEqual(original);
    });

    it.each([
      'From: Kristine',
      'From: Kristine\n\n',
      'From: Kristine\n\nhello',
    ])('keeps a marked canonical header exactly once for %j', (text) => {
      const content = [
        { type: 'text' as const, text },
        { type: 'text' as const, text: 'hello' },
      ];
      const event = notification({
        type: 'chat.message.received',
        data: {
          senderId,
          senderName: 'Kristine',
          senderHeader: trustedSenderHeader,
        },
        content,
      });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);

      expect(inbox.context.content).toEqual(content);
      expect(inbox.context.metadata).toMatchObject({
        senderId,
        senderName: 'Kristine',
        senderHeader: trustedSenderHeader,
      });
      expect(
        mcpPushNotificationToInboxEvent({
          ...event,
          event: {
            ...event.event,
            data: inbox.context.metadata,
            content: inbox.context.content.filter(
              (block) => block.type === 'text',
            ),
          },
        }).context.content,
      ).toEqual(content);
    });

    it('trims the visible and metadata names while preserving IDs and body From lines', () => {
      const event = notification({
        type: 'chat.message.received',
        data: { senderId, senderName: ' Julian ' },
        content: [{ type: 'text', text: 'hello\nFrom: quoted message' }],
      });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);

      expect(inbox.context.content).toEqual([
        { type: 'text', text: 'From: Julian\n\nhello\nFrom: quoted message' },
      ]);
      expect(inbox.context.metadata).toMatchObject({
        senderId,
        senderName: 'Julian',
      });
      expect(event.event.data).toEqual({ senderId, senderName: ' Julian ' });
    });

    it.each<{ senderHeader: ContextMetadataValue | undefined }>([
      { senderHeader: undefined },
      { senderHeader: null },
      { senderHeader: false },
      { senderHeader: 1 },
      { senderHeader: 'stagewise.sender-header' },
      { senderHeader: [] },
      { senderHeader: {} },
      { senderHeader: { type: 'stagewise.sender-header' } },
      { senderHeader: { version: 1 } },
      { senderHeader: { type: 'other', version: 1 } },
      { senderHeader: { type: 'stagewise.sender-header', version: 2 } },
      { senderHeader: { type: 'stagewise.sender-header', version: '1' } },
      { senderHeader: { ...trustedSenderHeader, extra: true } },
    ])(
      'preserves a matching-looking body for invalid marker %j',
      ({ senderHeader }) => {
        const text =
          'From: Julian\n\nFrom: this is message text\r\n\u0000body\u2028';
        const event = notification({
          type: 'chat.message.received',
          data: {
            senderId,
            senderName: 'Julian',
            ...(senderHeader === undefined ? {} : { senderHeader }),
          },
          content: [{ type: 'text', text }],
        });
        event.namespace = namespace;
        const original = structuredClone(event);

        const inbox = mcpPushNotificationToInboxEvent(event);

        expect(inbox.context.content).toEqual([
          { type: 'text', text: `From: Julian\n\n${text}` },
        ]);
        expect(inbox.context.metadata).toMatchObject({
          senderId,
          senderName: 'Julian',
          senderHeader: trustedSenderHeader,
        });
        expect(event).toEqual(original);
      },
    );

    it.each([
      'From: Someone else\n\nhello',
      'From: Julian extra text\n\nhello',
      'From: Julian\nhello',
      'From: Julian\n \nhello',
      'From: Julian\r\n\r\nhello',
      'From: Julian\n',
      'From: Julian\r',
      'From: Julian\u2028\u2028hello',
    ])(
      'preserves marked content with a mismatched header or boundary %j',
      (text) => {
        const event = notification({
          type: 'chat.message.received',
          data: {
            senderId,
            senderName: 'Julian',
            senderHeader: trustedSenderHeader,
          },
          content: [{ type: 'text', text }],
        });
        event.namespace = namespace;
        const original = structuredClone(event);

        const inbox = mcpPushNotificationToInboxEvent(event);

        expect(inbox.context.content).toEqual([
          { type: 'text', text: `From: Julian\n\n${text}` },
        ]);
        expect(inbox.context.metadata).toMatchObject({
          senderId,
          senderName: 'Julian',
          senderHeader: trustedSenderHeader,
        });
        expect(event).toEqual(original);
      },
    );

    it.each([
      [' A\r\nB\rC\nD\u2028E\u2029F ', 'A B C D E F'],
      ['Julian\nFrom: Someone else', 'Julian From: Someone else'],
      ['\u0000A\tB\u0085C\u007fD\u009f', 'ABCD'],
      [
        'A\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069B',
        'AB',
      ],
      ['\r\n\u0000\u2028\u2029\u202e', 'Unknown sender'],
      ['\u200b', 'Unknown sender'],
      ['\u200d', 'Unknown sender'],
      [' \u200b \u200d ', 'Unknown sender'],
      [`${'\u200b'.repeat(256)}visible`, 'Unknown sender'],
      ['😀'.repeat(257), '😀'.repeat(256)],
      [`${'A'.repeat(255)} B`, 'A'.repeat(255)],
      ['👩\u200d💻', '👩\u200d💻'],
    ])(
      'sanitizes sender name %j to %j without changing the ID or body',
      (senderName, normalizedName) => {
        const opaqueId = `${senderId}\u0000\u202e\r\n`;
        const text = 'From: this is message text\r\n\u0000body\u2028\u202e';
        const event = notification({
          type: 'chat.message.received',
          data: {
            senderId: opaqueId,
            senderName,
            senderHeader: trustedSenderHeader,
          },
          content: [{ type: 'text', text }],
        });
        event.namespace = namespace;
        const original = structuredClone(event);

        const inbox = mcpPushNotificationToInboxEvent(event);

        expect(inbox.context.content).toEqual([
          { type: 'text', text: `From: ${normalizedName}\n\n${text}` },
        ]);
        expect(inbox.context.metadata).toMatchObject({
          senderId: opaqueId,
          senderName: normalizedName,
          senderHeader: trustedSenderHeader,
        });
        expect(event).toEqual(original);
      },
    );

    it.each([
      { content: [] },
      {
        content: [
          { type: 'image' as const, mimeType: 'image/png', data: 'aQ==' },
        ],
      },
    ])('prepends the sender before non-text content %j', ({ content }) => {
      const event = notification({
        type: 'chat.message.received',
        data: {
          senderId,
          senderName: 'Julian',
          senderHeader: trustedSenderHeader,
        },
        content,
      });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);
      expect(inbox.context.content).toEqual([
        { type: 'text', text: 'From: Julian' },
        ...content,
      ]);
      expect(inbox.context.metadata?.senderHeader).toEqual(trustedSenderHeader);
    });
  });

  it.each([
    ['whatsapp', 'chat.message.received', ' Julian '],
    ['slack', 'message', ' Julian '],
    ['chat', 'chat.message.updated', ' Julian '],
    ['whatsapp', 'chat.message.received', null],
    ['slack', 'message', null],
    ['chat', 'chat.message.updated', null],
  ] as const)(
    'leaves %s %s content and metadata unchanged for name %j',
    (namespace, type, senderName) => {
      const event = notification({
        type,
        data: {
          senderId: 'U012345',
          senderName,
          senderHeader: { type: 'other', version: 2 },
        },
      });
      event.namespace = namespace;

      const inbox = mcpPushNotificationToInboxEvent(event);
      expect(inbox.context.content).toEqual(event.event.content);
      expect(inbox.context.metadata).toMatchObject({
        senderId: 'U012345',
        senderName,
        senderHeader: { type: 'other', version: 2 },
      });
    },
  );
});

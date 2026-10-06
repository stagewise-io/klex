import { describe, expect, it } from 'vitest';

import type { ContextDataUIPart } from '@/session/inbox';

import { mcpPushNotificationToInboxEvent } from '../../extensions/mcp-ingress/push-notification-adapter';
import type { ExtendedUIMessage } from '../../message-types';
import { createTranscriptHistoryView } from './presets';
import { GOLDEN_HISTORY, LONG_HISTORY } from './test-fixtures';

const trustedSenderHeader = {
  type: 'stagewise.sender-header',
  version: 1,
} as const;

// Consult and compaction share the line-format transcript preset.

function compaction(history: typeof GOLDEN_HISTORY): string {
  return createTranscriptHistoryView().render(history).text;
}

function consult(
  history: typeof GOLDEN_HISTORY,
  maxCharacters = 12_000,
  recentMessageLimit = 5,
): string {
  return createTranscriptHistoryView({
    keep: 'newest',
    maxCharacters,
    recentMessageLimit,
  }).render(history).text;
}

describe('golden history views', () => {
  it.each([
    ['whatsapp', 'chat.message.received', '😀'.repeat(256)],
    ['slack', 'other.event', '😀'.repeat(256)],
    ['chat', 'other.event', '😀'.repeat(256)],
    ['slack', 'chat.message.received', 'Julian'],
    ['chat', 'chat.message.received', 'Julian'],
  ])(
    'keeps the ordinary context text cap for %s %s sender %s',
    (namespace, type, senderName) => {
      const content = `From: ${senderName}\n\n${'message body '.repeat(100)}`;
      const { context } = mcpPushNotificationToInboxEvent({
        namespace,
        event: {
          eventId: 'ordinary-limit',
          sourceId: 'channel-1',
          type,
          createdAt: '2026-10-06T10:00:00.000Z',
          data: {
            senderId: 'sender-id',
            senderName,
            senderHeader: trustedSenderHeader,
          },
          content: [{ type: 'text', text: content }],
        },
      });
      const history: ExtendedUIMessage[] = [
        {
          id: 'ordinary-limit',
          role: 'user',
          parts: [{ type: 'data-context', data: context }],
        },
      ];

      expect(
        createTranscriptHistoryView().fit(history).messages[0]?.records,
      ).toEqual([
        {
          kind: 'context',
          source: namespace,
          items: [{ kind: 'text', text: `${content.slice(0, 200)}…` }],
        },
      ]);
    },
  );

  describe.each(['slack', 'chat'])('%s sender context', (namespace) => {
    const longName = '😀'.repeat(256);
    const trustedMetadata = {
      type: 'chat.message.received',
      senderName: longName,
      senderHeader: trustedSenderHeader,
    };

    it.each<{
      label: string;
      metadata: ContextDataUIPart['metadata'];
      headerName?: string;
      boundary?: string;
    }>([
      {
        label: 'missing marker',
        metadata: { type: 'chat.message.received', senderName: longName },
      },
      {
        label: 'wrong marker',
        metadata: {
          ...trustedMetadata,
          senderHeader: { type: 'stagewise.sender-header', version: 2 },
        },
      },
      {
        label: 'extra marker fields',
        metadata: {
          ...trustedMetadata,
          senderHeader: { ...trustedSenderHeader, extra: true },
        },
      },
      {
        label: 'missing name',
        metadata: {
          type: 'chat.message.received',
          senderHeader: trustedSenderHeader,
        },
      },
      {
        label: 'untrimmed name',
        metadata: { ...trustedMetadata, senderName: ` ${longName}` },
        headerName: ` ${longName}`,
      },
      {
        label: 'bidi name',
        metadata: { ...trustedMetadata, senderName: `${longName}\u202e` },
        headerName: `${longName}\u202e`,
      },
      {
        label: 'control name',
        metadata: { ...trustedMetadata, senderName: `${longName}\u0000` },
        headerName: `${longName}\u0000`,
      },
      {
        label: 'overlong name',
        metadata: { ...trustedMetadata, senderName: `${longName}😀` },
        headerName: `${longName}😀`,
      },
      {
        label: 'zero-width-space-only name',
        metadata: { ...trustedMetadata, senderName: '\u200b'.repeat(256) },
        headerName: '\u200b'.repeat(256),
      },
      {
        label: 'ZWJ-only name',
        metadata: { ...trustedMetadata, senderName: '\u200d'.repeat(256) },
        headerName: '\u200d'.repeat(256),
      },
      {
        label: 'mismatched header',
        metadata: trustedMetadata,
        headerName: 'different '.repeat(60),
      },
      {
        label: 'missing blank line',
        metadata: trustedMetadata,
        boundary: '\n',
      },
      {
        label: 'noncanonical line ending',
        metadata: trustedMetadata,
        boundary: '\r\n\r\n',
      },
    ])(
      'retains the ordinary cap for $label',
      ({ metadata, headerName = longName, boundary = '\n\n' }) => {
        const text = `From: ${headerName}${boundary}${'body '.repeat(100)}`;
        const history: ExtendedUIMessage[] = [
          {
            id: 'untrusted-header',
            role: 'user',
            parts: [
              {
                type: 'data-context',
                data: {
                  sourceEnv: namespace,
                  metadata,
                  content: [{ type: 'text', text }],
                },
              },
            ],
          },
        ];

        expect(
          createTranscriptHistoryView().fit(history).messages[0]?.records,
        ).toEqual([
          {
            kind: 'context',
            source: namespace,
            items: [{ kind: 'text', text: `${text.slice(0, 200)}…` }],
          },
        ]);
      },
    );

    it.each(['', '\n\n', '\r\n\r\n'])(
      'preserves a maximal Unicode sender line with Cloud separator %j',
      (separator) => {
        const senderName = '😀'.repeat(256);
        const senderLine = `From: ${senderName}`;
        const body = 'message body '.repeat(100);
        const { context } = mcpPushNotificationToInboxEvent({
          namespace,
          event: {
            eventId: 'long-name',
            sourceId: 'channel-1',
            type: 'chat.message.received',
            createdAt: '2026-10-06T10:00:00.000Z',
            data: {
              senderId: 'sender-id',
              senderName,
              senderHeader: trustedSenderHeader,
            },
            content: [
              {
                type: 'text',
                text: separator ? `${senderLine}${separator}${body}` : body,
              },
              { type: 'text', text: 'additional text '.repeat(100) },
            ],
          },
        });
        const history: ExtendedUIMessage[] = [
          {
            id: 'long-name',
            role: 'user',
            parts: [{ type: 'data-context', data: context }],
          },
        ];

        expect(senderName.length).toBe(512);
        for (const text of [compaction(history), consult(history)]) {
          expect(text.split('\n')).toContain(`¦${senderLine}`);
          expect(text.match(/From:/g)).toHaveLength(1);
          expect(text).not.toContain(body);
          expect(text).toContain(
            `¦${'additional text '.repeat(100).slice(0, 200)}…`,
          );
          expect(text).not.toContain('senderName');
          expect(text).not.toContain('sender-id');
        }
        const budgeted = createTranscriptHistoryView({
          keep: 'newest',
          maxCharacters: 400,
        }).render(history);
        expect(budgeted.text.length).toBeLessThanOrEqual(400);
        expect(budgeted.truncated).toBe(true);
      },
    );

    it.each(['Julian', undefined])(
      'retains sender content without metadata for name %j',
      (senderName) => {
        const { context } = mcpPushNotificationToInboxEvent({
          namespace,
          event: {
            eventId: 'e1',
            sourceId: 'channel-1',
            type: 'chat.message.received',
            createdAt: '2026-10-06T10:00:00.000Z',
            data: {
              senderId: 'U012345',
              ...(senderName === undefined ? {} : { senderName }),
            },
            content: [{ type: 'text', text: 'hello' }],
          },
        });
        const history: ExtendedUIMessage[] = [
          {
            id: 'message-1',
            role: 'user',
            parts: [{ type: 'data-context', data: context }],
          },
        ];

        for (const text of [compaction(history), consult(history)]) {
          expect(text).toContain(
            `¦From: ${senderName ?? 'Unknown sender'}\n¦\n¦hello`,
          );
          expect(text.match(/From:/g)).toHaveLength(1);
          expect(text).not.toContain('U012345');
          expect(text).not.toContain('senderName');
          expect(text).not.toContain('senderId');
        }
      },
    );
  });

  it('compaction transcript over full history', () => {
    expect(compaction(GOLDEN_HISTORY)).toMatchSnapshot();
  });

  it('compaction transcript from the latest summary', () => {
    expect(compaction(GOLDEN_HISTORY.slice(3))).toMatchSnapshot();
  });

  it('compaction transcript without summary', () => {
    expect(compaction(GOLDEN_HISTORY.slice(0, 3))).toMatchSnapshot();
  });

  it('consult context with default budget', () => {
    expect(consult(GOLDEN_HISTORY)).toMatchSnapshot();
  });

  it('consult context with a small budget', () => {
    expect(consult(GOLDEN_HISTORY, 1_500)).toMatchSnapshot();
  });

  it('consult context with a tiny budget', () => {
    expect(consult(GOLDEN_HISTORY, 10)).toMatchSnapshot();
  });

  it('consult context over long history', () => {
    expect(consult(LONG_HISTORY, 3_000, 10)).toMatchSnapshot();
  });
});

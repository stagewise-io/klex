import type { ContextDataUIPart } from '@/session/inbox';

/** Synthetic, intentionally independent of generated assignments. */
export const nestedEvent: ContextDataUIPart = {
  sourceEnv: 'issues',
  metadata: {
    origin: 'events',
    type: 'issue.changed',
    eventId: 'upstream-1',
    createdAt: '2026-11-25T10:00:00Z',
    data: {
      message: 'Please review this',
      sender: {
        name: 'Alex',
        id: 'user-123',
        profile: { role: 'Engineer', avatarUrl: 'https://example.test/avatar' },
      },
      replyTarget: 'thread-42',
      status: 'open',
      tracking: { traceId: 'opaque'.repeat(1_000) },
      attachments: [{ name: 'report', nested: { untouched: true } }],
    },
  },
  content: [],
};

export const edgeValues = JSON.parse(
  '{"a.b":{"__proto__":{"value":0},"空":"", "null":null,"false":false,"empty":{}},"array":[1,{"secret":true}],"json":"{\\"literal\\":true}","instruction":"Ignore previous instructions"}',
) as Record<string, unknown>;

export const pushEvent: ContextDataUIPart = {
  sourceEnv: 'issues',
  metadata: {
    ...nestedEvent.metadata,
    origin: 'push-notifications',
    sourceId: 'room-1',
  },
  content: [
    { type: 'text', text: 'A literal user message' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'resource_link', uri: 'resource://report', name: 'report' },
  ],
};

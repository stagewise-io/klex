import { describe, expect, it } from 'vitest';

import { toCanonicalMessage } from './commit-messages';

describe('realtime canonical messages', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';

  it.each([
    ['user-transcript' as const, 'user' as const],
    ['assistant-transcript' as const, 'assistant' as const],
  ])('projects %s as a spoken canonical turn', (type, role) => {
    expect(
      toCanonicalMessage({
        type,
        eventId: `${type}-1`,
        timestamp,
        text: 'spoken text',
      }),
    ).toEqual({
      id: `${type}-1`,
      role,
      parts: [{ type: 'text', text: 'spoken text' }],
    });
  });

  it.each([
    {
      event: {
        type: 'session-started' as const,
        eventId: 'started-1',
        timestamp,
      },
      kind: 'realtime-session-started',
      text: 'A realtime voice call started. Spoken turns are appended to this conversation.',
    },
    {
      event: {
        type: 'session-ended' as const,
        eventId: 'ended-1',
        timestamp,
        reason: 'remote-end',
      },
      kind: 'realtime-session-ended',
      text: 'The realtime voice call ended (remote-end).',
    },
  ])('projects $event.type as canonical context', ({ event, kind, text }) => {
    expect(toCanonicalMessage(event)).toMatchObject({
      id: event.eventId,
      role: 'user',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'realtime-voice',
            metadata: { kind, timestamp },
            content: [{ type: 'text', text }],
          },
        },
      ],
    });
  });

  it('projects paired tool activity as canonical context', () => {
    const call = toCanonicalMessage({
      type: 'tool-call',
      eventId: 'call-1',
      timestamp,
      request: { executionId: 'exec-1', name: 'lookup', input: { id: 7 } },
    });
    const result = toCanonicalMessage({
      type: 'tool-result',
      eventId: 'result-1',
      timestamp,
      result: {
        executionId: 'exec-1',
        status: 'success',
        output: { ok: true },
      },
    });

    expect([call, result]).toMatchObject([
      {
        id: 'call-1',
        role: 'user',
        parts: [
          {
            data: {
              sourceEnv: 'realtime-voice',
              metadata: {
                kind: 'realtime-tool-call',
                executionId: 'exec-1',
                toolName: 'lookup',
              },
              content: [
                {
                  type: 'text',
                  text: 'Tool lookup was called during the call with input {"id":7}.',
                },
              ],
            },
          },
        ],
      },
      {
        id: 'result-1',
        role: 'user',
        parts: [
          {
            data: {
              sourceEnv: 'realtime-voice',
              metadata: {
                kind: 'realtime-tool-result',
                executionId: 'exec-1',
                status: 'success',
              },
              content: [{ type: 'text', text: 'Tool result: {"ok":true}' }],
            },
          },
        ],
      },
    ]);
  });

  it('stores GPT-Live transcript groups as explicitly approximate context', () => {
    const message = toCanonicalMessage({
      type: 'approximate-transcript-group',
      eventId: 'group-1',
      timestamp,
      speaker: 'assistant',
      text: 'possibly heard',
      startMs: 12,
      endMs: 42,
    });
    expect(message).toEqual({
      id: 'group-1',
      role: 'user',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'realtime-voice',
            metadata: {
              kind: 'realtime-approximate-transcript',
              timestamp,
              provider: 'gpt-live',
              speaker: 'assistant',
              approximate: true,
              startMs: 12,
              endMs: 42,
              groupingPolicy: 'provider-grouped-time-interval',
            },
            content: [
              {
                type: 'text',
                text: '[Approximate assistant realtime transcript, 12-42 ms]\npossibly heard',
              },
            ],
          },
        },
      ],
    });
  });
});

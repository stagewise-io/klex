import { describe, expect, it } from 'vitest';

import {
  createMemoryLoader,
  materializeMemories,
} from '@/session/chat/extensions/memory/loading';
import type { MemoryEntity } from '@/session/chat/extensions/memory/writer/entities';

import { toCanonicalMessage } from './commit-messages';

describe('realtime canonical messages', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';

  it('preserves recall selections as canonical tool evidence rather than escaped context prose', () => {
    const output = {
      answer: 'Ada owns deployment.',
      entities: ['Ada'],
      skills: [],
      entitySections: [{ entity: 'Ada', section: 'Work' }],
      skillReferences: [],
    };
    const result = toCanonicalMessage({
      type: 'tool-result',
      eventId: 'recall-result',
      timestamp,
      result: {
        status: 'success',
        executionId: 'recall-1',
        toolName: 'recallFromMemory',
        output,
      },
    });
    expect(result).toMatchObject({
      id: 'recall-result',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'recallFromMemory',
          toolCallId: 'recall-1',
          state: 'output-available',
          output,
        },
      ],
    });
    expect(result.parts.some((part) => part.type === 'data-context')).toBe(
      false,
    );
  });

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
      metadata: {
        kind: 'realtime-session-started',
        timestamp,
      },
      text: 'A realtime voice call started. Spoken turns are appended to this conversation.',
    },
    {
      event: {
        type: 'session-ended' as const,
        eventId: 'ended-1',
        timestamp,
        reason: 'remote-end',
      },
      metadata: {
        kind: 'realtime-session-ended',
        timestamp,
        reason: 'remote-end',
      },
      text: 'The realtime voice call ended (remote-end).',
    },
    {
      event: {
        type: 'session-ended' as const,
        eventId: 'ended-without-reason-1',
        timestamp,
      },
      metadata: {
        kind: 'realtime-session-ended',
        timestamp,
      },
      text: 'The realtime voice call ended.',
    },
  ])(
    'projects $event.type as canonical context',
    ({ event, metadata, text }) => {
      expect(toCanonicalMessage(event)).toMatchObject({
        id: event.eventId,
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'realtime-voice',
              metadata,
              content: [{ type: 'text', text }],
            },
          },
        ],
      });
    },
  );

  it('preserves genuine section reads for automatic refresh without flattening their body', () => {
    const output = {
      memorySection: 1,
      filename: 'extensions/io.stagewise/memory/entities/person/Ada.md',
      sectionName: 'Work',
      snapshot: JSON.stringify({
        version: 1,
        kind: 'detail',
        title: 'Ada',
        section: 'Work',
        sections: [],
        body: 'Private detail',
      }),
    };
    const event = {
      type: 'tool-result' as const,
      eventId: 'read',
      timestamp,
      result: {
        executionId: 'exec',
        status: 'success' as const,
        toolName: 'readMemorySection',
        output,
      },
    };
    expect(toCanonicalMessage(event)).toMatchObject({
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'readMemorySection',
          state: 'output-available',
          output,
        },
      ],
    });
    expect(
      toCanonicalMessage({
        ...event,
        result: { ...event.result, toolName: 'other' },
      }).role,
    ).toBe('user');
  });

  it('refreshes a realtime section at the next prepared context boundary', async () => {
    const filename = 'extensions/io.stagewise/memory/entities/person/Ada.md';
    const current = {
      id: 'person/Ada',
      name: 'Ada',
      entityType: 'person',
      frontmatter: {
        LoadOn: [],
        LinkedIdentities: [],
        RelatedTo: [],
        Tags: ['people'],
      },
      sections: {
        General: [{ text: 'Base secret' }],
        Work: [{ text: 'Old detail' }],
      },
    } as unknown as MemoryEntity;
    const loader = createMemoryLoader({
      entities: { snapshot: async () => [current] },
      skills: { snapshot: async () => [] },
      logger: { debug: () => {}, warn: () => {} } as never,
    });
    const execute = loader.tools.readMemorySection!.execute! as unknown as (
      input: { entity: string; sectionName: string },
      options: { toolCallId: string; messages: [] },
    ) => Promise<{
      memorySection: number;
      filename: string;
      sectionName: string;
      snapshot: string;
    }>;
    const output = await execute(
      { entity: current.id, sectionName: 'Work' },
      { toolCallId: 'read', messages: [] },
    );
    const read = toCanonicalMessage({
      type: 'tool-result',
      eventId: 'read',
      timestamp,
      result: {
        executionId: 'read',
        status: 'success',
        toolName: 'readMemorySection',
        output,
      },
    });
    current.sections.Work = [{ text: 'New detail', sources: [], history: [] }];
    const latest = {
      id: 'next',
      role: 'user' as const,
      parts: await loader.prepare([read], {
        modelId: 'test',
        displayName: 'Test',
        contextSize: 128000,
        inputCapabilities: {},
      }),
    };
    const rendered = JSON.stringify(materializeMemories([read, latest]));
    expect(rendered).toContain('New detail');
    expect(rendered).not.toContain('Base secret');
    expect(rendered).not.toContain('<memory filename');
    expect(
      JSON.stringify(
        await loader.prepare([], {
          modelId: 'test',
          displayName: 'Test',
          contextSize: 128000,
          inputCapabilities: {},
        }),
      ),
    ).not.toContain('New detail');
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

  it('projects failed tool results as canonical context', () => {
    const result = toCanonicalMessage({
      type: 'tool-result',
      eventId: 'result-failed-1',
      timestamp,
      result: {
        executionId: 'exec-failed-1',
        status: 'error',
        code: 'timeout',
        error: 'Lookup timed out',
        retryable: true,
      },
    });

    expect(result).toMatchObject({
      role: 'user',
      parts: [
        {
          data: {
            metadata: {
              kind: 'realtime-tool-result',
              executionId: 'exec-failed-1',
              status: 'error',
            },
            content: [
              {
                type: 'text',
                text: 'Tool failed (timeout): Lookup timed out',
              },
            ],
          },
        },
      ],
    });
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

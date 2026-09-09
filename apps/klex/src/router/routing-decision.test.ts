import type { LanguageModelV4 } from '@ai-sdk/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelSelectionEntry } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';
import type { ContextMetadataValue, SessionInboxEvent } from '@/session/inbox';
import { SessionInboxUrgency } from '@/session/inbox';

import {
  buildContentPreview,
  callRoutingLlm,
  flattenMetadata,
  mapPriority,
  matchesRule,
  sameMatch,
} from './routing-decision';

// --- mocks ---

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: generateObjectMock,
}));

vi.mock('./routing-system-prompt.md', () => ({
  default: 'mock routing system prompt',
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// --- helpers ---

function makeModel(): LanguageModelV4 {
  return {
    modelId: 'test:model',
    specificationVersion: 'v4',
    provider: 'test',
    doGenerate: vi.fn(),
  } as unknown as LanguageModelV4;
}

function makeModelProvider(
  models: Map<string, LanguageModelV4> = new Map(),
): ProviderModelResolver {
  return {
    getLanguageModel: vi.fn((entry: ModelSelectionEntry) => {
      const m = models.get(`${entry.providerId}:${entry.modelId}`);
      if (!m)
        throw new Error(`Unknown model: ${entry.providerId}:${entry.modelId}`);
      return m;
    }),
    resolveModel: vi.fn(),
    resolveModelInfo: vi.fn(),
  } as unknown as ProviderModelResolver;
}

function makeParams(
  overrides: Partial<Parameters<typeof callRoutingLlm>[0]> = {},
) {
  return {
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as never,
    modelProvider: makeModelProvider(
      new Map([['test:test:model-a', makeModel()]]),
    ),
    routingModels: [
      { providerId: 'test', modelId: 'test:model-a' },
    ] as ModelSelectionEntry[],
    sessions: [],
    eventMetadata: {},
    sourceEnv: 'test-env',
    contentPreview: '',
    ...overrides,
  };
}

function genSuccess(obj: Record<string, unknown>) {
  return {
    object: obj,
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeEvent(
  overrides: Partial<{
    sourceEnv: string;
    metadata: Record<string, unknown>;
  }> = {},
): SessionInboxEvent {
  return {
    sourceEnv: overrides.sourceEnv ?? 'telegram',
    context: {
      sourceEnv: overrides.sourceEnv ?? 'telegram',
      metadata: (overrides.metadata ?? {}) as Record<string, never>,
      content: [{ type: 'text', text: 'hello' }],
    },
  };
}

// ---------------------------------------------------------------------------
// callRoutingLlm tests
// ---------------------------------------------------------------------------

describe('callRoutingLlm', () => {
  it('returns null when routingModels is empty', async () => {
    const params = makeParams({ routingModels: [] });
    const result = await callRoutingLlm(params);
    expect(result).toBeNull();
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('returns the decision from a successful model call', async () => {
    const decision = {
      decision: 'new_conversation' as const,
      sessionId: '',
      routingRule: { chatId: '123' },
      priority: 'medium' as const,
    };
    generateObjectMock.mockResolvedValueOnce(genSuccess(decision));

    const params = makeParams();
    const result = await callRoutingLlm(params);
    expect(result).toEqual(decision);
    expect(generateObjectMock).toHaveBeenCalledOnce();
  });

  it('falls back to the next model when the first fails', async () => {
    const decision = {
      decision: 'existing_session' as const,
      sessionId: 'a1b2',
      routingRule: {},
      priority: 'low' as const,
    };
    generateObjectMock
      .mockRejectedValueOnce(new Error('model A failed'))
      .mockResolvedValueOnce(genSuccess(decision));

    const modelA = makeModel();
    const modelB = makeModel();
    const models = new Map<string, LanguageModelV4>([
      ['test:test:model-a', modelA],
      ['test:test:model-b', modelB],
    ]);

    const params = makeParams({
      routingModels: [
        { providerId: 'test', modelId: 'test:model-a' },
        { providerId: 'test', modelId: 'test:model-b' },
      ],
      modelProvider: makeModelProvider(models),
    });
    const result = await callRoutingLlm(params);
    expect(result).toEqual(decision);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(params.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'test:model-a' }),
      'Routing LLM model failed — trying next',
    );
  });

  it('returns null when all models fail', async () => {
    generateObjectMock
      .mockRejectedValueOnce(new Error('model A failed'))
      .mockRejectedValueOnce(new Error('model B failed'));

    const modelA = makeModel();
    const modelB = makeModel();
    const models = new Map<string, LanguageModelV4>([
      ['test:test:model-a', modelA],
      ['test:test:model-b', modelB],
    ]);

    const params = makeParams({
      routingModels: [
        { providerId: 'test', modelId: 'test:model-a' },
        { providerId: 'test', modelId: 'test:model-b' },
      ],
      modelProvider: makeModelProvider(models),
    });
    const result = await callRoutingLlm(params);
    expect(result).toBeNull();
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(params.logger.warn).toHaveBeenCalledWith(
      'All routing models failed — falling back to default routing',
    );
  });

  it('passes compact session info and event metadata in the prompt', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const sessions = [
      {
        shortId: 'a1b2',
        runtimeState: 'idle',
        activitySummary: null,
      },
    ];
    const eventMetadata = { type: 'message', count: 5 };

    const params = makeParams({
      sessions,
      eventMetadata,
      sourceEnv: 'slack',
      contentPreview: 'hello world…',
    });

    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    // Compact keys: id, act, state. Defaults omitted (idle/null).
    expect(prompt.sessions[0]).toEqual({ id: 'a1b2' });
    expect(prompt.event.sourceEnv).toBe('slack');
    // Flattened to dot-notation, values stringified.
    expect(prompt.event.metadata).toEqual({
      type: 'message',
      count: '5',
    });
    expect(prompt.event.preview).toBe('hello world…');
  });

  it('passes telemetry options to generateObject', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const params = makeParams({
      routingModels: [{ providerId: 'test', modelId: 'test:model-a' }],
    });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    expect(callArgs.telemetry).toEqual({
      isEnabled: true,
      functionId: 'router',
    });
  });

  it('truncates activitySummary to 200 characters', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const longSummary = 'A'.repeat(250);
    const sessions = [
      {
        shortId: 'f4g5',
        runtimeState: 'idle',
        activitySummary: longSummary,
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.sessions[0].act).toHaveLength(200);
    expect(prompt.sessions[0].act).toBe('A'.repeat(200));
  });

  it('flattens and caps incoming event metadata to 20 keys', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    // 25 flat keys — only first 20 should appear.
    const eventMetadata: Record<string, ContextMetadataValue> = {};
    for (let i = 0; i < 25; i++) {
      eventMetadata[`k${i}`] = `v${i}`;
    }

    const params = makeParams({ eventMetadata });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(Object.keys(prompt.event.metadata)).toHaveLength(20);
  });

  it('flattens nested event metadata to dot-notation', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const eventMetadata = { user: { id: '42', name: 'Alice' } };

    const params = makeParams({ eventMetadata });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.event.metadata).toEqual({
      'user.id': '42',
      'user.name': 'Alice',
    });
  });

  it('emits state when runtimeState is non-idle but never emits status', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const sessions = [
      {
        shortId: 'e5f6',
        runtimeState: 'working',
        activitySummary: null,
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.sessions[0].state).toBe('working');
    expect(prompt.sessions[0].status).toBeUndefined();
  });

  it('includes activitySummary as act in the prompt when set', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      }),
    );

    const sessions = [
      {
        shortId: 'a1b2',
        runtimeState: 'idle',
        activitySummary:
          'Reviewing PR #42 in klex-agent; notified chat 999 on Telegram',
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.sessions[0].act).toBe(
      'Reviewing PR #42 in klex-agent; notified chat 999 on Telegram',
    );
  });
});

// ---------------------------------------------------------------------------
// matchesRule tests
// ---------------------------------------------------------------------------

describe('matchesRule', () => {
  it('returns true when all rule pairs match flat metadata', () => {
    const event = makeEvent({ metadata: { chatId: '123', senderId: 'u1' } });
    const rule = { chatId: '123' };
    expect(matchesRule(event, rule)).toBe(true);
  });

  it('returns true when rule is a subset of metadata (event has extra keys)', () => {
    const event = makeEvent({
      metadata: { chatId: '123', senderId: 'u1', extra: 'x' },
    });
    const rule = { chatId: '123' };
    expect(matchesRule(event, rule)).toBe(true);
  });

  it('returns false when any rule pair has a different value', () => {
    const event = makeEvent({ metadata: { chatId: '456' } });
    const rule = { chatId: '123' };
    expect(matchesRule(event, rule)).toBe(false);
  });

  it('returns false when a rule key is absent from metadata', () => {
    const event = makeEvent({ metadata: { chatId: '123' } });
    const rule = { threadId: 't1' };
    expect(matchesRule(event, rule)).toBe(false);
  });

  it('handles nested metadata by flattening to dot-notation', () => {
    const event = makeEvent({
      metadata: { chat: { id: '123', threadId: 't1' } },
    });
    const rule = { 'chat.id': '123' };
    expect(matchesRule(event, rule)).toBe(true);
  });

  it('returns true when rule match is empty (matches everything)', () => {
    const event = makeEvent({ metadata: { chatId: '123' } });
    const rule = {};
    expect(matchesRule(event, rule)).toBe(true);
  });

  it('returns false when metadata is empty but rule has pairs', () => {
    const event = makeEvent({ metadata: {} });
    const rule = { chatId: '123' };
    expect(matchesRule(event, rule)).toBe(false);
  });

  it('matches multiple pairs in nested metadata', () => {
    const event = makeEvent({
      metadata: { identityId: '456', conversation: { id: '789' } },
    });
    const rule = { identityId: '456', 'conversation.id': '789' };
    expect(matchesRule(event, rule)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sameMatch tests
// ---------------------------------------------------------------------------

describe('sameMatch', () => {
  it('returns true for identical objects', () => {
    expect(sameMatch({ chatId: '123' }, { chatId: '123' })).toBe(true);
  });

  it('returns true regardless of key order', () => {
    expect(
      sameMatch(
        { chatId: '123', threadId: 't1' },
        { threadId: 't1', chatId: '123' },
      ),
    ).toBe(true);
  });

  it('returns false when values differ', () => {
    expect(sameMatch({ chatId: '123' }, { chatId: '456' })).toBe(false);
  });

  it('returns false when keys differ', () => {
    expect(sameMatch({ chatId: '123' }, { threadId: '123' })).toBe(false);
  });

  it('returns true for two empty objects', () => {
    expect(sameMatch({}, {})).toBe(true);
  });

  it('returns false when one has extra keys', () => {
    expect(
      sameMatch({ chatId: '123' }, { chatId: '123', threadId: 't1' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// flattenMetadata tests
// ---------------------------------------------------------------------------

describe('flattenMetadata', () => {
  it('flattens flat metadata as-is', () => {
    expect(flattenMetadata({ a: '1', b: '2' })).toEqual({ a: '1', b: '2' });
  });

  it('flattens nested objects to dot-notation', () => {
    expect(flattenMetadata({ user: { id: '42', name: 'Alice' } })).toEqual({
      'user.id': '42',
      'user.name': 'Alice',
    });
  });

  it('skips null and undefined values', () => {
    expect(
      flattenMetadata({
        a: null,
        b: 'x',
        c: undefined as unknown as ContextMetadataValue,
      }),
    ).toEqual({ b: 'x' });
  });

  it('stringifies arrays as JSON', () => {
    expect(flattenMetadata({ tags: ['a', 'b'] })).toEqual({
      tags: '["a","b"]',
    });
  });

  it('stringifies numbers and booleans', () => {
    expect(flattenMetadata({ count: 5, active: true })).toEqual({
      count: '5',
      active: 'true',
    });
  });
});

// ---------------------------------------------------------------------------
// buildContentPreview tests
// ---------------------------------------------------------------------------

describe('buildContentPreview', () => {
  it('builds preview from text blocks', () => {
    expect(
      buildContentPreview([
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'foo' },
      ]),
    ).toBe('hello world foo');
  });

  it('truncates long text to 32 chars with ellipsis', () => {
    const long = 'A'.repeat(50);
    expect(buildContentPreview([{ type: 'text', text: long }])).toBe(
      `${'A'.repeat(32)}…`,
    );
  });

  it('builds preview from mixed block types', () => {
    expect(
      buildContentPreview([
        { type: 'text', text: 'hi' },
        { type: 'image', mimeType: 'image/png', data: 'x' },
        {
          type: 'resource_link',
          uri: 'file:///x',
          name: 'x.txt',
        },
        {
          type: 'resource',
          resource: { uri: 'file:///y' },
        },
      ]),
    ).toBe('hi [image] [resource_link: x.txt] [resource: file:///y]');
  });

  it('estimates audio duration from base64 data length', () => {
    // 160000 base64 chars ≈ 120000 bytes ≈ ~7.5 seconds at 16000 bytes/sec
    const data = 'A'.repeat(160000);
    const preview = buildContentPreview([
      { type: 'audio', mimeType: 'audio/ogg', data },
    ]);
    expect(preview).toMatch(/^\[audio: \d+sec\]$/);
  });
});

// ---------------------------------------------------------------------------
// mapPriority tests
// ---------------------------------------------------------------------------

describe('mapPriority', () => {
  it('maps high to Critical', () => {
    expect(mapPriority('high')).toBe(SessionInboxUrgency.Critical);
  });

  it('maps medium to Default', () => {
    expect(mapPriority('medium')).toBe(SessionInboxUrgency.Default);
  });

  it('maps low to Deferrable', () => {
    expect(mapPriority('low')).toBe(SessionInboxUrgency.Deferrable);
  });
});

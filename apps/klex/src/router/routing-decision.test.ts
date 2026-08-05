import type { LanguageModelV4 } from '@ai-sdk/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { ContextMetadataValue } from '@/session/inbox';

import {
  analyzeEventPatterns,
  callRoutingLlm,
  type EventLogEntry,
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
  models: Map<ModelId, LanguageModelV4> = new Map(),
): ModelProvider {
  return {
    get: vi.fn(async (id: ModelId) => {
      const m = models.get(id);
      if (!m) throw new Error(`Unknown model: ${id}`);
      return m;
    }),
    start: vi.fn(),
    close: vi.fn(),
  } as unknown as ModelProvider;
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
    modelProvider: makeModelProvider(new Map([['test:model-a', makeModel()]])),
    routingModels: ['test:model-a'] as ModelId[],
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

// --- tests ---

describe('callRoutingLlm', () => {
  it('returns null when routingModels is empty', async () => {
    const params = makeParams({ routingModels: [] });
    const result = await callRoutingLlm(params);
    expect(result).toBeNull();
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('returns the decision from a successful model call', async () => {
    const decision = {
      sessionId: 'a1b2',
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
      sessionId: '',
      priority: 'low' as const,
    };
    generateObjectMock
      .mockRejectedValueOnce(new Error('model A failed'))
      .mockResolvedValueOnce(genSuccess(decision));

    const modelA = makeModel();
    const modelB = makeModel();
    const models = new Map<ModelId, LanguageModelV4>([
      ['test:model-a', modelA],
      ['test:model-b', modelB],
    ]);

    const params = makeParams({
      routingModels: ['test:model-a', 'test:model-b'],
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
    const models = new Map<ModelId, LanguageModelV4>([
      ['test:model-a', modelA],
      ['test:model-b', modelB],
    ]);

    const params = makeParams({
      routingModels: ['test:model-a', 'test:model-b'],
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
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const sessions = [
      {
        shortId: 'a1b2',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 3,
          sourceEnvs: ['telegram'],
          metadataFrequency: {
            chatId: { '12345': 3 },
            senderId: { u1: 1, u2: 1, u3: 1 },
          },
        },
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
    // Compact keys: id, n, envs, freq. Defaults omitted (active/idle/null).
    expect(prompt.sessions[0]).toEqual({
      id: 'a1b2',
      n: 3,
      envs: ['telegram'],
      freq: { chatId: { '12345': 3 }, senderId: { u1: 1, u2: 1, u3: 1 } },
    });
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
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const params = makeParams({
      routingModels: ['test:model-a'],
    });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    expect(callArgs.telemetry).toEqual({
      isEnabled: true,
      functionId: 'router',
    });
  });

  it('omits freq keys that appeared in only one event (no pattern)', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const sessions = [
      {
        shortId: 'c1d2',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 1,
          sourceEnvs: ['github'],
          // Single event with many keys — no pattern emerged.
          metadataFrequency: {
            repo: { 'klex-agent': 1 },
            pr: { '42': 1 },
            author: { alice: 1 },
          },
        },
        activitySummary: null,
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.sessions[0].freq).toBeUndefined();
  });

  it('includes only pattern keys in freq, excludes single-event noise', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const sessions = [
      {
        shortId: 'd2e3',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 4,
          sourceEnvs: ['telegram'],
          metadataFrequency: {
            // Pattern: appeared in 4 events.
            chatId: { '123': 4 },
            // Noise: appeared in only 1 event.
            requestId: { 'r-abc': 1 },
          },
        },
        activitySummary: null,
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    expect(prompt.sessions[0].freq).toEqual({ chatId: { '123': 4 } });
    expect(prompt.sessions[0].freq.requestId).toBeUndefined();
  });

  it('caps freq to top 10 keys by total event count', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const metadataFrequency: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 15; i++) {
      // Keys with decreasing total counts: key0=15, key1=14, ... key14=1
      // Only key0..key9 (total >= 6) qualify by count >= 2 AND top-10.
      metadataFrequency[`key${i}`] = { v: 15 - i };
    }

    const sessions = [
      {
        shortId: 'e3f4',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 120,
          sourceEnvs: ['test'],
          metadataFrequency,
        },
        activitySummary: null,
      },
    ];

    const params = makeParams({ sessions });
    await callRoutingLlm(params);

    const callArgs = generateObjectMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(callArgs.prompt);
    const freqKeys = Object.keys(prompt.sessions[0].freq);
    expect(freqKeys).toHaveLength(10);
    // Top 10 by total count: key0 through key9.
    expect(freqKeys).toEqual(
      expect.arrayContaining([
        'key0',
        'key1',
        'key2',
        'key3',
        'key4',
        'key5',
        'key6',
        'key7',
        'key8',
        'key9',
      ]),
    );
    expect(freqKeys).not.toContain('key10');
  });

  it('truncates activitySummary to 200 characters', async () => {
    generateObjectMock.mockResolvedValueOnce(
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const longSummary = 'A'.repeat(250);
    const sessions = [
      {
        shortId: 'f4g5',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 2,
          sourceEnvs: ['test'],
          metadataFrequency: { topic: { x: 2 } },
        },
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
      genSuccess({ sessionId: '', priority: 'medium' }),
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
      genSuccess({ sessionId: '', priority: 'medium' }),
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
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const sessions = [
      {
        shortId: 'e5f6',
        status: 'active',
        runtimeState: 'working',
        eventPatterns: {
          eventCount: 5,
          sourceEnvs: ['test'],
          metadataFrequency: { topic: { x: 5 } },
        },
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
      genSuccess({ sessionId: '', priority: 'medium' }),
    );

    const sessions = [
      {
        shortId: 'a1b2',
        status: 'active',
        runtimeState: 'idle',
        eventPatterns: {
          eventCount: 1,
          sourceEnvs: ['github'],
          metadataFrequency: { repo: { 'klex-agent': 1 } },
        },
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

// --- analyzeEventPatterns tests ---

describe('analyzeEventPatterns', () => {
  it('returns empty patterns for an empty log', () => {
    const result = analyzeEventPatterns([]);
    expect(result).toEqual({
      eventCount: 0,
      sourceEnvs: [],
      metadataFrequency: {},
    });
  });

  it('counts event totals and source environments', () => {
    const log: EventLogEntry[] = [
      {
        sourceEnv: 'telegram',
        metadata: { chatId: '123' },
        receivedAt: '2026-01-01T00:00:00Z',
      },
      {
        sourceEnv: 'telegram',
        metadata: { chatId: '123' },
        receivedAt: '2026-01-01T00:01:00Z',
      },
      {
        sourceEnv: 'slack',
        metadata: { channelId: 'C456' },
        receivedAt: '2026-01-01T00:02:00Z',
      },
    ];
    const result = analyzeEventPatterns(log);
    expect(result.eventCount).toBe(3);
    expect(result.sourceEnvs).toEqual(
      expect.arrayContaining(['telegram', 'slack']),
    );
    expect(result.sourceEnvs).toHaveLength(2);
  });

  it('counts metadata value frequencies across events', () => {
    const log: EventLogEntry[] = [
      {
        sourceEnv: 'telegram',
        metadata: { chatId: '123', senderId: 'u1' },
        receivedAt: '2026-01-01T00:00:00Z',
      },
      {
        sourceEnv: 'telegram',
        metadata: { chatId: '123', senderId: 'u2' },
        receivedAt: '2026-01-01T00:01:00Z',
      },
      {
        sourceEnv: 'telegram',
        metadata: { chatId: '123', senderId: 'u3' },
        receivedAt: '2026-01-01T00:02:00Z',
      },
    ];
    const result = analyzeEventPatterns(log);
    expect(result.metadataFrequency).toEqual({
      chatId: { '123': 3 },
      senderId: { u1: 1, u2: 1, u3: 1 },
    });
  });

  it('flattens nested metadata objects with dot notation', () => {
    const log: EventLogEntry[] = [
      {
        sourceEnv: 'telegram',
        metadata: { user: { id: '42', name: 'Alice' } },
        receivedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const result = analyzeEventPatterns(log);
    expect(result.metadataFrequency).toEqual({
      'user.id': { '42': 1 },
      'user.name': { Alice: 1 },
    });
  });

  it('skips null and undefined metadata values', () => {
    const log: EventLogEntry[] = [
      {
        sourceEnv: 'test',
        metadata: {
          a: null,
          b: 'x',
          c: undefined as unknown as ContextMetadataValue,
        },
        receivedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const result = analyzeEventPatterns(log);
    expect(result.metadataFrequency).toEqual({ b: { x: 1 } });
  });

  it('handles multiple distinct values for the same key', () => {
    const log: EventLogEntry[] = [
      {
        sourceEnv: 'test',
        metadata: { conversationId: 'A' },
        receivedAt: '2026-01-01T00:00:00Z',
      },
      {
        sourceEnv: 'test',
        metadata: { conversationId: 'B' },
        receivedAt: '2026-01-01T00:01:00Z',
      },
      {
        sourceEnv: 'test',
        metadata: { conversationId: 'A' },
        receivedAt: '2026-01-01T00:02:00Z',
      },
    ];
    const result = analyzeEventPatterns(log);
    expect(result.metadataFrequency.conversationId).toEqual({
      A: 2,
      B: 1,
    });
  });
});

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

  it('passes session info and event metadata in the prompt', async () => {
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
    expect(prompt.sessions).toEqual(sessions);
    expect(prompt.event.sourceEnv).toBe('slack');
    expect(prompt.event.metadata).toEqual(eventMetadata);
    expect(prompt.event.contentPreview).toBe('hello world…');
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

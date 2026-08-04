import type { LanguageModelV4 } from '@ai-sdk/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';

import { callRoutingLlm } from './routing-decision';

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
      summary: 'Handling user messages',
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
        summary: 'Working on auth',
        status: 'active',
        runtimeState: 'idle',
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

import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  Experimental_EvaluationModelV4Result as EvaluationResult,
  LanguageModelV4,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstinctModelCandidate } from '@/provider-registry';

import {
  compileInstinctClassificationBatch,
  createInstinctClassifierEntries,
  type InstinctClassificationCallArgs,
} from './classifier';
import {
  executeInstinctClassification,
  testInstinctOperation,
} from './classifier-executor';

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
function args(
  signal = new AbortController().signal,
  budget = 1000,
): InstinctClassificationCallArgs {
  return {
    ...compileInstinctClassificationBatch(
      createInstinctClassifierEntries([
        {
          extensionIdentifier: 'memory',
          request: {
            prompt: 'Classify facts',
            keys: {
              needed: { type: 'boolean', description: 'Memory needed?' },
              route: {
                type: 'enum',
                description: 'Route',
                values: ['read', 'write'],
              },
            },
          },
        },
      ]),
      '<external-input>synthetic</external-input>',
    ),
    abortSignal: signal,
    deadlineAt: performance.now() + budget,
  };
}
function generation(
  text = '{"memory":{"needed":true,"route":"read"}}',
  modelId = 'generation',
): Extract<InstinctModelCandidate, { api: 'generation' }> {
  return {
    status: 'ready',
    api: 'generation',
    providerType: 'openai',
    entry: {
      api: 'generation',
      modelId,
      providerId: 'test',
      attemptTimeoutMs: 10,
    },
    model: new MockLanguageModelV4({
      doGenerate: vi.fn<LanguageModelV4['doGenerate']>(async (options) => {
        expect(options.temperature).toBe(0);
        return {
          content: [{ type: 'text', text }],
          usage,
          warnings: [],
          finishReason: { unified: 'stop', raw: 'stop' },
        };
      }),
    }),
  };
}
function evaluation(
  doEvaluate: EvaluationModel['doEvaluate'] = vi.fn<
    EvaluationModel['doEvaluate']
  >(async () => ({
    answers: {
      q0: { type: 'boolean', probability: 0.9 },
      q1: { type: 'choice', choice: 'read' },
    },
    usage: { inputTokens: 7, outputTokens: 3 },
    warnings: [],
  })),
): Extract<InstinctModelCandidate, { api: 'evaluation' }> {
  return {
    status: 'ready',
    api: 'evaluation',
    providerType: 'typesafe-ai',
    entry: {
      api: 'evaluation',
      modelId: 'native',
      providerId: 'test',
      attemptTimeoutMs: 10,
    },
    model: {
      specificationVersion: 'v4',
      provider: 'typesafe.evaluation',
      modelId: 'native',
      supportedQuestionTypes: ['boolean', 'choice'],
      doEvaluate,
    },
  };
}
const options = (candidates: readonly InstinctModelCandidate[]) => ({
  candidates,
  functionId: 'operation-test',
  onAttempt: vi.fn(),
});
afterEach(() => vi.useRealTimers());

describe('instinct executor', () => {
  it('uses the same generation path for a single synthetic contract-and-answer check', async () => {
    const candidate = generation(
      '{"core_operation_test":{"markerPresent":true,"markerAbsent":false,"shape":"square"}}',
    );
    const doGenerate = vi.spyOn(candidate.model, 'doGenerate');
    const result = await testInstinctOperation({
      candidate,
      abortSignal: new AbortController().signal,
      deadlineAt: performance.now() + 1000,
    });
    expect(result).toMatchObject({
      api: 'generation',
      contractValid: true,
      expectedAnswersMatch: true,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
      },
    });
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it.each(['generation', 'evaluation'] as const)(
    'falls back from malformed %s to a complete result without mixing fragments',
    async (first) => {
      const gen = generation('not JSON');
      const evalCandidate = evaluation(
        vi.fn(async () => ({ answers: {}, warnings: [] })),
      );
      const opts = options(
        first === 'generation'
          ? [gen, evaluation()]
          : [evalCandidate, generation()],
      );
      const result = await executeInstinctClassification(args(), opts);
      expect(result).toMatchObject({
        status: first === 'generation' ? 'evaluation' : 'ok',
        modelId: first === 'generation' ? 'native' : 'generation',
      });
      expect(
        opts.onAttempt.mock.calls.map(([report]) => report.status),
      ).toEqual(['failed', 'ok']);
      expect(opts.onAttempt.mock.calls[0]?.[0].usage?.inputTokens).toBe(
        first === 'generation' ? 10 : undefined,
      );
    },
  );

  it('retains only the latest generation salvage, but a complete later evaluation wins', async () => {
    const candidates = [
      generation('{"memory":{"needed":true}}', 'old'),
      generation('{"memory":{"needed":false}}', 'latest'),
      evaluation(
        vi.fn(async () => {
          throw new Error('private diagnostic');
        }),
      ),
    ];
    expect(
      await executeInstinctClassification(args(), options(candidates)),
    ).toEqual({
      status: 'partial',
      text: '{"memory":{"needed":false}}',
      modelId: 'latest',
    });
    expect(
      await executeInstinctClassification(
        args(),
        options([...candidates, evaluation()]),
      ),
    ).toMatchObject({ status: 'evaluation', modelId: 'native' });
  });

  it.each(['resolve', 'reject'] as const)(
    'times out an uncooperative transport, tries the next candidate, and ignores late %s',
    async (late) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      let resolve!: (result: EvaluationResult) => void;
      let reject!: (error: Error) => void;
      const transport = vi.fn(
        () =>
          new Promise<EvaluationResult>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const opts = options([evaluation(transport), generation()]);
      const pending = executeInstinctClassification(args(), opts);
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toMatchObject({ status: 'ok' });
      expect(
        opts.onAttempt.mock.calls.map(([report]) => report.status),
      ).toEqual(['timeout', 'ok']);
      const before = opts.onAttempt.mock.calls.slice();
      if (late === 'resolve')
        resolve({
          answers: {
            q0: { type: 'boolean', probability: 1 },
            q1: { type: 'choice', choice: 'write' },
          },
          usage: { inputTokens: 100 },
          warnings: [],
        });
      else reject(new Error('late rejection'));
      await vi.advanceTimersByTimeAsync(0);
      expect(opts.onAttempt.mock.calls).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['caller', 'deadline'] as const)(
    'stops on %s cancellation without fallback or salvage',
    async (cause) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      const controller = new AbortController();
      const stalled = evaluation(
        vi.fn(() => new Promise<EvaluationResult>(() => {})),
      );
      const bounded = {
        ...stalled,
        entry: { ...stalled.entry, attemptTimeoutMs: 1000 },
      };
      const next = generation();
      const nextCall = vi.spyOn(next.model, 'doGenerate');
      const opts = options([
        generation('{"memory":{"needed":true}}'),
        bounded,
        next,
      ]);
      const pending = executeInstinctClassification(
        args(controller.signal, 100),
        opts,
      );
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      if (cause === 'caller') controller.abort(new Error('cancelled'));
      else await vi.advanceTimersByTimeAsync(101);
      await assertion;
      expect(nextCall).not.toHaveBeenCalled();
      expect(opts.onAttempt.mock.calls).toHaveLength(1);
    },
  );

  it('skips declared unsupported question types and oversized options before network work', async () => {
    const evaluate = vi.fn<EvaluationModel['doEvaluate']>();
    const unsupported = evaluation(evaluate);
    const limited = {
      ...unsupported,
      model: {
        ...unsupported.model,
        supportedQuestionTypes: ['boolean'] as const,
      },
    };
    const oversized = {
      ...unsupported,
      entry: {
        ...unsupported.entry,
        providerOptions: { test: { data: 'x'.repeat(128_000) } },
      },
    };
    const opts = options([
      {
        status: 'unavailable',
        entry: unsupported.entry,
        reason: 'unsupported factory',
      },
      limited,
      oversized,
      generation(),
    ]);
    expect(await executeInstinctClassification(args(), opts)).toMatchObject({
      status: 'ok',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

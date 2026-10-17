import '@/ai-sdk-warnings';

import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  Experimental_EvaluationModelV4Result as EvaluationResult,
  LanguageModelV4,
  LanguageModelV4Usage,
  SharedV4Warning,
} from '@ai-sdk/provider';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstinctModelCandidate } from '@/provider-registry';

import {
  compileInstinctClassificationBatch,
  type InstinctClassificationCallArgs,
  normalizeInstinctEvaluation,
} from './classifier';
import { executeInstinctClassification } from './classifier-executor';

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
      [
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
      ],
      '<external-input>synthetic</external-input>',
    ),
    abortSignal: signal,
    deadlineAt: performance.now() + budget,
  };
}
function generation(
  text = '{"q0":0.9,"q1":"read"}',
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
  functionId: 'instinct-classifier',
  onUsage: vi.fn(),
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('instinct executor', () => {
  it('bounds the actual evaluation state including policies and provider options', async () => {
    const candidate = evaluation();
    const call = args();
    const executionOptions = options([candidate]);
    const result = await executeInstinctClassification(
      { ...call, state: 'x'.repeat(128_000) },
      executionOptions,
    );
    expect(result.status).toBe('unavailable');
    expect(executionOptions.onUsage).not.toHaveBeenCalled();
    expect(candidate.model.doEvaluate).not.toHaveBeenCalled();
  });

  it('executes the compact predicate, choice and score batch through the real TypeSafe SDK transport', async () => {
    const batch = compileInstinctClassificationBatch(
      [
        {
          extensionIdentifier: 'rubric',
          request: {
            prompt: 'Judge the new activity.',
            keys: {
              likelihood: { type: 'predicate', description: 'Likely?' },
              route: {
                type: 'enum',
                description: 'Route?',
                values: ['technical', 'other'],
              },
              severity: {
                type: 'score',
                description: 'Severity?',
                levels: [
                  { label: 'low', description: 'No loss.' },
                  { label: 'medium', description: 'Workaround exists.' },
                  { label: 'high', description: 'Blocked.' },
                ],
              },
            },
          },
        },
      ],
      '<agent-activity>\nuser\n¦Export fails but another browser works.\n</agent-activity>',
    );
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            answers: {
              q0: { type: 'noul', noul: 0.8 },
              q1: {
                type: 'choice',
                choice: 'technical',
                probabilities: { technical: 0.9, other: 0.1 },
              },
              q2: {
                type: 'score',
                score: 1.25,
                probabilities: { '0': 0.125, '1': 0.5, '2': 0.375 },
              },
            },
            usage: { input_tokens: 42, output_tokens: 6 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const native = evaluation();
    const candidate = {
      ...native,
      entry: { ...native.entry, attemptTimeoutMs: 1000 },
      model: createTypeSafeAi({
        apiKey: 'synthetic',
        baseURL: 'https://synthetic.invalid',
        fetch,
      }).evaluationModel('jev-latest'),
    };
    const opts = options([candidate]);
    const result = await executeInstinctClassification(
      {
        ...batch,
        abortSignal: new AbortController().signal,
        deadlineAt: performance.now() + 2000,
      },
      opts,
    );
    expect(result.status).toBe('evaluation');
    if (result.status !== 'evaluation')
      throw new Error('Missing native result');
    expect(
      normalizeInstinctEvaluation(batch, result.answers, result.modelId).get(
        'rubric',
      ),
    ).toMatchObject({
      status: 'ok',
      answers: { likelihood: 0.8, route: 'technical', severity: 1.25 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.state).toBe(batch.state);
    expect(body.state.match(/Judge the new activity\./g)).toHaveLength(1);
    expect(body.questions).toMatchObject({
      q0: { type: 'noul' },
      q1: { type: 'choice', criteria: { technical: null, other: null } },
      q2: {
        type: 'score',
        criteria: [
          'low: No loss.',
          'medium: Workaround exists.',
          'high: Blocked.',
        ],
      },
    });
    expect(JSON.stringify(body.questions)).not.toContain('Content lines');
    expect(opts.onUsage.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 42,
      outputTokens: 6,
    });
  });
  it.each([400, 401, 429])(
    'does not expose provider errors or account missing usage (HTTP %s)',
    async (statusCode) => {
      const candidate = generation();
      candidate.model.doGenerate = vi.fn(async () => {
        throw new APICallError({
          message: 'synthetic-private-token synthetic-private-prompt',
          url: 'https://synthetic-private-host',
          requestBodyValues: { input: 'synthetic-private-prompt' },
          responseBody: 'synthetic-private-token',
          statusCode,
        });
      });
      const opts = options([candidate]);
      const result = await executeInstinctClassification(args(), opts);
      expect(result).toMatchObject({ status: 'failed' });
      expect(opts.onUsage).not.toHaveBeenCalled();
      expect(
        JSON.stringify({ result, reports: opts.onUsage.mock.calls }),
      ).not.toContain('synthetic-private');
    },
  );

  it('accounts usage from malformed model output', async () => {
    const opts = options([generation('not JSON')]);
    const result = await executeInstinctClassification(args(), opts);
    expect(result).toMatchObject({ status: 'partial', text: 'not JSON' });
    expect(opts.onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
    );
  });

  it('suppresses private SDK warnings during concurrent generation and evaluation', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
    const consoleWarning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
    const warnings: SharedV4Warning[] = [
      { type: 'other', message: 'synthetic private provider diagnostic' },
      {
        type: 'unsupported',
        feature: 'private diagnostic',
        details: 'synthetic credential',
      },
      {
        type: 'compatibility',
        feature: 'temperature',
        details: 'private response',
      },
    ];
    const gen = generation();
    const generate = gen.model.doGenerate.bind(gen.model);
    vi.spyOn(gen.model, 'doGenerate').mockImplementation(async (options) => ({
      ...(await generate(options)),
      warnings,
    }));
    const evalCandidate = evaluation(async () => ({
      answers: {
        q0: { type: 'boolean', probability: 0.9 },
        q1: { type: 'choice', choice: 'read' },
      },
      warnings,
    }));
    const attempts = [options([gen]), options([evalCandidate])];
    await Promise.all(
      attempts.map((opts) => executeInstinctClassification(args(), opts)),
    );
    expect(emitWarning).not.toHaveBeenCalled();
    expect(consoleWarning).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
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
        opts.onUsage.mock.calls.map(([usage]) => usage.inputTokens),
      ).toEqual(first === 'generation' ? [10, 7] : [10]);
    },
  );

  it('retains only the latest generation salvage, but a complete later evaluation wins', async () => {
    const candidates = [
      generation('{"q0":1}', 'old'),
      generation('{"q0":0}', 'latest'),
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
      text: '{"q0":0}',
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
      expect(opts.onUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      );
      const before = opts.onUsage.mock.calls.slice();
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
      expect(opts.onUsage.mock.calls).toEqual(before);
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
      const opts = options([generation('{"q0":1}'), bounded, next]);
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
      expect(opts.onUsage.mock.calls).toHaveLength(1);
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

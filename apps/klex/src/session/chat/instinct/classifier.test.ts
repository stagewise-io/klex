import { describe, expect, it, vi } from 'vitest';

import type { InstinctClassificationRequest } from '@/session/chat/extensions/extension-api';

import {
  classifyInstinct,
  compileInstinctClassificationBatch,
  createInstinctClassifierEntries,
  createInstinctOutputSchema,
  distributeInstinctAnswers,
  type InstinctClassifier,
  normalizeInstinctEvaluation,
  renderInstinctClassifierSystemPrompt,
  validateInstinctClassificationRequest,
} from './classifier';

const request: InstinctClassificationRequest = {
  prompt: 'Decide if memory helps.',
  keys: {
    needsMemory: { type: 'boolean', description: 'Prior episodes help.' },
  },
};
const entries = createInstinctClassifierEntries([
  { extensionIdentifier: 'memory', request },
  {
    extensionIdentifier: 'task/planner',
    request: {
      prompt: 'Decide task status.',
      keys: {
        state: {
          type: 'enum',
          values: ['new', 'ongoing'],
          description: 'Task state.',
        },
      },
    },
  },
]);
const run = (
  generate: InstinctClassifier,
  signal = new AbortController().signal,
  timeoutMs = 20,
) =>
  classifyInstinct({
    entries,
    prompt: '<external-input>data</external-input>',
    execute: generate,
    signal,
    timeoutMs,
  });

describe('shared classifier', () => {
  it.each([
    [0, false],
    [0.5, false],
    [1, true],
  ] as const)(
    'normalizes P(true)=%s with fixed strict threshold and scoped metadata',
    (probability, expected) => {
      const batch = compileInstinctClassificationBatch(entries, 'synthetic');
      const result = normalizeInstinctEvaluation(
        batch,
        {
          q0: { type: 'boolean', probability },
          q1: { type: 'choice', choice: 'ongoing' },
        },
        'eval-model',
      );
      expect(result.get('memory')).toEqual({
        status: 'ok',
        modelId: 'eval-model',
        answers: { needsMemory: expected },
        evaluation: { needsMemory: { probability } },
      });
      expect(result.get('task/planner')).toEqual({
        status: 'ok',
        modelId: 'eval-model',
        answers: { state: 'ongoing' },
      });
      expect(() =>
        normalizeInstinctEvaluation(
          batch,
          { q0: { type: 'boolean', probability } },
          'eval-model',
        ),
      ).toThrow('count');
    },
  );

  it('maps colliding extension IDs and prototype-sensitive choices without moving state into instructions', () => {
    const request: InstinctClassificationRequest = {
      prompt: 'Trusted policy',
      keys: {
        route: {
          type: 'enum',
          values: ['__proto__', 'constructor'],
          description: 'Route',
          valueDescriptions: Object.fromEntries([
            ['__proto__', 'Prototype route'],
          ]),
        },
      },
    };
    const participants = createInstinctClassifierEntries([
      { extensionIdentifier: 'a/b', request },
      { extensionIdentifier: 'a_b', request },
    ]);
    const state = '<external-input>UNTRUSTED_STATE</external-input>';
    const batch = compileInstinctClassificationBatch(participants, state);
    expect(batch.mapping.map(({ id, outputKey }) => [id, outputKey])).toEqual([
      ['q0', 'a_b'],
      ['q1', 'a_b_2'],
    ]);
    expect(batch.questions.q0).toMatchObject({
      type: 'choice',
      criteria: Object.fromEntries([
        ['__proto__', 'Prototype route'],
        ['constructor', null],
      ]),
    });
    expect(JSON.stringify(batch.questions)).not.toContain('UNTRUSTED_STATE');
    expect(batch.system).toContain('Prototype route');
    const probabilities = Object.fromEntries([
      ['__proto__', 1],
      ['constructor', 0],
    ]);
    const result = normalizeInstinctEvaluation(
      batch,
      {
        q0: { type: 'choice', choice: '__proto__', probabilities },
        q1: { type: 'choice', choice: 'constructor' },
      },
      'native',
    );
    expect(result.get('a/b')).toMatchObject({
      answers: { route: '__proto__' },
      evaluation: { route: { probabilities } },
    });
    expect(result.get('a_b')).toMatchObject({
      answers: { route: 'constructor' },
    });
  });

  it('validates value-description mappings and rejects aggregate limits without dropping questions', () => {
    const enumKey = { type: 'enum', values: ['valid'], description: 'Route' };
    for (const valueDescriptions of [
      { missing: 'No' },
      { valid: '' },
      { valid: 'x'.repeat(501) },
      [],
    ]) {
      expect(
        validateInstinctClassificationRequest({
          prompt: 'Policy',
          keys: { route: { ...enumKey, valueDescriptions } },
        }),
      ).not.toBeNull();
    }
    expect(
      validateInstinctClassificationRequest({
        prompt: 'Policy',
        keys: {
          route: { ...enumKey, valueDescriptions: { valid: 'Description' } },
        },
      }),
    ).toBeNull();
    const oversized = createInstinctClassifierEntries(
      Array.from({ length: 9 }, (_, i) => ({
        extensionIdentifier: `ext${i}`,
        request: {
          prompt: 'Policy',
          keys: Object.fromEntries(
            Array.from({ length: 16 }, (_, j) => [
              `flag${j}`,
              { type: 'boolean' as const, description: 'Flag' },
            ]),
          ),
        },
      })),
    );
    expect(() =>
      compileInstinctClassificationBatch(oversized, 'state'),
    ).toThrow('128 questions');
    expect(() =>
      compileInstinctClassificationBatch(entries, '"'.repeat(128_000)),
    ).toThrow('serialized characters');
  });
  it('validates runtime requests and strict required slices', () => {
    expect(validateInstinctClassificationRequest(request)).toBeNull();
    for (const invalid of [
      null,
      {},
      { ...request, prompt: '' },
      { ...request, keys: { bad: { type: 'string' } } },
    ]) {
      expect(validateInstinctClassificationRequest(invalid)).not.toBeNull();
    }
    expect(
      createInstinctOutputSchema(entries).safeParse({
        memory: { needsMemory: true },
        task_planner: { state: 'new' },
      }).success,
    ).toBe(true);
    expect(
      createInstinctOutputSchema(entries).safeParse({
        memory: { needsMemory: true, extra: 1 },
        task_planner: { state: 'new' },
      }).success,
    ).toBe(false);
  });

  it('namespaces colliding identifiers and includes all extension prompt fragments', () => {
    const collision = createInstinctClassifierEntries(
      ['a/b', 'a_b', 'a_b_2', 'a/b'].map((extensionIdentifier) => ({
        extensionIdentifier,
        request,
      })),
    );
    expect(new Set(collision.map((entry) => entry.outputKey)).size).toBe(4);
    const prompt = renderInstinctClassifierSystemPrompt(entries);
    expect(prompt).toContain('output_key="memory"');
    expect(prompt).toContain('output_key="task_planner"');
    expect(prompt).toContain('History line format:');
    expect(prompt).toContain('Decide task status.');
  });

  it('distributes only each extension’s validated answers', async () => {
    const generate = vi.fn<InstinctClassifier>().mockResolvedValue({
      status: 'ok',
      modelId: 'classifier',
      output: {
        memory: { needsMemory: true },
        task_planner: { state: 'ongoing' },
      },
    });
    const outcomes = await run(generate);
    expect(outcomes.get('memory')).toEqual({
      status: 'ok',
      modelId: 'classifier',
      answers: { needsMemory: true },
    });
    expect(outcomes.get('task/planner')).toEqual({
      status: 'ok',
      modelId: 'classifier',
      answers: { state: 'ongoing' },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('salvages valid slices from a partial structured response', async () => {
    const outcomes = await run(async () => ({
      status: 'partial',
      modelId: 'classifier',
      text: '```json\n{"memory":{"needsMemory":true},"task_planner":{"state":"invalid"}}\n```',
    }));
    expect(outcomes.get('memory')?.status).toBe('ok');
    expect(outcomes.get('task/planner')?.status).toBe('failed');
    expect(
      distributeInstinctAnswers(entries, undefined, 'model').get('memory')
        ?.status,
    ).toBe('failed');
  });

  it.each(['unavailable', 'failed'] as const)(
    'distributes %s failures',
    async (status) => {
      const outcomes = await run(async () => ({
        status,
        reason: 'test reason',
      }));
      expect([...outcomes.values()]).toEqual(
        entries.map(() => ({ status, reason: 'test reason' })),
      );
    },
  );

  it('enforces timeout even if generation ignores cancellation and rejects late', async () => {
    let reject!: (error: Error) => void;
    const outcomes = await run(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    expect(
      [...outcomes.values()].every((outcome) => outcome.status === 'timeout'),
    ).toBe(true);
    reject(new Error('late rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('distinguishes shared deadline expiry from caller cancellation', async () => {
    const controller = new AbortController();
    const deadline = new AbortController();
    const generate = vi.fn<InstinctClassifier>(() => new Promise(() => {}));
    const args = {
      entries,
      prompt: 'input',
      execute: generate,
      signal: controller.signal,
      deadline: deadline.signal,
      timeoutMs: 1000,
    };
    const pending = classifyInstinct(args);
    deadline.abort();
    expect((await pending).get('memory')?.status).toBe('timeout');
    expect(generate).not.toHaveBeenCalled();
    generate.mockClear();
    expect((await classifyInstinct(args)).get('memory')?.status).toBe(
      'timeout',
    );
    expect(generate).not.toHaveBeenCalled();
    controller.abort('session_shutdown');
    expect((await classifyInstinct(args)).get('memory')?.status).toBe(
      'aborted',
    );
  });

  it('cancels immediately before or during uncooperative generation', async () => {
    const controller = new AbortController();
    const generate = vi.fn<InstinctClassifier>(() => new Promise(() => {}));
    const pending = run(generate, controller.signal, 1_000);
    controller.abort();
    expect((await pending).get('memory')?.status).toBe('aborted');
    expect(generate).not.toHaveBeenCalled();
    const during = new AbortController();
    const running = run(generate, during.signal, 1_000);
    await Promise.resolve();
    expect(generate).toHaveBeenCalledOnce();
    during.abort();
    expect((await running).get('memory')?.status).toBe('aborted');
    generate.mockClear();
    expect((await run(generate, controller.signal)).get('memory')?.status).toBe(
      'aborted',
    );
    expect(generate).not.toHaveBeenCalled();
  });
});

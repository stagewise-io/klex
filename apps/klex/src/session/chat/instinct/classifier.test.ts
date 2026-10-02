import { describe, expect, it, vi } from 'vitest';

import type { InstinctClassificationRequest } from '@/session/chat/extensions/extension-api';

import {
  classifyInstinct,
  createInstinctClassifierEntries,
  createInstinctOutputSchema,
  distributeInstinctAnswers,
  type InstinctStructuredGenerator,
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
  generate: InstinctStructuredGenerator,
  signal = new AbortController().signal,
  timeoutMs = 20,
) =>
  classifyInstinct({
    entries,
    prompt: '<external-input>data</external-input>',
    generate,
    signal,
    timeoutMs,
  });

describe('shared classifier', () => {
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
    const generate = vi.fn<InstinctStructuredGenerator>().mockResolvedValue({
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
    const generate = vi.fn<InstinctStructuredGenerator>(
      () => new Promise(() => {}),
    );
    const args = {
      entries,
      prompt: 'input',
      generate,
      signal: controller.signal,
      deadline: deadline.signal,
      timeoutMs: 1000,
    };
    const pending = classifyInstinct(args);
    deadline.abort();
    expect((await pending).get('memory')?.status).toBe('timeout');
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
    const generate = vi.fn<InstinctStructuredGenerator>(
      () => new Promise(() => {}),
    );
    const pending = run(generate, controller.signal, 1_000);
    controller.abort();
    expect((await pending).get('memory')?.status).toBe('aborted');
    generate.mockClear();
    expect((await run(generate, controller.signal)).get('memory')?.status).toBe(
      'aborted',
    );
    expect(generate).not.toHaveBeenCalled();
  });
});

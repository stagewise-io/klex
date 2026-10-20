import { describe, expect, it } from 'vitest';

import type { InstinctClassificationRequest } from '@/session/chat/extensions/extension-api';

import {
  compileInstinctClassificationBatch,
  createInstinctOutputSchema,
  distributeInstinctGeneration,
  type InstinctClassifierEntry,
  normalizeInstinctEvaluation,
  parseLenientJson,
  validateInstinctClassificationRequest,
} from './classifier';

const request: InstinctClassificationRequest = {
  prompt: 'Decide if memory helps.',
  keys: {
    needsMemory: { type: 'boolean', description: 'Prior episodes help.' },
  },
};
const entries: InstinctClassifierEntry[] = [
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
];
describe('shared classifier', () => {
  it('compiles predicate, choice and weighted score contracts for generation and SDK evaluation', () => {
    const participants: InstinctClassifierEntry[] = [
      {
        extensionIdentifier: 'judgments',
        request: {
          prompt: 'Apply the declared rubrics.',
          keys: {
            legacy: { type: 'boolean', description: 'Legacy condition?' },
            likelihood: {
              type: 'predicate',
              description: 'Condition probability?',
            },
            severity: {
              type: 'score',
              description: 'Severity?',
              levels: [
                { label: 'none', description: 'No functional loss.' },
                { label: 'partial', description: 'A workaround exists.' },
                { label: 'blocked', description: 'No workaround.' },
              ],
            },
            route: {
              type: 'enum',
              description: 'Route?',
              values: ['human', 'agent'],
            },
          },
        },
      },
    ];
    expect(
      validateInstinctClassificationRequest(participants[0]?.request),
    ).toBeNull();
    const batch = compileInstinctClassificationBatch(
      participants,
      '<agent-activity>synthetic</agent-activity>',
    );
    expect(batch.questions).toMatchObject({
      q0: {
        type: 'boolean',
        instructions: expect.stringContaining('Legacy condition?'),
      },
      q1: { type: 'boolean' },
      q3: { type: 'choice', criteria: { human: null, agent: null } },
    });
    expect(batch.questions.q2).toMatchObject({
      type: 'score',
      criteria: [
        'none: No functional loss.',
        'partial: A workaround exists.',
        'blocked: No workaround.',
      ],
    });
    expect(
      batch.schema.safeParse({ q0: 0.5, q1: 0.73, q2: 1.25, q3: 'agent' })
        .success,
    ).toBe(true);
    const generated = distributeInstinctGeneration(
      participants,
      { q0: 0.5, q1: 0.73, q2: 1.25, q3: 'agent' },
      'gen',
    ).get('judgments');
    expect(generated).toEqual({
      status: 'ok',
      modelId: 'gen',
      answers: {
        legacy: false,
        likelihood: 0.73,
        severity: 1.25,
        route: 'agent',
      },
    });
    const probabilities = { '0': 0.125, '1': 0.5, '2': 0.375 };
    const evaluated = normalizeInstinctEvaluation(
      batch,
      {
        q0: { type: 'boolean', probability: 0.5 },
        q1: { type: 'boolean', probability: 0.73 },
        q2: { type: 'score', score: 1.25, probabilities },
        q3: { type: 'choice', choice: 'agent' },
      },
      'eval',
    ).get('judgments');
    expect(evaluated).toMatchObject({
      status: 'ok',
      answers: generated?.status === 'ok' ? generated.answers : undefined,
      evaluation: { severity: { probabilities } },
    });
    for (const q2 of [-1, 3, Number.NaN, Infinity, '1', true]) {
      expect(
        batch.schema.safeParse({ q0: 0.5, q1: 0.73, q2, q3: 'agent' }).success,
      ).toBe(false);
      expect(
        distributeInstinctGeneration(
          participants,
          { q0: 0.5, q1: 0.73, q2, q3: 'agent' },
          'gen',
        ).get('judgments')?.status,
      ).toBe('failed');
    }
    expect(
      distributeInstinctGeneration(
        participants,
        { q0: true, q1: 0.73, q2: 1, q3: 'agent' },
        'gen',
      ).get('judgments')?.status,
    ).toBe('failed');
    expect(() =>
      normalizeInstinctEvaluation(
        batch,
        {
          q0: { type: 'boolean', probability: 1 },
          q1: { type: 'boolean', probability: 1 },
          q2: { type: 'score', score: 3 },
          q3: { type: 'choice', choice: 'agent' },
        },
        'eval',
      ),
    ).toThrow('score');
  });

  it('validates ordered score rubrics and predicate descriptors at the extension boundary', () => {
    for (const levels of [
      [],
      [{ label: 'one', description: 'Only one.' }],
      [
        { label: 'same', description: 'A' },
        { label: 'same', description: 'B' },
      ],
      [
        { label: 'one', description: '' },
        { label: 'two', description: 'B' },
      ],
      [null, null],
      Array.from({ length: 33 }, (_, i) => ({
        label: String(i),
        description: 'Level',
      })),
    ]) {
      expect(
        validateInstinctClassificationRequest({
          prompt: 'Policy',
          keys: {
            severity: { type: 'score', description: 'Severity?', levels },
          },
        }),
      ).not.toBeNull();
    }
    expect(
      validateInstinctClassificationRequest({
        prompt: 'Policy',
        keys: { chance: { type: 'predicate', description: 'Likely?' } },
      }),
    ).toBeNull();
    expect(
      validateInstinctClassificationRequest({
        prompt: 'Policy',
        keys: {
          chance: {
            type: 'predicate',
            description: 'Likely?',
            valueDescriptions: {},
          },
        },
      }),
    ).not.toBeNull();
  });

  it('deduplicates exact policies without merging extension state or copying evidence into questions', () => {
    const participants = ['one', 'two'].map((extensionIdentifier) => ({
      extensionIdentifier,
      request,
    }));
    const batch = compileInstinctClassificationBatch(
      participants,
      'UNTRUSTED_EVIDENCE',
    );
    expect(batch.system.match(/Decide if memory helps\./g)).toHaveLength(1);
    expect(batch.state.match(/Decide if memory helps\./g)).toHaveLength(1);
    expect(batch.questions.q0?.instructions).toContain('state e0');
    expect(batch.questions.q1?.instructions).toContain('state e1');
    expect(JSON.stringify(batch.questions)).not.toContain('UNTRUSTED_EVIDENCE');
    expect(JSON.stringify(batch.schema)).not.toContain('Prior episodes help.');
    expect(batch.state).toContain('UNTRUSTED_EVIDENCE');
  });
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
    const participants: InstinctClassifierEntry[] = [
      { extensionIdentifier: 'a/b', request },
      { extensionIdentifier: 'a_b', request },
    ];
    const state = '<external-input>UNTRUSTED_STATE</external-input>';
    const batch = compileInstinctClassificationBatch(participants, state);
    expect(Object.keys(batch.questions)).toEqual(['q0', 'q1']);
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
    const oversized = Array.from({ length: 9 }, (_, i) => ({
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
    }));
    expect(() =>
      compileInstinctClassificationBatch(oversized, 'state'),
    ).toThrow('128 questions');
    // Serialized size is checked by the executor against only the active backend.
    expect(() =>
      compileInstinctClassificationBatch(entries, '"'.repeat(128_000)),
    ).not.toThrow();
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
        q0: 1,
        q1: 'new',
      }).success,
    ).toBe(true);
    expect(
      createInstinctOutputSchema(entries).safeParse({
        q0: 1,
        q1: 'new',
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('includes all extension prompt fragments', () => {
    const { system: prompt } = compileInstinctClassificationBatch(entries, '');
    expect(prompt).toContain('name="memory"');
    expect(prompt).toContain('name="task/planner"');
    expect(prompt).toContain('History line format:');
    expect(prompt).toContain(
      'ordered oldest to newest; the final entry is the most recent',
    );
    expect(prompt).toContain('Decide task status.');
  });

  it('distributes only each extension’s validated answers', () => {
    const outcomes = distributeInstinctGeneration(
      entries,
      { q0: 0.9, q1: 'ongoing' },
      'classifier',
    );
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
  });

  it('salvages valid slices from a partial structured response', () => {
    const outcomes = distributeInstinctGeneration(
      entries,
      parseLenientJson('```json\n{"q0":0.9,"q1":"invalid"}\n```'),
      'classifier',
    );
    expect(outcomes.get('memory')?.status).toBe('ok');
    expect(outcomes.get('task/planner')?.status).toBe('failed');
    expect(
      distributeInstinctGeneration(entries, undefined, 'model').get('memory')
        ?.status,
    ).toBe('failed');
  });
});

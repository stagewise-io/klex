import { describe, expect, it } from 'vitest';

import { learningSubmissionSchema, validateOperations } from './operations';

const create = {
  op: 'create',
  name: 'ask-first',
  description: 'Use before changing core contracts.',
  body: 'Ask the owner first.',
  reason: 'feedback',
};

describe('learning submission schema', () => {
  it('defines typed create, update, and delete operations', () => {
    const batch = {
      operations: [
        create,
        {
          ...create,
          op: 'update',
          mergedFrom: ['old'],
          evidenceEpisodes: ['support'],
        },
        { op: 'delete', name: 'old', reason: 'superseded' },
      ],
    };
    expect(learningSubmissionSchema.parse(batch)).toEqual(batch);
  });

  it('accepts explicit empty batches and deferral', () => {
    expect(learningSubmissionSchema.parse({ operations: [] })).toEqual({
      operations: [],
    });
    expect(
      learningSubmissionSchema.parse({ operations: [], deferred: true }),
    ).toEqual({ operations: [], deferred: true });
  });

  it.each([
    'plain text',
    '{"operations": []}',
    { ops: [] },
    { operations: [create, { op: 'rename', name: 'x' }] },
    { operations: [{ ...create, name: '../escape' }] },
    { operations: [{ ...create, body: 'x'.repeat(4_001) }] },
    { operations: [{ ...create, description: 'x'.repeat(301) }] },
    { operations: [{ ...create, evidenceEpisodes: Array(7).fill('a') }] },
    { operations: Array(61).fill(create) },
  ])('rejects the entire invalid batch %j', (batch) => {
    expect(learningSubmissionSchema.safeParse(batch).success).toBe(false);
  });
});

describe('validateOperations', () => {
  it('applies the rejection rules', () => {
    const { accepted, rejected } = validateOperations(
      [
        { ...create, op: 'create', name: 'existing' },
        { ...create, op: 'update', name: 'missing' },
        { op: 'delete', name: 'missing', reason: '' },
        { ...create, op: 'create', name: 'Bad Name' },
        { ...create, op: 'create', name: 'long', body: 'x'.repeat(5_000) },
        { ...create, op: 'update', name: 'existing' },
      ],
      ['existing'],
    );
    expect(accepted.map((operation) => operation.op)).toEqual(['update']);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      'skill "existing" already exists',
      'unknown skill "missing"',
      'unknown skill "missing"',
      'invalid name "Bad Name"',
      'body too long',
    ]);
  });

  it('lets later operations see earlier ones', () => {
    const { accepted, rejected } = validateOperations(
      [
        { ...create, op: 'create' },
        { ...create, op: 'update', body: 'Changed.' },
        { op: 'delete', name: 'ask-first', reason: 'merged' },
        { ...create, op: 'update' },
      ],
      [],
    );
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(1);
  });
});

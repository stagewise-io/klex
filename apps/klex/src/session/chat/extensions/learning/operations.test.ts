import { describe, expect, it } from 'vitest';

import { parseOperations, validateOperations } from './operations';

const create = {
  op: 'create',
  name: 'ask-first',
  description: 'Use before changing core contracts.',
  body: 'Ask the owner first.',
  reason: 'feedback',
};

describe('parseOperations', () => {
  it('accepts exposed citations and drops forged citations individually', () => {
    const evidence = new Set(['primary', 'support']);
    const valid = { ...create, evidenceEpisodes: ['support'] };
    const forged = {
      ...create,
      name: 'forged',
      evidenceEpisodes: ['not-read'],
    };
    expect(
      parseOperations(JSON.stringify({ operations: [valid, forged] }), {
        allowDelete: false,
        evidence,
      }),
    ).toEqual({ ok: true, operations: [valid], dropped: 1 });
  });

  it('allows conservative deferral but never a deferred partial proposal', () => {
    expect(
      parseOperations('{"operations": [], "deferred": true}', {
        allowDelete: false,
      }),
    ).toEqual({ ok: true, operations: [], deferred: true, dropped: 0 });
    expect(
      parseOperations(
        JSON.stringify({ operations: [create], deferred: true }),
        { allowDelete: false },
      ).ok,
    ).toBe(false);
  });
  it('parses unfenced and fenced JSON', () => {
    const text = JSON.stringify({ operations: [create] });
    const plain = parseOperations(text, { allowDelete: false });
    const fenced = parseOperations(`\`\`\`json\n${text}\n\`\`\``, {
      allowDelete: false,
    });
    expect(plain).toEqual(fenced);
    expect(plain.ok && plain.operations).toEqual([create]);
  });

  it('accepts empty operations', () => {
    expect(
      parseOperations('{"operations": []}', { allowDelete: false }),
    ).toEqual({ ok: true, operations: [], dropped: 0 });
  });

  it('fails on invalid JSON or a missing array', () => {
    expect(parseOperations('nope', { allowDelete: true }).ok).toBe(false);
    expect(parseOperations('{"ops": []}', { allowDelete: true }).ok).toBe(
      false,
    );
  });

  it('drops malformed operations and deletes in extraction mode', () => {
    const text = JSON.stringify({
      operations: [
        create,
        { op: 'rename', name: 'x' },
        { op: 'delete', name: 'old', reason: 'stale' },
      ],
    });
    const extraction = parseOperations(text, { allowDelete: false });
    expect(extraction).toEqual({ ok: true, operations: [create], dropped: 2 });
    const consolidation = parseOperations(text, { allowDelete: true });
    expect(consolidation.ok && consolidation.operations).toHaveLength(2);
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

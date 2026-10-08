import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { learningSubmissionSchema } from '../operations';
import { createLearningSubmissionTools } from './submission-tools';

const create = {
  op: 'create',
  name: 'lesson',
  description: 'Use when testing.',
  body: 'Do this.',
  reason: 'observed',
};

function harness(allowDefer = true) {
  const controller = new AbortController();
  const evidence = new Set(['primary']);
  const submission = createLearningSubmissionTools({
    evidence,
    existingNames: ['old'],
    signal: controller.signal,
    allowDefer,
  });
  const call = async (input: unknown) => {
    const output = await submission.tools.submitLearnings?.execute?.(input, {
      toolCallId: 'submit',
      messages: [],
      context: undefined,
      abortSignal: controller.signal,
    });
    return { toolName: 'submitLearnings', output };
  };
  return { submission, controller, evidence, call };
}

describe('learning submission tools', () => {
  it('exposes a provider-convertible schema, not an untyped operation array', () => {
    const schema = z.toJSONSchema(learningSubmissionSchema);
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        operations: { type: 'array', items: { oneOf: expect.any(Array) } },
      },
    });
  });

  it('stages one validated batch in the tool result without applying it', async () => {
    const { call, submission } = harness();
    const result = await call({ operations: [create] });
    expect(result.output).toEqual({
      status: 'accepted',
      submission: { operations: [create] },
    });
    expect(submission.completionTool.isComplete(result.output)).toBe(true);
    expect(submission.read([result])).toEqual({
      ok: true,
      submission: { operations: [create] },
    });
  });

  it('supports explicit no-learning and extraction deferral', async () => {
    const { call, submission } = harness();
    for (const batch of [
      { operations: [] },
      { operations: [], deferred: true },
    ]) {
      expect(submission.read([await call(batch)])).toEqual({
        ok: true,
        submission: batch,
      });
    }
  });

  it('rejects unread citations, then accepts corrected evidence', async () => {
    const { call, submission, evidence } = harness();
    const batch = {
      operations: [{ ...create, evidenceEpisodes: ['support'] }],
    };
    const rejected = await call(batch);
    expect(rejected.output).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Unread evidence'),
    });
    expect(submission.completionTool.isComplete(rejected.output)).toBe(false);
    evidence.add('support');
    const accepted = await call(batch);
    expect(submission.read([rejected, accepted])).toEqual({
      ok: true,
      submission: batch,
    });
  });

  it.each([
    { operations: [create, { ...create, op: 'update', name: 'missing' }] },
    { operations: [{ ...create, name: 'old' }] },
    {
      operations: [
        { ...create, op: 'update', name: 'old', mergedFrom: ['missing'] },
      ],
    },
    { operations: [create], deferred: true },
    { operations: [{ ...create, description: 'multi\nline' }] },
    { operations: [create, { op: 'rename', name: 'old' }] },
  ])(
    'rejects the entire batch, without partial acceptance %j',
    async (batch) => {
      const { call, submission } = harness();
      const result = await call(batch);
      expect(result.output).toMatchObject({ status: 'rejected' });
      expect(submission.read([result]).ok).toBe(false);
    },
  );

  it('permits ordered operations and retiring superseded skills during extraction', async () => {
    const { call, submission } = harness();
    const batch = {
      operations: [
        create,
        { ...create, op: 'update', body: 'Updated.' },
        { op: 'delete', name: 'old', reason: 'superseded' },
      ],
    };
    expect(submission.read([await call(batch)])).toEqual({
      ok: true,
      submission: batch,
    });
  });

  it('does not accept consolidation deferral', async () => {
    const { call } = harness(false);
    expect(
      (await call({ operations: [], deferred: true })).output,
    ).toMatchObject({ status: 'rejected' });
  });

  it('rejects missing or multiple accepted submissions, and ignores unrelated tool output', async () => {
    const { call, submission } = harness();
    const result = await call({ operations: [] });
    expect(submission.read([]).ok).toBe(false);
    expect(submission.read([{ ...result, toolName: 'readEpisode' }]).ok).toBe(
      false,
    );
    expect(submission.read([result, result]).ok).toBe(false);
  });

  it('rejects execution and staged results after cancellation', async () => {
    const { call, submission, controller } = harness();
    const result = await call({ operations: [create] });
    controller.abort();
    expect(submission.read([result]).ok).toBe(false);
    expect((await call({ operations: [] })).output).toEqual({
      status: 'cancelled',
    });
  });
});

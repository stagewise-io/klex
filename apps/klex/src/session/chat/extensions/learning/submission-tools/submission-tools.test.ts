import { describe, expect, it, vi } from 'vitest';
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

function harness(allowCreate = true) {
  const controller = new AbortController();
  const evidence = new Set(['primary']);
  const persist = vi.fn(async (batch) => batch.operations.length);
  const submission = createLearningSubmissionTools({
    evidence,
    getExistingNames: () => ['old'],
    persist,
    signal: controller.signal,
    allowCreate,
  });
  const execute = submission.tools.submitLearnings?.execute;
  if (!execute) throw new Error('Submission tool missing');
  const call = (input: unknown) =>
    execute(input, {
      toolCallId: 'submit',
      messages: [],
      context: undefined,
      abortSignal: controller.signal,
    });
  return { controller, evidence, call, persist };
}

describe('learning submission tools', () => {
  it('exposes a provider-convertible bounded operation schema', () => {
    expect(z.toJSONSchema(learningSubmissionSchema)).toMatchObject({
      type: 'object',
      properties: {
        operations: { type: 'array', items: { oneOf: expect.any(Array) } },
      },
    });
  });
  it('persists a validated batch during execution', async () => {
    const { call, persist } = harness();
    expect(await call({ operations: [create] })).toEqual({
      status: 'applied',
      applied: 1,
    });
    expect(persist).toHaveBeenCalledWith({ operations: [create] });
    expect(await call({ operations: [] })).toEqual({
      status: 'already-submitted',
    });
    expect(persist).toHaveBeenCalledOnce();
  });
  it('allows an explicit no-learning submission', async () => {
    const { call, persist } = harness();
    expect(await call({ operations: [] })).toMatchObject({
      status: 'applied',
      applied: 0,
    });
    expect(persist).toHaveBeenCalledOnce();
  });
  it('permits correction after unread citations without consuming the allowance', async () => {
    const { call, evidence, persist } = harness();
    const batch = {
      operations: [{ ...create, evidenceEpisodes: ['support'] }],
    };
    expect(await call(batch)).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Unread evidence'),
    });
    expect(persist).not.toHaveBeenCalled();
    evidence.add('support');
    expect(await call(batch)).toMatchObject({ status: 'applied' });
  });
  it.each([
    { operations: [create, { ...create, op: 'update', name: 'missing' }] },
    { operations: [{ ...create, name: 'old' }] },
    {
      operations: [
        { ...create, op: 'update', name: 'old', mergedFrom: ['missing'] },
      ],
    },
    { operations: [{ ...create, description: 'multi\nline' }] },
    { operations: [create, { op: 'rename', name: 'old' }] },
  ])('rejects the entire invalid batch %j', async (batch) => {
    const { call, persist } = harness();
    expect(await call(batch)).toMatchObject({ status: 'rejected' });
    expect(persist).not.toHaveBeenCalled();
  });
  it('permits ordered operations and retiring superseded skills', async () => {
    const { call } = harness();
    expect(
      await call({
        operations: [
          create,
          { ...create, op: 'update', body: 'Updated.' },
          { op: 'delete', name: 'old', reason: 'superseded' },
        ],
      }),
    ).toMatchObject({ status: 'applied', applied: 3 });
  });
  it('rejects consolidation creates, allowing correction', async () => {
    const { call } = harness(false);
    expect(await call({ operations: [create] })).toMatchObject({
      status: 'rejected',
    });
    expect(
      await call({ operations: [{ ...create, op: 'update', name: 'old' }] }),
    ).toMatchObject({ status: 'applied' });
  });
  it('claims the allowance before asynchronous persistence begins', async () => {
    const { call, persist } = harness();
    let release!: () => void;
    persist.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1;
    });
    const first = call({ operations: [create] });
    expect(await call({ operations: [] })).toEqual({
      status: 'already-submitted',
    });
    release();
    expect(await first).toMatchObject({ status: 'applied' });
    expect(persist).toHaveBeenCalledOnce();
  });
  it('does not replay persistence failures, including partial writes', async () => {
    const { call, persist } = harness();
    persist.mockRejectedValueOnce(new Error('partial write'));
    expect(await call({ operations: [create] })).toMatchObject({
      status: 'failed',
    });
    expect(await call({ operations: [create] })).toEqual({
      status: 'already-submitted',
    });
    expect(persist).toHaveBeenCalledOnce();
  });
  it('cancels without invoking persistence', async () => {
    const { call, persist, controller } = harness();
    controller.abort();
    expect(await call({ operations: [] })).toEqual({ status: 'cancelled' });
    expect(persist).not.toHaveBeenCalled();
  });
});

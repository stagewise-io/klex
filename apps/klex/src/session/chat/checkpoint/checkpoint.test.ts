import { describe, expect, it, vi } from 'vitest';

import { CONTEXT_SUMMARY_KEY } from '@/session/chat/utils/history-view';
import { runInferenceHistoryTransformers } from '@/session/interaction';
import type { SessionHistoryRecorder } from '@/session-history';

import type { ExtensionHandler } from '../extension-handler';
import { createDataPart } from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import {
  makeExtensionHandler,
  makeTestSpan,
  testLogger,
} from '../test-helpers';
import {
  createCheckpointManager,
  isCheckpointHeader,
  MAX_CHECKPOINT_DEFERRALS,
} from './checkpoint';

type CheckpointHooks = Pick<
  ExtensionHandler,
  'collectCheckpointCarry' | 'runCheckpointApplyingHooks'
>;

function msg(id: string, role: 'user' | 'assistant' = 'user') {
  return {
    id,
    role,
    parts: [{ type: 'text', text: id }],
  } as ExtendedUIMessage;
}

function headerMsg(id: string): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [createDataPart(CONTEXT_SUMMARY_KEY, { summary: 'old' })],
  } as unknown as ExtendedUIMessage;
}

function setup(
  initial: ExtendedUIMessage[],
  hooks: Partial<CheckpointHooks> = {},
  lifecycle: { isClosed?: () => boolean; isAbandoned?: () => boolean } = {},
) {
  const messages = [...initial];
  const handler: CheckpointHooks = {
    collectCheckpointCarry: vi.fn(async () => []),
    runCheckpointApplyingHooks: vi.fn(async () => ({ defer: false })),
    ...hooks,
  };
  const commitCheckpoint = vi.fn(async () => {});
  const markTrimmed = vi.fn();
  const recorder = {
    commitCheckpoint,
    markTrimmed,
  } as unknown as SessionHistoryRecorder;
  const onApplied = vi.fn();
  const manager = createCheckpointManager({
    logger: testLogger,
    span: makeTestSpan(),
    messages,
    extensionHandler: () => handler,
    recorder,
    onApplied,
    ...lifecycle,
  });
  return {
    messages,
    handler,
    manager,
    commitCheckpoint,
    markTrimmed,
    onApplied,
  };
}

const ids = (messages: readonly ExtendedUIMessage[]) =>
  messages.map((m) => m.id);

describe('CheckpointManager — commit validation', () => {
  it('rejects an anchor that is not in the window', () => {
    const { manager } = setup([msg('a'), msg('b')]);
    expect(
      manager.commit({ coversThroughMessageId: 'x', summary: 's' }),
    ).toEqual({ status: 'rejected', reason: 'anchor is not in the window' });
    expect(manager.hasPending).toBe(false);
  });

  it('rejects the current header as anchor (non-forward)', () => {
    const { manager } = setup([headerMsg('h'), msg('a')]);
    expect(
      manager.commit({ coversThroughMessageId: 'h', summary: 's' }).status,
    ).toBe('rejected');
  });

  it('rejects an anchor without a raw tail', () => {
    const { manager } = setup([msg('a'), msg('b')]);
    expect(
      manager.commit({ coversThroughMessageId: 'b', summary: 's' }),
    ).toEqual({ status: 'rejected', reason: 'no message follows the anchor' });
  });

  it('replaces an older pending commit with a newer one', async () => {
    const { manager, messages } = setup([msg('a'), msg('b'), msg('c')]);
    expect(
      manager.commit({ coversThroughMessageId: 'a', summary: 'first' }).status,
    ).toBe('pending');
    expect(
      manager.commit({ coversThroughMessageId: 'b', summary: 'second' }).status,
    ).toBe('pending');

    await manager.applyPending();

    expect(ids(messages.slice(1))).toEqual(['c']);
    expect(messages[0]?.parts[0]).toMatchObject({
      data: { summary: 'second', coversThroughMessageId: 'b' },
    });
  });
});

describe('CheckpointManager — apply', () => {
  it('does not touch the window until applyPending runs', () => {
    const { manager, messages } = setup([msg('a'), msg('b')]);
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    expect(ids(messages)).toEqual(['a', 'b']);
    expect(manager.hasPending).toBe(true);
  });

  it('splices in place, puts the header first, and keeps carry order', async () => {
    const carry = [
      createDataPart('first' as never, { n: 1 } as never),
      createDataPart('second' as never, { n: 2 } as never),
    ];
    const { manager, messages, handler, markTrimmed, onApplied } = setup(
      [headerMsg('h0'), msg('a'), msg('b', 'assistant'), msg('c')],
      { collectCheckpointCarry: vi.fn(async () => carry) },
    );
    const reference = messages;

    manager.commit({ coversThroughMessageId: 'b', summary: 'sum' });
    await manager.applyPending();

    expect(messages).toBe(reference);
    expect(messages).toHaveLength(2);
    const [header, tail] = messages;
    expect(isCheckpointHeader(header)).toBe(true);
    expect(header?.role).toBe('user');
    expect(header?.parts).toEqual([
      expect.objectContaining({
        data: { summary: 'sum', coversThroughMessageId: 'b' },
      }),
      ...carry,
    ]);
    expect(tail?.id).toBe('c');
    expect(
      ids(vi.mocked(handler.collectCheckpointCarry).mock.calls[0]![0]),
    ).toEqual(['h0', 'a', 'b']);
    expect(handler.runCheckpointApplyingHooks).toHaveBeenCalledWith({
      droppedMessageIds: ['h0', 'a', 'b'],
      checkpointMessageId: header?.id,
    });
    expect(markTrimmed).toHaveBeenCalledWith(['h0', 'a', 'b']);
    expect(onApplied).toHaveBeenCalledOnce();
    expect(manager.hasPending).toBe(false);
  });

  it('persists the header before trimming the window', async () => {
    const { manager, messages, commitCheckpoint } = setup([msg('a'), msg('b')]);
    let lengthAtPersist = -1;
    commitCheckpoint.mockImplementation(async () => {
      lengthAtPersist = messages.length;
    });

    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    await manager.applyPending();

    expect(lengthAtPersist).toBe(2);
    expect(commitCheckpoint).toHaveBeenCalledWith(
      messages[0],
      'a',
      expect.any(Function),
    );
    expect(ids(messages.slice(1))).toEqual(['b']);
  });

  it('keeps the window when persistence fails and retries later', async () => {
    const { manager, messages, commitCheckpoint } = setup([msg('a'), msg('b')]);
    commitCheckpoint.mockRejectedValueOnce(new Error('disk full'));

    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    await manager.applyPending();
    expect(ids(messages)).toEqual(['a', 'b']);
    expect(manager.hasPending).toBe(true);

    messages.push(msg('c'));
    await manager.applyPending();
    expect(isCheckpointHeader(messages[0])).toBe(true);
  });

  it('defers and then applies anyway after MAX_CHECKPOINT_DEFERRALS', async () => {
    const { manager, messages, handler } = setup([msg('a'), msg('b')], {
      runCheckpointApplyingHooks: vi.fn(async () => ({ defer: true })),
    });
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });

    for (let i = 1; i < MAX_CHECKPOINT_DEFERRALS; i++) {
      await manager.applyPending();
      expect(ids(messages).slice(0, 2)).toEqual(['a', 'b']);
      expect(manager.hasPending).toBe(true);
      messages.push(msg(`next-${i}`));
    }

    await manager.applyPending();
    expect(handler.runCheckpointApplyingHooks).toHaveBeenCalledTimes(
      MAX_CHECKPOINT_DEFERRALS,
    );
    expect(isCheckpointHeader(messages[0])).toBe(true);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Checkpoint deferred too often — applying anyway',
    );
  });

  it('keeps the checkpoint pending when carry collection throws', async () => {
    const collect = vi
      .fn<CheckpointHooks['collectCheckpointCarry']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([]);
    const { manager, messages } = setup([msg('a'), msg('b')], {
      collectCheckpointCarry: collect,
    });
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });

    await manager.applyPending();
    expect(ids(messages)).toEqual(['a', 'b']);
    expect(manager.hasPending).toBe(true);

    messages.push(msg('c'));
    await manager.applyPending();
    expect(isCheckpointHeader(messages[0])).toBe(true);
  });

  it('drops the checkpoint when the anchor is rolled back before apply', async () => {
    const { manager, messages, commitCheckpoint } = setup([
      msg('a'),
      msg('b'),
      msg('c'),
    ]);
    manager.commit({ coversThroughMessageId: 'b', summary: 's' });
    messages.splice(1, 1);

    await manager.applyPending();

    expect(ids(messages)).toEqual(['a', 'c']);
    expect(commitCheckpoint).not.toHaveBeenCalled();
    expect(manager.hasPending).toBe(false);
  });

  it('retries when the window prefix changes during the hooks', async () => {
    const holder: { messages?: ExtendedUIMessage[] } = {};
    let first = true;
    const { manager, messages, commitCheckpoint } = setup(
      [msg('a'), msg('b'), msg('c')],
      {
        runCheckpointApplyingHooks: vi.fn(async () => {
          if (first) {
            first = false;
            holder.messages?.splice(1, 0, msg('inserted'));
          }
          return { defer: false };
        }),
      },
    );
    holder.messages = messages;
    manager.commit({ coversThroughMessageId: 'b', summary: 's' });

    expect(await manager.applyPending()).toBe('changed');
    expect(commitCheckpoint).not.toHaveBeenCalled();
    expect(manager.hasPending).toBe(true);

    expect(await manager.applyPending()).toBe('applied');
    expect(ids(messages.slice(1))).toEqual(['c']);
  });
});

describe('CheckpointManager — outcomes and lifecycle', () => {
  it('reports what each apply did', async () => {
    const hooks = vi
      .fn<CheckpointHooks['runCheckpointApplyingHooks']>()
      .mockResolvedValueOnce({ defer: true })
      .mockResolvedValue({ defer: false });
    const { manager, commitCheckpoint, messages } = setup(
      [msg('a'), msg('b'), msg('c')],
      { runCheckpointApplyingHooks: hooks },
    );
    expect(await manager.applyPending()).toBe('none');

    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    expect(await manager.applyPending()).toBe('deferred');
    messages.push(msg('d'));
    commitCheckpoint.mockRejectedValueOnce(new Error('disk full'));
    expect(await manager.applyPending()).toBe('failed');
    messages.push(msg('e'));
    expect(await manager.applyPending()).toBe('applied');

    manager.commit({ coversThroughMessageId: 'b', summary: 's2' });
    messages.splice(1, 1);
    expect(await manager.applyPending()).toBe('rejected');
  });

  it('does not retry a deferral or failure until the window changes', async () => {
    const hooks = vi
      .fn<CheckpointHooks['runCheckpointApplyingHooks']>()
      .mockResolvedValue({ defer: true });
    const { manager, messages, commitCheckpoint } = setup(
      [msg('a'), msg('b')],
      { runCheckpointApplyingHooks: hooks },
    );
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });

    // Last step, turn end, and loop exit hit back to back.
    expect(await manager.applyPending()).toBe('deferred');
    expect(await manager.applyPending()).toBe('none');
    expect(await manager.applyPending()).toBe('none');
    expect(hooks).toHaveBeenCalledOnce();
    expect(manager.hasPending).toBe(true);

    messages.push(msg('c'));
    hooks.mockResolvedValue({ defer: false });
    commitCheckpoint.mockRejectedValueOnce(new Error('disk full'));
    expect(await manager.applyPending()).toBe('failed');
    expect(await manager.applyPending()).toBe('none');
    expect(hooks).toHaveBeenCalledTimes(2);

    // A newer commit is a fresh request and is not held back.
    manager.commit({ coversThroughMessageId: 'b', summary: 's2' });
    expect(await manager.applyPending()).toBe('applied');
    expect(ids(messages.slice(1))).toEqual(['c']);
  });

  it('guards against a commit from a synchronous carry callback', async () => {
    const holder: { manager?: ReturnType<typeof setup>['manager'] } = {};
    const nested: Promise<unknown>[] = [];
    const collect = vi.fn<CheckpointHooks['collectCheckpointCarry']>(() => {
      if (collect.mock.calls.length === 1) {
        holder.manager?.commit({ coversThroughMessageId: 'b', summary: 's2' });
        nested.push(holder.manager!.applyPending());
      }
      return Promise.resolve([]);
    });
    const { manager, messages } = setup([msg('a'), msg('b'), msg('c')], {
      collectCheckpointCarry: collect,
    });
    holder.manager = manager;
    manager.commit({ coversThroughMessageId: 'a', summary: 's1' });

    expect(await manager.applyPending()).toBe('applied');
    expect(await nested[0]).toBe('none');
    expect(collect).toHaveBeenCalledOnce();
    expect(manager.hasPending).toBe(true);

    expect(await manager.applyPending()).toBe('applied');
    expect(ids(messages.slice(1))).toEqual(['c']);
  });

  it('returns none while another apply is in flight', async () => {
    let release!: () => void;
    const { manager } = setup([msg('a'), msg('b')], {
      runCheckpointApplyingHooks: vi.fn(
        () =>
          new Promise<{ defer: boolean }>((resolve) => {
            release = () => resolve({ defer: false });
          }),
      ),
    });
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    const first = manager.applyPending();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await manager.applyPending()).toBe('none');
    release();
    expect(await first).toBe('applied');
  });

  it('applies a newer commit only on the next call when it lands mid-apply', async () => {
    let release!: () => void;
    const hooks = vi
      .fn<CheckpointHooks['runCheckpointApplyingHooks']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ defer: false });
          }),
      )
      .mockResolvedValue({ defer: false });
    const { manager, messages } = setup([msg('a'), msg('b'), msg('c')], {
      runCheckpointApplyingHooks: hooks,
    });
    manager.commit({ coversThroughMessageId: 'a', summary: 'first' });
    const first = manager.applyPending();
    await vi.waitFor(() => expect(release).toBeDefined());
    manager.commit({ coversThroughMessageId: 'b', summary: 'second' });
    release();

    expect(await first).toBe('applied');
    expect(manager.hasPending).toBe(true);
    expect(await manager.applyPending()).toBe('applied');
    expect(ids(messages.slice(1))).toEqual(['c']);
    expect(messages[0]?.parts[0]).toMatchObject({
      data: { summary: 'second' },
    });
  });

  it('lets an in-flight apply finish after close but starts no new one', async () => {
    let closed = false;
    let release!: () => void;
    const { manager, messages, commitCheckpoint } = setup(
      [msg('a'), msg('b')],
      {
        runCheckpointApplyingHooks: vi.fn(
          () =>
            new Promise<{ defer: boolean }>((resolve) => {
              release = () => resolve({ defer: false });
            }),
        ),
      },
      { isClosed: () => closed },
    );
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });
    const apply = manager.applyPending();
    await vi.waitFor(() => expect(release).toBeDefined());
    closed = true;
    const settled = manager.whenSettled();
    release();
    await settled;

    expect(await apply).toBe('applied');
    expect(commitCheckpoint).toHaveBeenCalledOnce();
    expect(isCheckpointHeader(messages[0])).toBe(true);

    messages.push(msg('c'));
    expect(
      manager.commit({ coversThroughMessageId: 'b', summary: 'x' }).status,
    ).toBe('pending');
    expect(await manager.applyPending()).toBe('none');
    expect(manager.hasPending).toBe(true);
  });

  it('stops before persisting once abandoned', async () => {
    let abandoned = false;
    const { manager, messages, commitCheckpoint } = setup(
      [msg('a'), msg('b')],
      {
        runCheckpointApplyingHooks: vi.fn(async () => {
          abandoned = true;
          return { defer: false };
        }),
      },
      { isAbandoned: () => abandoned },
    );
    manager.commit({ coversThroughMessageId: 'a', summary: 's' });

    expect(await manager.applyPending()).toBe('abandoned');
    expect(commitCheckpoint).not.toHaveBeenCalled();
    expect(ids(messages)).toEqual(['a', 'b']);
  });
});

describe('runInferenceHistoryTransformers — compacted flag', () => {
  it('flags hasCompacted when the window starts with a header', async () => {
    const handler = makeExtensionHandler() as unknown as ExtensionHandler;
    const withHeader = await runInferenceHistoryTransformers(
      handler,
      [headerMsg('h'), msg('a')],
      {} as never,
    );
    const plain = await runInferenceHistoryTransformers(
      handler,
      [msg('a')],
      {} as never,
    );
    expect(withHeader.flags.hasCompacted).toBe(true);
    expect(plain.flags.hasCompacted).toBeUndefined();
  });
});

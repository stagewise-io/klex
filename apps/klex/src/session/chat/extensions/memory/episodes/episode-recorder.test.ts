import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ExtendedUIMessage } from '../../../message-types';
import type { EpisodeStore } from './episode-files';
import type { EpisodeRecordInput } from './episode-format';
import { createEpisodeRecorder } from './episode-recorder';
import { output } from './test-utils';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));

function message(id: string, text: string): ExtendedUIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

function harness(
  history: ExtendedUIMessage[],
  append: (
    records: readonly EpisodeRecordInput[],
  ) => Promise<void> = async () => {},
) {
  const store = {
    append: vi.fn(append),
    introspect: vi.fn(() => null),
    observeActivity: vi.fn(async () => {}),
  } as unknown as EpisodeStore;
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as ModuleLogger;
  const recorder = createEpisodeRecorder({
    getHistory: () => history,
    store,
    logger,
  });
  return { logger, recorder, store };
}

describe('EpisodeRecorder', () => {
  it('advances the cursor only after append succeeds', async () => {
    const history = [message('a1', 'first')];
    const { recorder, store } = harness(history);
    await recorder.flush();
    expect(store.append).toHaveBeenCalledOnce();
    expect(recorder.introspect().cursor).toBe('a1');
  });

  it('retries a failed append without advancing or duplicating', async () => {
    const history = [message('a1', 'first')];
    let fail = true;
    const { recorder, store } = harness(history, async () => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
    });
    await expect(recorder.flush()).resolves.toBe(false);
    expect(recorder.introspect().cursor).toBeNull();
    await expect(recorder.flush()).resolves.toBe(true);
    expect(store.append).toHaveBeenCalledTimes(2);
    expect(recorder.introspect().lastError).toBeNull();
  });

  it('records messages added during append on the next flush', async () => {
    const history = [message('a1', 'first')];
    let added = false;
    const { recorder, store } = harness(history, async () => {
      if (!added) {
        added = true;
        history.push(message('a2', 'second'));
      }
    });
    await recorder.flush();
    expect(store.append).toHaveBeenCalledWith([output('first', 'a1')]);
    await recorder.flush();
    expect(store.append).toHaveBeenLastCalledWith([output('second', 'a2')]);
  });

  it('keeps an ID cursor stable when earlier messages leave the window', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { recorder, store } = harness(history);
    await recorder.flush();
    history.splice(0, 1);
    history.push(message('a3', 'third'));
    await recorder.flush();
    expect(store.append).toHaveBeenLastCalledWith([output('third', 'a3')]);
    expect(recorder.introspect().cursor).toBe('a3');
  });

  it('seeds past a restored window without recording it', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { recorder, store } = harness(history);
    recorder.seed(history);
    await recorder.flush();
    expect(store.append).not.toHaveBeenCalled();
    history.push(message('a3', 'third'));
    await recorder.flush();
    expect(store.append).toHaveBeenCalledWith([output('third', 'a3')]);
  });

  it('re-points a dropped cursor to the checkpoint header', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { recorder, store } = harness(history);
    await recorder.flush();
    recorder.repoint(['a1', 'a2'], 'cp');
    expect(recorder.introspect().cursor).toBe('cp');
    history.splice(0, 2, message('cp', 'header'), message('a3', 'third'));
    await recorder.flush();
    expect(store.append).toHaveBeenLastCalledWith([output('third', 'a3')]);
  });

  it('leaves a cursor in the tail untouched on re-point', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { recorder } = harness(history);
    await recorder.flush();
    recorder.repoint(['a1'], 'cp');
    expect(recorder.introspect().cursor).toBe('a2');
  });

  it('skips to the window end without duplicates when the cursor is gone', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { logger, recorder, store } = harness(history);
    await recorder.flush();
    history.splice(0, 2, message('b1', 'other'));
    await expect(recorder.flush()).resolves.toBe(true);
    expect(store.append).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(recorder.introspect().cursor).toBe('b1');
  });
});

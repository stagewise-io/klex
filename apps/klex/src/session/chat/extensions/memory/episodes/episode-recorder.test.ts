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
    expect(recorder.introspect().cursor).toEqual({ id: 'a1', index: 0 });
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
    await recorder.flush();
    expect(recorder.introspect().cursor).toBeNull();
    await recorder.flush();
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

  it('rescopes safely when the cursor message disappeared', async () => {
    const history = [message('a1', 'first'), message('a2', 'second')];
    const { recorder } = harness(history);
    await recorder.flush();
    history.splice(0, 1);
    history.push(message('a3', 'third'));
    await recorder.flush();
    expect(recorder.introspect().cursor?.id).toBe('a3');
  });
});

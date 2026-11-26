import { describe, expect, it, vi } from 'vitest';

import {
  blockPartTransformer,
  createDataPart,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { dataBlock, field, renderDataBlock } from './blocks';
import { compactDataBlocks, createDataPartDispatcher } from './data-parts';
import { createHistoryView } from './history-view';
import type { HistoryFilterOptions } from './types';

const filter: HistoryFilterOptions = {
  text: false,
  reasoning: false,
  tools: false,
  context: false,
  summary: false,
  dataParts: { keys: ['sample'] },
};
const message = (id: string): ExtendedUIMessage => ({
  id,
  role: 'user',
  parts: [createDataPart('sample', { content: id }) as never],
});

describe('shared data-part projection', () => {
  it.each(['toString', '__proto__', 'constructor'])(
    'ignores inherited registry key %s',
    (key) => {
      const dispatcher = createDataPartDispatcher({});
      expect(dispatcher.project(key, {}, 0)).toEqual([]);
      expect(dispatcher.materialize(key, {}, 0)).toEqual([]);
    },
  );
  it('reuses live blocks without requoting their policies', () => {
    const transformer = blockPartTransformer<{ content: string }>((data) => [
      dataBlock(
        'sample',
        { id: 'safe', ...data },
        { sources: { id: 'trusted' } },
      ),
    ]);
    const blocks = transformer({ content: 'outside' }, 0);
    const view = createHistoryView({
      filter,
      transformers: { sample: transformer },
    });
    const history = [
      {
        ...message('one'),
        parts: [createDataPart('sample', { content: 'outside' }) as never],
      },
    ];
    expect(view.render(history).text).toBe(renderDataBlock(blocks[0]!));
    expect(view.render(history).text).toContain('¦ outside');
    expect(view.render(history).text).not.toContain('¦ #');
  });

  it('counts scoped and filtered parts without invoking omitted projections; resets each pass', () => {
    const project = vi.fn((_data: unknown, occurrence: number) => [
      dataBlock('sample', { occurrence }, 'trusted'),
    ]);
    const view = createHistoryView({
      filter: { ...filter, skipMessage: (m) => m.id === 'two' },
      transformers: { sample: blockPartTransformer(project) },
    });
    const history = [message('one'), message('two'), message('three')];
    for (let i = 0; i < 2; i++) {
      const result = view.render(history, {
        kind: 'after-cursor',
        cursor: 'one',
      });
      expect(result.text).toContain('occurrence: 2');
      expect(result.cursor).toBe('three');
    }
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('selects compact overrides only for history and applies key exclusions', () => {
    const live = vi.fn(() => [dataBlock('sample', 'full', 'bot')]);
    const compact = vi.fn(() => [dataBlock('sample', 'short', 'bot')]);
    const transformer = blockPartTransformer(live, compact);
    const dispatcher = createDataPartDispatcher({ sample: transformer });
    expect(dispatcher.materialize('sample', {}, 0)[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('full'),
    });
    const result = createHistoryView({
      filter,
      transformers: { sample: transformer },
    }).render([message('one')]);
    expect(result.text).toContain('~ short');
    expect(live).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(
      createHistoryView({
        filter: { ...filter, dataParts: { keys: 'all', exclude: ['sample'] } },
        transformers: { sample: transformer },
      }).render([message('one')]).text,
    ).toBe('');
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('preserves nested trust and media order when compacting', () => {
    const media = {
      type: 'media' as const,
      kind: 'image' as const,
      mediaType: 'image/png',
      data: 'binary',
    };
    const blocks = [
      {
        type: 'sample',
        fields: [
          field('before', 'external long'),
          {
            key: 'nested',
            kind: 'fields' as const,
            fields: [field('fact', 'bot long', 'bot')],
          },
          { key: 'image', kind: 'media' as const, media },
          field('after', 'safe', 'trusted'),
        ],
      },
    ];
    const compact = compactDataBlocks(blocks, {
      limit: { max: 7, truncate: 'end' },
    });
    const text = renderDataBlock(compact[0]!);
    expect(text).toContain('¦ extern…');
    expect(text).toContain('~ bot lo…');
    expect(text).toContain('¦ image image/png');
    expect(text.indexOf('before:')).toBeLessThan(text.indexOf('image:'));
    expect(text.indexOf('image:')).toBeLessThan(text.indexOf('after:'));
    expect(compactDataBlocks(blocks, { media: 'inline' })[0]).toEqual(
      blocks[0],
    );
  });
});

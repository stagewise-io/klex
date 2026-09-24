import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EpisodicMarkdownStore, parseEpisodeEntries } from './markdown-store';

describe('episodic Markdown store', () => {
  it('parses valid entries and ignores frontmatter/malformed lines', () => {
    const entries = parseEpisodeEntries(
      '---\nanalyzed: false\n---\n\n- 09:04: I completed the task\ninvalid\n- 09:05: « цитата »',
      '2026-01-02/1-09-04.md',
    );
    expect(entries).toEqual([
      {
        relativeFile: '2026-01-02/1-09-04.md',
        entryOrdinal: 0,
        occurredAt: '2026-01-02T09:04:00Z',
        text: 'I completed the task',
      },
      {
        relativeFile: '2026-01-02/1-09-04.md',
        entryOrdinal: 1,
        occurredAt: '2026-01-02T09:05:00Z',
        text: '« цитата »',
      },
    ]);
  });

  it('lists multiple daily files and reads bounded neighbors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klex-memory-'));
    await mkdir(join(root, '2026-01-01'));
    await mkdir(join(root, '2026-01-02'));
    await writeFile(
      join(root, '2026-01-01', '1-10-00.md'),
      '---\nanalyzed: false\n---\n\n- 10:00: first\n- 10:01: second\n',
    );
    await writeFile(
      join(root, '2026-01-02', '1-11-00.md'),
      '---\nanalyzed: false\n---\n\n- 11:00: third\n',
    );
    const store = new EpisodicMarkdownStore(root);
    expect((await store.listFiles()).map((file) => file.relativeFile)).toEqual([
      '2026-01-01/1-10-00.md',
      '2026-01-02/1-11-00.md',
    ]);
    const entries = await store.read('2026-01-01/1-10-00.md');
    expect(await store.readNeighbors(entries[1]!, 1, 0)).toHaveLength(2);
  });
});

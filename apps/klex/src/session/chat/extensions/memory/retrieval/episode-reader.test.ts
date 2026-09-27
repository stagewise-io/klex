import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { episodeFile, input, output } from '../episodes/test-utils';
import { EpisodicEntryStore, parseEpisodeEntries } from './episode-reader';

const FILE = '2026-01-02/1-14-03.jsonl';
const AT = '2026-01-02T14:03:00.000Z';

describe('episode reader', () => {
  it('parses records into line-format entries', () => {
    const content = episodeFile(
      AT,
      input({
        kind: 'context',
        source: 'slack',
        metadata: 'from: U42',
        items: [],
      }),
      output('« цитата »'),
    );
    expect(parseEpisodeEntries(content, FILE)).toEqual([
      {
        relativeFile: FILE,
        entryOrdinal: 0,
        occurredAt: AT,
        text: 'context slack\n¦from: U42',
      },
      {
        relativeFile: FILE,
        entryOrdinal: 1,
        occurredAt: AT,
        text: 'your_output\n¦« цитата »',
      },
    ]);
  });

  it('skips a truncated tail and handles CRLF', () => {
    const content = episodeFile(AT, output('first'), output('second'));
    const truncated = content.slice(0, -10).replaceAll('\n', '\r\n');
    expect(
      parseEpisodeEntries(truncated, FILE).map((entry) => entry.text),
    ).toEqual(['your_output\n¦first']);
  });

  it('lists JSONL episodes only and reads bounded neighbors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klex-memory-'));
    await mkdir(join(root, '2026-01-01'));
    await mkdir(join(root, '2026-01-02'));
    await writeFile(
      join(root, '2026-01-01', '1-10-00.jsonl'),
      episodeFile(AT, output('first'), output('second')),
    );
    await writeFile(
      join(root, '2026-01-02', '1-11-00.jsonl'),
      episodeFile(AT, output('third')),
    );
    await writeFile(join(root, '2026-01-02', '2-12-00.md'), '- 12:00: old\n');
    const store = new EpisodicEntryStore(root);
    expect((await store.listFiles()).map((file) => file.relativeFile)).toEqual([
      '2026-01-01/1-10-00.jsonl',
      '2026-01-02/1-11-00.jsonl',
    ]);
    const entries = await store.read('2026-01-01/1-10-00.jsonl');
    expect(await store.readNeighbors(entries[1]!, 1, 0)).toHaveLength(2);
  });
});

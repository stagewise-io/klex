import { describe, expect, it } from 'vitest';

import {
  createEpisodeRecordEntry,
  episodeEntryText,
  parseEpisodeRecordLine,
} from './episode-format';
import { HEADER_LINE, input, output, recordLine } from './test-utils';

const AT = '2026-01-02T10:00:00.000Z';

describe('episode format', () => {
  it('round-trips a record line', () => {
    const record = input(
      { kind: 'tool', name: 'send', status: 'succeeded', output: 'ok' },
      { omittedRecords: 2 },
    );
    expect(parseEpisodeRecordLine(recordLine(record, AT))).toEqual(
      createEpisodeRecordEntry(record, new Date(AT)),
    );
  });

  it('renders the line-format text including omission markers', () => {
    const entry = parseEpisodeRecordLine(
      recordLine({ ...output('hello'), omittedRecords: 3 }, AT),
    );
    expect(episodeEntryText(entry!)).toBe(
      'your_output\n¦hello\n[… 3 more parts]',
    );
  });

  it('skips headers, blank, truncated, and invalid lines', () => {
    const valid = recordLine(output('x'), AT);
    expect(parseEpisodeRecordLine(HEADER_LINE)).toBeNull();
    expect(parseEpisodeRecordLine('  ')).toBeNull();
    expect(parseEpisodeRecordLine(valid.slice(0, 20))).toBeNull();
    expect(parseEpisodeRecordLine('{"kind":"record","v":1}')).toBeNull();
    expect(
      parseEpisodeRecordLine(valid.replace('"assistant"', '"robot"')),
    ).toBeNull();
  });

  it('ignores unknown extra fields', () => {
    const line = JSON.stringify({
      ...createEpisodeRecordEntry(output('x'), new Date(AT)),
      extra: true,
    });
    expect(parseEpisodeRecordLine(line)?.record).toEqual({
      kind: 'text',
      text: 'x',
    });
  });
});

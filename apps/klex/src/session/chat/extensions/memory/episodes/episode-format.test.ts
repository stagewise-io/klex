import { describe, expect, it } from 'vitest';

import {
  createEpisodeRecordEntry,
  episodeEntryText,
  parseEpisodeRecordLine,
  renderEpisodeText,
} from './episode-format';
import {
  episodeFile,
  HEADER_LINE,
  input,
  output,
  recordLine,
} from './test-utils';

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

describe('renderEpisodeText', () => {
  it('renders blocks with UTC time prefixes in file order', () => {
    const content =
      HEADER_LINE +
      recordLine(output('first'), '2026-01-02T23:05:59.999Z') +
      recordLine(
        input(
          { kind: 'tool', name: 'send', status: 'failed', error: 'boom' },
          { messageId: 'm2', omittedRecords: 1 },
        ),
        '2026-01-02T23:06:00.000Z',
      );
    const tool = parseEpisodeRecordLine(content.split('\n')[2] ?? '');
    expect(renderEpisodeText(content)).toBe(
      `23:05 your_output\n¦first\n\n23:06 ${tool && episodeEntryText(tool)}`,
    );
  });

  it('omits time prefixes when timestamps are disabled', () => {
    const content = episodeFile(AT, output('a'), output('b'));
    expect(renderEpisodeText(content, { timestamps: false })).toBe(
      'your_output\n¦a\n\nyour_output\n¦b',
    );
  });

  it('skips header, invalid, and truncated lines; handles CRLF', () => {
    const valid = recordLine(output('kept'), AT);
    const content = `${HEADER_LINE}not json\r\n${valid.replace('\n', '\r\n')}${valid.slice(0, 20)}`;
    expect(renderEpisodeText(content)).toBe('10:00 your_output\n¦kept');
  });

  it('renders an episode without records as empty text', () => {
    expect(renderEpisodeText(HEADER_LINE)).toBe('');
    expect(renderEpisodeText('')).toBe('');
  });
});

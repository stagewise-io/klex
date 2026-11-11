import { getEncoding } from 'js-tiktoken';
import { describe, expect, it, vi } from 'vitest';

import type { McpConnection } from './connection';
import { buildMcpRegistry, type RegisteredMcpNamespace } from './registry';
import { createToolSearch } from './tool-search';

function catalog(names: string[], description = ''): RegisteredMcpNamespace {
  return buildMcpRegistry(
    new Map([
      [
        's',
        {
          tools: names.map((name) => ({
            name,
            description,
            inputSchema: { type: 'object' as const },
          })),
        } as unknown as McpConnection,
      ],
    ]),
  ).get('s')!;
}

describe('bounded MCP search', () => {
  it.each([
    'create issue',
    'create_issue',
    'createIssue',
    'CREATE ISSUE',
    'create issues',
    'creat issue',
    'unknown | create issue',
    'create*',
    'create?ssue',
  ])('finds an identifier in one shot: %s', (query) => {
    const search = createToolSearch();
    const source = catalog(['unrelated', 'createIssue']);
    expect(
      search.list('s', query, 0, 'a', source).items.map(([name]) => name),
    ).toContain('createIssue');
  });

  it('splits acronym/digit boundaries, normalizes Unicode, ANDs across fields and deduplicates', () => {
    const search = createToolSearch();
    const source = catalog(
      ['HTTPServer2', 'café', 'createIssue'],
      'tracking records',
    );
    for (const query of [
      'HTTP server 2',
      'HTTP\u2003server 2',
      'http http server 2',
    ])
      expect(search.list('s', query, 0, 'a', source).items[0]?.[0]).toBe(
        'HTTPServer2',
      );
    expect(search.list('s', 'cafe\u0301', 0, 'a', source).items[0]?.[0]).toBe(
      'café',
    );
    expect(
      search.list('s', 'create tracking', 0, 'a', source).items[0]?.[0],
    ).toBe('createIssue');
    expect(search.list('s', 'create missing', 0, 'a', source).items).toEqual(
      [],
    );
    for (const query of ['%', '[]', '\\', '"'])
      expect(search.list('s', query, 0, 'a', source).items).toEqual([]);
  });

  it('does not treat distinct punctuation-only identifiers as equivalent', () => {
    const search = createToolSearch();
    const source = catalog(['[]', '%', '\\\\']);
    expect(
      search.list('s', '%', 0, 'a', source).items.map(([name]) => name),
    ).toEqual(['%']);
  });

  it('bounds maximum catalogs and adversarial search work', () => {
    const search = createToolSearch();
    const source = catalog(
      Array.from({ length: 10000 }, (_, i) => `createIssue${i}`),
      'tracking tickets',
    );
    const start = performance.now();
    const heap = process.memoryUsage().heapUsed;
    const first = search.list('s', 'creat issues', 0, 'scale', source);
    expect(first.total).toBe(10000);
    expect(first.items).toHaveLength(10);
    console.info('MCP maximum catalog baseline', {
      coldMs: performance.now() - start,
      heapDeltaBytes: process.memoryUsage().heapUsed - heap,
    });
    expect(() =>
      search.list(
        's',
        '',
        0,
        'a',
        catalog(Array.from({ length: 10001 }, (_, i) => `t${i}`)),
      ),
    ).toThrow('10000');
    expect(() =>
      search.list('s', '', 0, 'a', catalog(['t'], 'x'.repeat(5 * 1024 * 1024))),
    ).toThrow('5 MiB');
    const terms = Array.from(
      { length: 32 },
      (_, i) => `missing${String.fromCharCode(97 + i)}`,
    ).join(' ');
    expect(() => search.list('s', terms, 0, 'scale', source)).toThrow(
      'work budget',
    );
    expect(search.list('s', 'create*', 0, 'scale', source).total).toBe(10000);
  });

  it('uses exact relevance before popularity and ages usage after 1000 dispatches', () => {
    const search = createToolSearch();
    const source = catalog(['issueArchive', 'issue']);
    search.dispatched('s', 'issueArchive');
    expect(search.list('s', 'issue', 0, 'a', source).items[0]?.[0]).toBe(
      'issue',
    );
    search.dispatched('s', 'issue');
    expect(search.list('s', '', 0, 'a', source).items[0]?.[0]).toBe('issue');
    for (let i = 0; i < 1000; i++) search.dispatched('other', 'x');
    expect(search.list('s', '', 0, 'a', source).items[0]?.[0]).toBe(
      'issueArchive',
    );
  });

  it('freezes scans, isolates sessions, invalidates generations and releases handles', () => {
    const search = createToolSearch();
    const source = catalog(Array.from({ length: 23 }, (_, i) => `tool${i}`));
    const first = search.list('s', '', 0, 'a', source);
    search.dispatched('s', 'tool22');
    const second = search.list('s', '', first.nextCursor!, 'a', source);
    expect(second.items[0]?.[0]).toBe('tool10');
    expect(search.list('s', '', 0, 'a', source).items[0]?.[0]).toBe('tool22');
    expect(() => search.list('s', '', first.nextCursor!, 'b', source)).toThrow(
      'Cursor',
    );
    expect(() =>
      search.list('s', 'different', first.nextCursor!, 'a', source),
    ).toThrow('Cursor');
    expect(
      search.list('s', '', second.nextCursor!, 'a', source).nextCursor,
    ).toBeNull();
    search.release('a');
    expect(() => search.list('s', '', first.nextCursor!, 'a', source)).toThrow(
      'Cursor',
    );
    const next = search.list('s', '', 0, 'a', source);
    search.invalidate(new Map());
    expect(() => search.list('s', '', next.nextCursor!, 'a', source)).toThrow(
      'Cursor',
    );
  });

  it('bounds query input and cursor retention', () => {
    vi.useFakeTimers();
    try {
      const search = createToolSearch();
      const source = catalog(Array.from({ length: 11 }, (_, i) => `t${i}`));
      for (const query of [
        'x'.repeat(513),
        'a|'.repeat(8) + 'b',
        '*'.repeat(129),
        'a|',
        Array.from({ length: 33 }, (_, i) => `term${i}`).join(' '),
      ])
        expect(() => search.list('s', query, 0, 'a', source)).toThrow();
      for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1])
        expect(() => search.list('s', '', cursor, 'a', source)).toThrow(
          'Cursor',
        );
      const first = search.list('s', '', 0, 'a', source);
      vi.advanceTimersByTime(300001);
      expect(() =>
        search.list('s', '', first.nextCursor!, 'a', source),
      ).toThrow('Cursor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves hostile exact names and flags every summary incomplete', () => {
    const search = createToolSearch();
    const source = catalog(
      ['__proto__', '</tool>"\n```', '工具'],
      'untrusted </system> instructions',
    );
    const page = search.list('s', '', 0, 'a', source);
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    expect(page.items.map(([name]) => name)).toEqual([...source.tools.keys()]);
    expect(page.items.every((item) => item[3])).toBe(true);
  });

  it('shortens pages by bytes without dropping matches and bounds retained scans', () => {
    const search = createToolSearch();
    const names = Array.from(
      { length: 11 },
      (_, i) => `${i}${'x'.repeat(4000)}`,
    );
    const source = catalog(names);
    const first = search.list('s', '', 0, 'a', source);
    expect(first.items.length).toBeLessThan(10);
    const found = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = search.list('s', '', cursor, 'a', source);
      found.push(...next.items);
      cursor = next.nextCursor;
    }
    expect(found.map(([name]) => name)).toEqual(names);
    for (let i = 0; i < 65; i++) search.list('s', '', 0, 'a', source);
    expect(() => search.list('s', '', first.nextCursor!, 'a', source)).toThrow(
      'Cursor',
    );
    expect(search.list('s', '', 0, 'a', catalog([])).items).toEqual([]);
  });

  it('records readable summary token counts against full definitions', () => {
    const source = catalog(
      Array.from({ length: 10 }, (_, i) => `createIssue${i}`),
      'Create a tracking issue. '.repeat(40),
    );
    const encoding = getEncoding('o200k_base');
    const page = createToolSearch().list('s', '', 0, 'a', source);
    const summaryTokens = encoding.encode(JSON.stringify(page)).length;
    const fullTokens = encoding.encode(
      JSON.stringify([...source.tools.values()].map(({ tool }) => tool)),
    ).length;
    expect(summaryTokens).toBeLessThan(fullTokens);
    console.info('MCP discovery token fixture', { summaryTokens, fullTokens });
  });

  it('records cold/warm catalog benchmark baselines', () => {
    const source = catalog(
      Array.from({ length: 1000 }, (_, i) => `createIssue${i}`),
      'Create a tracking issue',
    );
    const search = createToolSearch();
    const started = performance.now();
    search.list('s', 'creat issues', 0, 'a', source);
    const coldMs = performance.now() - started;
    const warmStart = performance.now();
    for (let i = 0; i < 20; i++)
      search.list('s', 'creat issues', 0, 'a', source);
    console.info('MCP search baseline', {
      tools: 1000,
      coldMs,
      warmMeanMs: (performance.now() - warmStart) / 20,
      heapBytes: process.memoryUsage().heapUsed,
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  createResourceSnapshot,
  deletedResource,
  diffResource,
  formatInitialContent,
  MAX_RESOURCE_BINARY_BYTES,
  ResourceSizeLimitError,
  type ResourceSnapshot,
} from './resource-handlers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textSnapshot(
  uri: string,
  text: string,
  mimeType?: string,
): ResourceSnapshot {
  return {
    uri,
    mimeType,
    contents: {
      contents: [{ uri, mimeType: mimeType ?? 'text/plain', text }],
    },
  };
}

function jsonSnapshot(uri: string, json: unknown): ResourceSnapshot {
  return {
    uri,
    mimeType: 'application/json',
    contents: {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify(json) },
      ],
    },
  };
}

function imageSnapshot(
  uri: string,
  blob: string,
  mimeType = 'image/png',
): ResourceSnapshot {
  return {
    uri,
    mimeType,
    contents: {
      contents: [{ uri, mimeType, blob }],
    },
  };
}

// ---------------------------------------------------------------------------
// Text diff strategy
// ---------------------------------------------------------------------------

describe('resource-diff: text strategy', () => {
  it('produces a text-diff for a 1-line change', () => {
    const old = textSnapshot('file:///log.txt', 'line1\nline2\nline3');
    const new_ = textSnapshot('file:///log.txt', 'line1\nline2-changed\nline3');
    const result = diffResource(old, new_);

    expect(result.kind).toBe('text-diff');
    if (result.kind !== 'text-diff') return;
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
    expect(result.patch).toContain('-');
    expect(result.patch).toContain('+');
    expect(result.patch).toContain('line2-changed');
  });

  it('produces full replacement for a 50% change', () => {
    const old = textSnapshot('file:///log.txt', 'line1\nline2');
    const new_ = textSnapshot(
      'file:///log.txt',
      'line1-changed\nline2-changed',
    );
    const result = diffResource(old, new_);

    expect(result.kind).toBe('full');
    if (result.kind !== 'full') return;
    expect(result.reason).toBe('significant-change');
  });

  it('falls back before allocating a quadratic matrix for many short lines', () => {
    const oldText = Array.from({ length: 3_000 }, () => 'a').join('\n');
    const newText = Array.from({ length: 3_000 }, () => 'b').join('\n');

    const result = diffResource(
      textSnapshot('file:///many-lines.txt', oldText),
      textSnapshot('file:///many-lines.txt', newText),
    );

    expect(result.kind).toBe('full');
  });

  it('returns unchanged for identical text', () => {
    const old = textSnapshot('file:///log.txt', 'same text');
    const new_ = textSnapshot('file:///log.txt', 'same text');

    expect(diffResource(old, new_)).toEqual({ kind: 'unchanged', content: [] });
  });

  it('emits separate bounded hunks for distant changes', () => {
    const lines = Array.from(
      { length: 200 },
      (_, index) => `line-${index + 1}`,
    );
    const changed = [...lines];
    changed[4] = 'line-5-changed';
    changed[194] = 'line-195-changed';

    const result = diffResource(
      textSnapshot('file:///long.txt', lines.join('\n')),
      textSnapshot('file:///long.txt', changed.join('\n')),
    );

    expect(result.kind).toBe('text-diff');
    if (result.kind !== 'text-diff') return;
    expect(result.linesAdded).toBe(2);
    expect(result.linesRemoved).toBe(2);
    expect(result.patch.match(/@@/g)).toHaveLength(4);
    expect(result.patch).not.toContain('line-100');
  });
});

// ---------------------------------------------------------------------------
// JSON diff strategy
// ---------------------------------------------------------------------------

describe('resource-diff: JSON strategy', () => {
  it('normalizes case and parameters before selecting JSON diffing', () => {
    const old = textSnapshot(
      'file:///config.json',
      '{"value":1,"stable":true,"other":null}',
      'Application/JSON; Charset=UTF-8',
    );
    const new_ = textSnapshot(
      'file:///config.json',
      '{"value":2,"stable":true,"other":null}',
      'Application/JSON; Charset=UTF-8',
    );

    expect(diffResource(old, new_).kind).toBe('json-diff');
  });

  it('routes structured JSON suffixes through structural diffing', () => {
    const old = textSnapshot(
      'file:///problem',
      '{"detail":"old","status":400,"title":"Problem"}',
      'application/problem+json',
    );
    const new_ = textSnapshot(
      'file:///problem',
      '{"detail":"new","status":400,"title":"Problem"}',
      'application/problem+json',
    );

    expect(diffResource(old, new_).kind).toBe('json-diff');
  });

  it('renders every document in a multi-entry JSON resource', () => {
    const snapshot: ResourceSnapshot = {
      uri: 'file:///multi.json',
      mimeType: 'application/json',
      contents: {
        contents: [
          {
            uri: 'file:///one.json',
            mimeType: 'application/json',
            text: '{"one":1}',
          },
          {
            uri: 'file:///two.json',
            mimeType: 'application/json',
            text: '{"two":2}',
          },
        ],
      },
    };

    const content = formatInitialContent(snapshot);

    expect(content).toHaveLength(2);
    expect(content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"one": 1'),
      }),
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"two": 2'),
      }),
    ]);
  });

  it('falls back to blob formatting for JSON MIME without text content', () => {
    const content = formatInitialContent({
      uri: 'file:///encoded.json',
      mimeType: 'application/json',
      contents: {
        contents: [
          {
            uri: 'file:///encoded.json',
            mimeType: 'application/json',
            blob: 'eyJ2YWx1ZSI6MX0=',
          },
        ],
      },
    });

    expect(content).toEqual([
      {
        type: 'text',
        text: 'Blob content (mimeType: application/json, base64-encoded):\neyJ2YWx1ZSI6MX0=',
      },
    ]);
  });

  it('reports an update limited to a later JSON content entry', () => {
    const createMultiEntrySnapshot = (
      secondValue: number,
    ): ResourceSnapshot => ({
      uri: 'file:///multi.json',
      mimeType: 'application/json',
      contents: {
        contents: [
          {
            uri: 'file:///one.json',
            mimeType: 'application/json',
            text: '{"one":1}',
          },
          {
            uri: 'file:///two.json',
            mimeType: 'application/json',
            text: JSON.stringify({ two: secondValue }),
          },
        ],
      },
    });

    const result = diffResource(
      createMultiEntrySnapshot(2),
      createMultiEntrySnapshot(3),
    );

    expect(result.kind).toBe('json-diff');
    if (result.kind !== 'json-diff') return;
    expect(result.updated).toEqual([
      {
        key: '2:file:///two.json',
        oldValue: '{"two":2}',
        newValue: '{"two":3}',
      },
    ]);
    expect(result.summary).toContain(
      '2:file:///two.json ({"two":2} → {"two":3})',
    );
  });

  it('returns unchanged for identical JSON', () => {
    const old = jsonSnapshot('file:///config.json', { a: 1 });
    const new_ = jsonSnapshot('file:///config.json', { a: 1 });

    expect(diffResource(old, new_)).toEqual({ kind: 'unchanged', content: [] });
  });
  it('produces json-diff for a key added', () => {
    const old = jsonSnapshot('file:///config.json', { a: 1, b: 2 });
    const new_ = jsonSnapshot('file:///config.json', { a: 1, b: 2, c: 3 });
    const result = diffResource(old, new_);

    expect(result.kind).toBe('json-diff');
    if (result.kind !== 'json-diff') return;
    expect(result.added).toEqual(['c']);
    expect(result.deleted).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('produces json-diff for a key updated', () => {
    const old = jsonSnapshot('file:///config.json', { a: 1, b: 2 });
    const new_ = jsonSnapshot('file:///config.json', { a: 1, b: 5 });
    const result = diffResource(old, new_);

    expect(result.kind).toBe('json-diff');
    if (result.kind !== 'json-diff') return;
    expect(result.updated).toHaveLength(1);
    expect(result.updated.at(0)?.key).toBe('b');
    expect(result.updated.at(0)?.oldValue).toBe('2');
    expect(result.updated.at(0)?.newValue).toBe('5');
  });

  it('produces json-diff for a key deleted', () => {
    const old = jsonSnapshot('file:///config.json', { a: 1, b: 2 });
    const new_ = jsonSnapshot('file:///config.json', { a: 1 });
    const result = diffResource(old, new_);

    expect(result.kind).toBe('json-diff');
    if (result.kind !== 'json-diff') return;
    expect(result.deleted).toEqual(['b']);
  });

  it('falls back to full replacement for massive change (>50% keys)', () => {
    const old = jsonSnapshot('file:///config.json', { a: 1, b: 2 });
    const new_ = jsonSnapshot('file:///config.json', { c: 3, d: 4 });
    const result = diffResource(old, new_);

    expect(result.kind).toBe('full');
    if (result.kind !== 'full') return;
    expect(result.reason).toBe('significant-change');
  });

  it('falls back to text strategy on parse failure', () => {
    const old: ResourceSnapshot = {
      uri: 'file:///bad.json',
      mimeType: 'application/json',
      contents: {
        contents: [
          {
            uri: 'file:///bad.json',
            mimeType: 'application/json',
            text: 'not json{',
          },
        ],
      },
    };
    const new_: ResourceSnapshot = {
      uri: 'file:///bad.json',
      mimeType: 'application/json',
      contents: {
        contents: [
          {
            uri: 'file:///bad.json',
            mimeType: 'application/json',
            text: 'not json{ changed',
          },
        ],
      },
    };
    const result = diffResource(old, new_);

    // Should either be text-diff or full, not json-diff
    expect(result.kind).not.toBe('json-diff');
  });

  it('falls back to text strategy for non-object JSON (array)', () => {
    const old = jsonSnapshot('file:///arr.json', [1, 2, 3]);
    const new_ = jsonSnapshot('file:///arr.json', [1, 2, 3, 4]);
    const result = diffResource(old, new_);

    expect(result.kind).not.toBe('json-diff');
  });
});

// ---------------------------------------------------------------------------
// Image diff strategy
// ---------------------------------------------------------------------------

describe('resource-diff: image strategy', () => {
  it('rejects images above the decoded binary input limit', () => {
    const blob = Buffer.alloc(MAX_RESOURCE_BINARY_BYTES + 1).toString('base64');

    expect(() =>
      createResourceSnapshot('file:///oversized.png', {
        contents: [
          { uri: 'file:///oversized.png', mimeType: 'image/png', blob },
        ],
      }),
    ).toThrow(ResourceSizeLimitError);
  });

  it.each(['not-base64!', 'Zh=='])(
    'rejects invalid or non-canonical base64 blob data',
    (blob) => {
      expect(() =>
        createResourceSnapshot('file:///invalid.png', {
          contents: [
            { uri: 'file:///invalid.png', mimeType: 'image/png', blob },
          ],
        }),
      ).toThrow(/invalid base64|non-canonical base64/);
    },
  );

  it('always produces full replacement', () => {
    const old = imageSnapshot('file:///img.png', 'oldbase64data');
    const new_ = imageSnapshot('file:///img.png', 'newbase64data');
    const result = diffResource(old, new_);

    expect(result.kind).toBe('full');
    if (result.kind !== 'full') return;
    expect(result.reason).toBe('significant-change');
    // Content should be an image block
    expect(result.content).toHaveLength(1);
    expect(result.content.at(0)?.type).toBe('image');
  });
});

// ---------------------------------------------------------------------------
// Deleted resource
// ---------------------------------------------------------------------------

describe('resource-diff: deleted resource', () => {
  it('produces full with reason deleted', () => {
    const result = deletedResource('file:///gone.txt', 'github');

    expect(result.kind).toBe('full');
    if (result.kind !== 'full') return;
    expect(result.reason).toBe('deleted');
    expect(result.content).toHaveLength(1);
    expect(result.content.at(0)?.type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Empty content edge cases
// ---------------------------------------------------------------------------

describe('resource-diff: empty content', () => {
  it('formatInitialContent handles empty contents array', () => {
    const snapshot: ResourceSnapshot = {
      uri: 'file:///empty.txt',
      mimeType: 'text/plain',
      contents: { contents: [] },
    };
    const content = formatInitialContent(snapshot);
    expect(content).toHaveLength(1);
    expect(content.at(0)?.type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// formatInitialContent
// ---------------------------------------------------------------------------

describe('resource-diff: formatInitialContent', () => {
  it('formats JSON content with pretty-printing', () => {
    const snapshot = jsonSnapshot('file:///config.json', { key: 'value' });
    const content = formatInitialContent(snapshot);
    expect(content).toHaveLength(1);
    const first = content.at(0);
    expect(first?.type).toBe('text');
    if (first?.type !== 'text') return;
    expect(first.text).toContain('JSON content');
    expect(first.text).toContain('"key"');
    expect(first.text).toContain('"value"');
  });

  it('formats image content as image block', () => {
    const snapshot = imageSnapshot('file:///img.png', 'base64data');
    const content = formatInitialContent(snapshot);
    expect(content).toHaveLength(1);
    expect(content.at(0)?.type).toBe('image');
  });
});

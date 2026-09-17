import type { FilePart, TextPart } from 'ai';

import {
  buildResourceAttrs,
  type ContextDataContent,
  escCData,
  extractText,
  MAX_LCS_CELLS,
  MAX_RESOURCE_TEXT_CHARS,
  type ResourceDiffResult,
  type ResourceHandler,
  type ResourceSnapshot,
  type ResourceStateData,
  renderFullContent,
  TEXT_DIFF_MAX_CHANGED_LINES,
  TEXT_DIFF_MIN_FRACTION,
  truncate,
} from './helpers';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const textHandler: ResourceHandler = {
  matches(mimeType) {
    // Text handler is the fallback — matches anything not JSON or image.
    return true;
  },

  diff(old, new_) {
    return diffText(old, new_);
  },

  formatInitialContent(snapshot) {
    return formatTextContent(snapshot);
  },

  render(data) {
    return renderText(data);
  },
};

// ---------------------------------------------------------------------------
// Diff strategy: line-based LCS diff or full replacement
// ---------------------------------------------------------------------------

export function diffText(
  old: ResourceSnapshot,
  new_: ResourceSnapshot,
): ResourceDiffResult {
  const oldText = extractText(old.contents).slice(0, MAX_RESOURCE_TEXT_CHARS);
  const newText = extractText(new_.contents).slice(0, MAX_RESOURCE_TEXT_CHARS);
  if (
    oldText === newText &&
    old.contentFingerprint !== new_.contentFingerprint
  ) {
    return {
      kind: 'full',
      reason: 'significant-change',
      content: formatTextContent(new_),
    };
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return {
      kind: 'full',
      reason: 'significant-change',
      content: formatTextContent(new_),
    };
  }
  const operations = computeEditScript(oldLines, newLines);
  const changes = computeLineChanges(operations);
  const totalLines = Math.max(oldLines.length, newLines.length);
  const threshold = Math.max(
    TEXT_DIFF_MAX_CHANGED_LINES,
    Math.ceil(totalLines * TEXT_DIFF_MIN_FRACTION),
  );

  if (changes.added + changes.removed <= threshold) {
    const patch = buildUnifiedDiff(operations);
    if (Buffer.byteLength(patch, 'utf8') > MAX_RESOURCE_TEXT_CHARS) {
      return {
        kind: 'full',
        reason: 'significant-change',
        content: formatTextContent(new_),
      };
    }
    return {
      kind: 'text-diff',
      patch,
      linesAdded: changes.added,
      linesRemoved: changes.removed,
      content: [{ type: 'text', text: patch }],
    };
  }

  return {
    kind: 'full',
    reason: 'significant-change',
    content: formatTextContent(new_),
  };
}

export function formatTextContent(
  snapshot: ResourceSnapshot,
): ContextDataContent[] {
  const blocks: ContextDataContent[] = [];
  for (const c of snapshot.contents.contents) {
    if ('text' in c && c.text) {
      const header =
        c.mimeType != null
          ? `Text content (mimeType: ${c.mimeType})`
          : 'Text content';
      blocks.push({
        type: 'text',
        text: `${header}:\n${truncate(c.text, MAX_RESOURCE_TEXT_CHARS)}`,
      });
    } else if ('blob' in c && c.blob) {
      const header =
        c.mimeType != null
          ? `Blob content (mimeType: ${c.mimeType}, base64-encoded)`
          : 'Blob content (base64-encoded)';
      blocks.push({
        type: 'text',
        text: `${header}:\n${truncate(c.blob, MAX_RESOURCE_TEXT_CHARS)}`,
      });
    }
  }
  if (blocks.length === 0)
    blocks.push({ type: 'text', text: 'Resource returned no text content.' });
  return blocks;
}

// ---------------------------------------------------------------------------
// Render: text-diff and full content in <resource> blocks
// ---------------------------------------------------------------------------

function renderText(data: ResourceStateData): (TextPart | FilePart)[] {
  const attrs = buildResourceAttrs(data);
  const { diff, isInitial } = data;

  if (diff.kind === 'text-diff') {
    return [
      {
        type: 'text',
        text: `<resource ${attrs} type="update">\n<diff><![CDATA[${escCData(diff.patch)}]]></diff>\n</resource>`,
      },
    ];
  }

  // Full content (initial or replacement)
  return renderFullContent(attrs, diff.content, isInitial);
}

// ---------------------------------------------------------------------------
// LCS-based line-diff implementation
// ---------------------------------------------------------------------------

interface LineChanges {
  added: number;
  removed: number;
}

type EditOperation = {
  type: 'equal' | 'add' | 'remove';
  text: string;
  oldLine: number;
  newLine: number;
};

function computeEditScript(
  oldLines: string[],
  newLines: string[],
): EditOperation[] {
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint32Array(columns));
  const valueAt = (row: number, column: number) => dp[row]?.[column] ?? 0;

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const row = dp[oldIndex];
      if (!row) continue;
      row[newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? valueAt(oldIndex + 1, newIndex + 1) + 1
          : Math.max(
              valueAt(oldIndex + 1, newIndex),
              valueAt(oldIndex, newIndex + 1),
            );
    }
  }

  const operations: EditOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldText = oldLines[oldIndex];
    const newText = newLines[newIndex];
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldText === newText
    ) {
      operations.push({
        type: 'equal',
        text: oldText ?? '',
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex++;
      newIndex++;
    } else if (
      newIndex < newLines.length &&
      (oldIndex >= oldLines.length ||
        valueAt(oldIndex, newIndex + 1) >= valueAt(oldIndex + 1, newIndex))
    ) {
      operations.push({
        type: 'add',
        text: newText ?? '',
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      newIndex++;
    } else {
      operations.push({
        type: 'remove',
        text: oldText ?? '',
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex++;
    }
  }
  return operations;
}

function computeLineChanges(operations: EditOperation[]): LineChanges {
  return operations.reduce<LineChanges>(
    (changes, operation) => {
      if (operation.type === 'add') changes.added++;
      if (operation.type === 'remove') changes.removed++;
      return changes;
    },
    { added: 0, removed: 0 },
  );
}

function buildUnifiedDiff(operations: EditOperation[]): string {
  const context = 2;
  const changedIndexes = operations.flatMap((operation, index) =>
    operation.type === 'equal' ? [] : [index],
  );
  if (changedIndexes.length === 0) return '';

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end)
      previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  return ranges
    .map(({ start, end }) => {
      const hunk = operations.slice(start, end);
      const first = hunk[0];
      const oldCount = hunk.filter(
        (operation) => operation.type !== 'add',
      ).length;
      const newCount = hunk.filter(
        (operation) => operation.type !== 'remove',
      ).length;
      const lines = [
        `@@ -${first?.oldLine ?? 1},${oldCount} +${first?.newLine ?? 1},${newCount} @@`,
      ];
      for (const operation of hunk) {
        const prefix =
          operation.type === 'add'
            ? '+'
            : operation.type === 'remove'
              ? '-'
              : ' ';
        const line =
          operation.type === 'add' ? operation.newLine : operation.oldLine;
        lines.push(`${prefix} ${line}: ${operation.text}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

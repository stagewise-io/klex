import type { FilePart, TextPart } from 'ai';

import {
  buildResourceAttrs,
  type ContextDataContent,
  deepEqual,
  escCData,
  formatScalar,
  isJsonMime,
  JSON_FULL_CHANGE_FRACTION,
  MAX_RESOURCE_TEXT_CHARS,
  parseJsonContent,
  type ResourceDiffResult,
  type ResourceHandler,
  type ResourceSnapshot,
  type ResourceStateData,
  renderFullContent,
  truncate,
} from './helpers';
import { diffText, formatTextContent } from './text';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const jsonHandler: ResourceHandler = {
  matches(mimeType) {
    return isJsonMime(mimeType);
  },

  diff(old, new_) {
    return diffJson(old, new_);
  },

  formatInitialContent(snapshot) {
    return formatJsonContent(snapshot);
  },

  render(data) {
    return renderJson(data);
  },
};

// ---------------------------------------------------------------------------
// Diff strategy: structural key diff
// ---------------------------------------------------------------------------

function diffJson(
  old: ResourceSnapshot,
  new_: ResourceSnapshot,
): ResourceDiffResult {
  let oldJson: unknown;
  let newJson: unknown;

  try {
    oldJson = parseJsonContent(old.contents);
    newJson = parseJsonContent(new_.contents);
  } catch {
    // Parse failure — fall back to text strategy
    return diffText(old, new_);
  }

  if (
    typeof oldJson !== 'object' ||
    oldJson === null ||
    Array.isArray(oldJson) ||
    typeof newJson !== 'object' ||
    newJson === null ||
    Array.isArray(newJson)
  ) {
    // Non-object JSON — treat as text
    return diffText(old, new_);
  }

  const oldObj = oldJson as Record<string, unknown>;
  const newObj = newJson as Record<string, unknown>;

  const oldKeys = new Set(Object.keys(oldObj));
  const newKeys = new Set(Object.keys(newObj));

  const added: string[] = [];
  const deleted: string[] = [];
  const updated: { key: string; oldValue: string; newValue: string }[] = [];

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(key);
    } else if (!deepEqual(oldObj[key], newObj[key])) {
      updated.push({
        key,
        oldValue: formatScalar(oldObj[key]),
        newValue: formatScalar(newObj[key]),
      });
    }
  }

  for (const key of oldKeys) {
    if (!newKeys.has(key)) deleted.push(key);
  }

  const totalKeys = Math.max(oldKeys.size, newKeys.size);
  const changedKeys = added.length + updated.length + deleted.length;
  if (totalKeys > 0 && changedKeys / totalKeys > JSON_FULL_CHANGE_FRACTION) {
    return {
      kind: 'full',
      reason: 'significant-change',
      content: formatJsonContent(new_),
    };
  }

  const summaryParts: string[] = [];
  if (added.length > 0) summaryParts.push(`Added: ${added.join(', ')}`);
  if (updated.length > 0)
    summaryParts.push(
      `Updated: ${updated.map((u) => `${u.key} (${u.oldValue} → ${u.newValue})`).join(', ')}`,
    );
  if (deleted.length > 0) summaryParts.push(`Deleted: ${deleted.join(', ')}`);

  return {
    kind: 'json-diff',
    added,
    updated,
    deleted,
    summary: summaryParts.join('\n'),
    content: [{ type: 'text', text: summaryParts.join('\n') }],
  };
}

function formatJsonContent(snapshot: ResourceSnapshot): ContextDataContent[] {
  const textContents = snapshot.contents.contents.filter(
    (content) => 'text' in content,
  );
  if (textContents.length === 0) return formatTextContent(snapshot);
  try {
    return textContents.map((content, index) => ({
      type: 'text',
      text: `JSON content${textContents.length > 1 ? ` ${index + 1} (uri: ${content.uri})` : ''}:\n${truncate(
        JSON.stringify(JSON.parse(content.text), null, 2),
        MAX_RESOURCE_TEXT_CHARS,
      )}`,
    }));
  } catch {
    return formatTextContent(snapshot);
  }
}

// ---------------------------------------------------------------------------
// Render: json-diff and full content in <resource> blocks
// ---------------------------------------------------------------------------

function renderJson(data: ResourceStateData): (TextPart | FilePart)[] {
  const attrs = buildResourceAttrs(data);
  const { diff, isInitial } = data;

  if (diff.kind === 'json-diff') {
    return [
      {
        type: 'text',
        text: `<resource ${attrs} type="update">\n<json-diff><![CDATA[${escCData(diff.summary)}]]></json-diff>\n</resource>`,
      },
    ];
  }

  // Full content (initial or replacement)
  return renderFullContent(attrs, diff.content, isInitial);
}

import type { ReadResourceResult } from '@modelcontextprotocol/client';
import type { FilePart, TextPart } from 'ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Content block matching the `ContextDataUIPart['content']` union.
 * Defined locally to keep this module free of session-type imports.
 */
export type ContextDataContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

/**
 * A captured snapshot of a resource's contents, used as the baseline for
 * computing diffs when the resource updates.
 */
export interface ResourceSnapshot {
  uri: string;
  mimeType?: string;
  contents: ReadResourceResult;
  /** Fingerprint of the complete server response, including truncated text. */
  contentFingerprint?: string;
}

/**
 * The result of diffing two resource snapshots. Discriminated by `kind`.
 *
 * - `full` — the entire content is replaced. Reasons: initial load,
 *   significant change, unsupported MIME, or resource deletion.
 * - `text-diff` — a unified-diff-style patch for small text changes.
 * - `json-diff` — a structural summary of added/updated/deleted keys.
 */
export type ResourceDiffResult =
  | { kind: 'unchanged'; content: [] }
  | {
      kind: 'full';
      content: ContextDataContent[];
      reason: 'initial' | 'significant-change' | 'unsupported-mime' | 'deleted';
    }
  | {
      kind: 'text-diff';
      patch: string;
      linesAdded: number;
      linesRemoved: number;
      content: ContextDataContent[];
    }
  | {
      kind: 'json-diff';
      added: string[];
      updated: { key: string; oldValue: string; newValue: string }[];
      deleted: string[];
      summary: string;
      content: ContextDataContent[];
    };

/**
 * The data payload of a `data-mcp-resource-state` custom data part.
 * Carries everything needed to render a resource update or initial state
 * into model-visible `<resource>` blocks.
 */
export interface ResourceStateData {
  handle: string;
  generation: number;
  namespace: string;
  uri: string;
  mimeType: string | undefined;
  isInitial: boolean;
  truncated?: boolean;
  diff: ResourceDiffResult;
}

/**
 * Per-MIME-type resource handler. Each handler owns its diff strategy,
 * initial-content formatting, and `<resource>` block rendering.
 */
export interface ResourceHandler {
  matches(mimeType: string | undefined): boolean;
  diff(old: ResourceSnapshot, new_: ResourceSnapshot): ResourceDiffResult;
  formatInitialContent(snapshot: ResourceSnapshot): ContextDataContent[];
  render(data: ResourceStateData): (TextPart | FilePart)[];
}

// ---------------------------------------------------------------------------
// Constants & thresholds
// ---------------------------------------------------------------------------

/** Max chars for a single content block before truncation. */
export const MAX_RESOURCE_TEXT_CHARS = 10_000;
export const MAX_RESOURCE_BINARY_BYTES = 10 * 1024 * 1024;

/** Changed lines at or below this count produce a text-diff. */
const TEXT_DIFF_MAX_CHANGED_LINES = 2;
/** Alternatively, if changed lines are ≤ this fraction of total, diff. */
const TEXT_DIFF_MIN_FRACTION = 0.05;
/** JSON: if more than this fraction of keys changed, fall back to full. */
const JSON_FULL_CHANGE_FRACTION = 0.5;
const MAX_LCS_CELLS = 4_000_000;
const TRUNCATION_NOTICE = '\n[Resource text truncated at 10,000 characters]';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ResourceSizeLimitError extends Error {
  constructor(
    readonly uri: string,
    readonly decodedBytes: number,
  ) {
    super(
      `Resource '${uri}' exceeds the ${MAX_RESOURCE_BINARY_BYTES}-byte decoded binary limit (${decodedBytes} bytes)`,
    );
    this.name = 'ResourceSizeLimitError';
  }
}

// ---------------------------------------------------------------------------
// MIME-type helpers
// ---------------------------------------------------------------------------

export function normalizeMimeType(
  mimeType: string | undefined,
): string | undefined {
  const essence = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return essence || undefined;
}

export function isJsonMime(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === 'application/json' ||
    normalized === 'text/json' ||
    normalized?.endsWith('+json') === true
  );
}

export function isImageMime(mimeType: string | undefined): boolean {
  return normalizeMimeType(mimeType)?.startsWith('image/') ?? false;
}

/** Infers a MIME type from the content blocks when not explicitly provided. */
export function inferMimeType(result: ReadResourceResult): string {
  for (const c of result.contents) {
    const mimeType = normalizeMimeType(c.mimeType);
    if (mimeType) return mimeType;
  }
  for (const c of result.contents) {
    if ('text' in c) return 'text/plain';
    if ('blob' in c) return 'application/octet-stream';
  }
  return 'text/plain';
}

// ---------------------------------------------------------------------------
// Resource normalisation
// ---------------------------------------------------------------------------

export function normalizeResourceResult(
  uri: string,
  result: ReadResourceResult,
): ReadResourceResult {
  const totalTextChars = result.contents.reduce(
    (total, content) => total + ('text' in content ? content.text.length : 0),
    0,
  );
  const didTruncateText = totalTextChars > MAX_RESOURCE_TEXT_CHARS;
  let remainingTextChars =
    MAX_RESOURCE_TEXT_CHARS - (didTruncateText ? TRUNCATION_NOTICE.length : 0);
  let decodedBinaryBytes = 0;
  const contents = result.contents.map((content) => {
    const mimeType = normalizeMimeType(content.mimeType);
    if ('text' in content) {
      const available = Math.max(0, remainingTextChars);
      const text = content.text.slice(0, available);
      remainingTextChars -= text.length;
      return { ...content, ...(mimeType ? { mimeType } : {}), text };
    }
    const decodedBytes = canonicalBase64DecodedBytes(content.blob);
    if (decodedBytes === undefined) {
      throw new Error(`Resource '${uri}' contains invalid base64 blob data`);
    }
    decodedBinaryBytes += decodedBytes;
    if (decodedBinaryBytes > MAX_RESOURCE_BINARY_BYTES) {
      throw new ResourceSizeLimitError(uri, decodedBinaryBytes);
    }
    return { ...content, ...(mimeType ? { mimeType } : {}) };
  });

  if (didTruncateText) {
    const lastText = contents.findLast((content) => 'text' in content);
    if (lastText && 'text' in lastText) lastText.text += TRUNCATION_NOTICE;
  }
  return { ...result, contents };
}

function canonicalBase64DecodedBytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return undefined;
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (padding > 0) {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const finalValue = alphabet.indexOf(data[data.length - padding - 1] ?? '');
    const unusedBits = padding === 2 ? 4 : 2;
    if ((finalValue & (2 ** unusedBits - 1)) !== 0) return undefined;
  }
  return (data.length / 4) * 3 - padding;
}

// ---------------------------------------------------------------------------
// Content extraction & parsing helpers
// ---------------------------------------------------------------------------

/** Extracts the text content from a ReadResourceResult (first text block). */
export function extractText(result: ReadResourceResult): string {
  for (const c of result.contents) {
    if ('text' in c && typeof c.text === 'string') return c.text;
  }
  return '';
}

export function parseJsonContent(result: ReadResourceResult): unknown {
  const documents = result.contents
    .filter((content) => 'text' in content)
    .map((content, index) => ({
      key: `${index + 1}:${content.uri}`,
      value: JSON.parse(content.text) as unknown,
    }));
  if (documents.length === 0) throw new Error('Resource has no JSON text');
  if (documents.length === 1) return documents[0]?.value;
  return Object.fromEntries(
    documents.map((document) => [document.key, document.value]),
  );
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Deep equality check for JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/** Formats a JSON value for display in a diff summary. */
export function formatScalar(v: unknown): string {
  const serialized = JSON.stringify(v);
  if (serialized === undefined) return String(v);
  return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized;
}

/** Truncates text to a max length with a suffix indicator. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated — ${text.length - max} more chars]`;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Escapes a string for use in an XML attribute value. */
export function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes `]]>` sequences inside CDATA content to prevent premature CDATA
 * termination and prompt injection. The standard XML workaround splits the
 * CDATA section at each occurrence: `]]>` becomes `]]]]><![CDATA[>`, which
 * a parser reassembles into the literal `]]>` characters.
 */
export function escCData(s: string): string {
  return s.replaceAll(']]>', ']]]]><![CDATA[>');
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

/** Builds the common attribute string for a `<resource>` block. */
export function buildResourceAttrs(
  data: Pick<
    ResourceStateData,
    'handle' | 'generation' | 'namespace' | 'uri' | 'mimeType'
  >,
): string {
  const { handle, generation, namespace, uri, mimeType } = data;
  const mimeAttr = mimeType ? ` mime-type="${escAttr(mimeType)}"` : '';
  return `handle="${escAttr(handle)}" generation="${generation}" namespace="${escAttr(namespace)}" uri="${escAttr(uri)}"${mimeAttr}`;
}

/** Renders full content (initial or replacement) as `<resource type="full">` blocks. */
export function renderFullContent(
  attrs: string,
  content: ContextDataContent[],
  isInitial: boolean,
): (TextPart | FilePart)[] {
  const parts: (TextPart | FilePart)[] = [];
  for (const block of content) {
    if (block.type === 'image') {
      parts.push({ type: 'text', text: `<resource ${attrs} type="full">` });
      parts.push({
        type: 'file',
        mediaType: block.mimeType,
        data: block.data,
      });
    } else if (block.type === 'text') {
      if (isInitial) {
        parts.push({
          type: 'text',
          text: `<resource ${attrs} type="full"><![CDATA[${escCData(block.text)}]]></resource>`,
        });
      } else {
        parts.push({
          type: 'text',
          text: `<resource ${attrs} type="full">\n<full-replacement><![CDATA[${escCData(block.text)}]]></full-replacement>\n</resource>`,
        });
      }
    }
  }
  if (parts.length === 0) {
    parts.push({
      type: 'text',
      text: `<resource ${attrs} type="full"><![CDATA[No content.]]></resource>`,
    });
  }
  return parts;
}

/** Renders a deleted-resource notice as a `<resource type="update">` block. */
export function renderDeletedResource(attrs: string): TextPart[] {
  return [
    {
      type: 'text',
      text: `<resource ${attrs} type="update"><![CDATA[Resource no longer available. Window closed.]]></resource>`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Re-exported thresholds for handler use
// ---------------------------------------------------------------------------

export {
  JSON_FULL_CHANGE_FRACTION,
  MAX_LCS_CELLS,
  TEXT_DIFF_MAX_CHANGED_LINES,
  TEXT_DIFF_MIN_FRACTION,
};

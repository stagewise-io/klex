import { createHash } from 'node:crypto';

import type { ReadResourceResult } from '@modelcontextprotocol/client';
import type { FilePart, TextPart } from 'ai';

import {
  type BlockField,
  type DataBlock,
  field,
  renderBlockSegments,
} from '@/session/chat/utils/history-view';

import {
  type ContextDataContent,
  inferMimeType,
  normalizeMimeType,
  normalizeResourceResult,
  type ResourceDiffResult,
  type ResourceHandler,
  type ResourceSnapshot,
  type ResourceStateData,
} from './helpers';
import { imageHandler } from './image';
import { jsonHandler } from './json';
import { textHandler } from './text';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  type ContextDataContent,
  MAX_RESOURCE_BINARY_BYTES,
  MAX_RESOURCE_TEXT_CHARS,
  normalizeMimeType,
  type ResourceDiffResult,
  type ResourceHandler,
  ResourceSizeLimitError,
  type ResourceSnapshot,
  type ResourceStateData,
} from './helpers';

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/** Ordered list of handlers. First match wins. Text is the fallback. */
const handlers: ResourceHandler[] = [imageHandler, jsonHandler, textHandler];

function findHandler(mimeType: string | undefined): ResourceHandler {
  for (const handler of handlers) {
    if (handler.matches(mimeType)) return handler;
  }
  return textHandler;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a {@link ResourceSnapshot} from a raw MCP read result, normalising
 * MIME types, truncating oversized text, and computing a content fingerprint.
 */
export function createResourceSnapshot(
  uri: string,
  result: ReadResourceResult,
): ResourceSnapshot {
  const contents = normalizeResourceResult(uri, result);
  return {
    uri,
    mimeType: inferMimeType(contents),
    contents,
    contentFingerprint: createHash('sha256')
      .update(JSON.stringify(result))
      .digest('hex'),
  };
}

/**
 * Diffs two resource snapshots, routing to the appropriate strategy based
 * on MIME type. Returns a {@link ResourceDiffResult} describing the change.
 */
export function diffResource(
  old: ResourceSnapshot,
  new_: ResourceSnapshot,
): ResourceDiffResult {
  if (
    (old.contentFingerprint !== undefined &&
      new_.contentFingerprint !== undefined &&
      old.contentFingerprint === new_.contentFingerprint) ||
    (old.contentFingerprint === undefined &&
      new_.contentFingerprint === undefined &&
      deepEqualContents(old.contents.contents, new_.contents.contents))
  ) {
    return { kind: 'unchanged', content: [] };
  }

  const mimeType = new_.mimeType ?? inferMimeType(new_.contents);
  const handler = findHandler(mimeType);
  return handler.diff(old, new_);
}

/**
 * Produces the initial content for a freshly opened resource.
 * Uses per-MIME-type formatting.
 */
export function formatInitialContent(
  snapshot: ResourceSnapshot,
): ContextDataContent[] {
  const mimeType = snapshot.mimeType ?? inferMimeType(snapshot.contents);
  const { contents } = snapshot;

  if (contents.contents.length === 0) {
    return [
      { type: 'text', text: `Resource '${snapshot.uri}' returned no content.` },
    ];
  }

  const handler = findHandler(mimeType);
  return handler.formatInitialContent(snapshot);
}

/**
 * Produces a deletion event — used when re-reading the resource fails.
 */
export function deletedResource(
  uri: string,
  namespace: string,
): ResourceDiffResult {
  return {
    kind: 'full',
    reason: 'deleted',
    content: [
      {
        type: 'text',
        text: `Resource '${uri}' on server '${namespace}' is no longer available.`,
      },
    ],
  };
}

/**
 * Renders a {@link ResourceStateData} part into model-visible text/file parts,
 * using shared provenance-aware resource blocks and native media slots.
 */
export function renderResourceState(
  data: ResourceStateData,
): (TextPart | FilePart)[] {
  return projectResourceState(data).flatMap((block) =>
    renderBlockSegments(block).map((segment): TextPart | FilePart =>
      segment.type === 'text'
        ? segment
        : { type: 'file', mediaType: segment.mediaType, data: segment.data },
    ),
  );
}

export function projectResourceState(data: ResourceStateData): DataBlock[] {
  const { diff } = data;
  if (diff.kind === 'unchanged') return [];
  const fields: BlockField[] = [
    field('handle', data.handle, 'trusted'),
    field('generation', data.generation, 'trusted'),
    field('namespace', data.namespace),
    field('uri', data.uri),
    ...(data.mimeType ? [field('mimeType', data.mimeType)] : []),
    field('mode', diff.kind, 'trusted'),
  ];
  if (diff.kind === 'text-diff') fields.push(field('patch', diff.patch));
  else if (diff.kind === 'json-diff')
    fields.push(
      field('added', diff.added),
      field('updated', diff.updated),
      field('deleted', diff.deleted),
      field('summary', diff.summary),
    );
  else {
    fields.push(
      field('replacement', !data.isInitial, 'trusted'),
      field('reason', diff.reason, 'trusted'),
    );
    if (diff.content.length === 0) fields.push(field('content', 'No content.'));
    for (const [index, content] of diff.content.entries()) {
      const key = `content${index + 1}`;
      if (content.type === 'image' || content.type === 'audio')
        fields.push({
          key,
          kind: 'media',
          media: {
            type: 'media',
            kind: content.type,
            mediaType: content.mimeType,
            data: content.data,
          },
        });
      else
        fields.push(
          field(key, content.type === 'text' ? content.text : content),
        );
    }
  }
  if (data.truncated) fields.push(field('truncated', true, 'trusted'));
  return [{ type: 'resource', fields }];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deepEqualContents(
  a: ReadResourceResult['contents'],
  b: ReadResourceResult['contents'],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((av, i) => {
    const bv = b[i];
    return bv !== undefined && deepEqualContent(av, bv);
  });
}

function deepEqualContent(
  a: ReadResourceResult['contents'][number],
  b: ReadResourceResult['contents'][number],
): boolean {
  if ('text' in a && 'text' in b) {
    return a.uri === b.uri && a.text === b.text && a.mimeType === b.mimeType;
  }
  if ('blob' in a && 'blob' in b) {
    return a.uri === b.uri && a.blob === b.blob && a.mimeType === b.mimeType;
  }
  return false;
}

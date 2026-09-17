import type { TextPart } from 'ai';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { isDataPartOf } from '../extension-api';
import type { ResourceWindow } from './resource-window-manager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPEN_RESOURCES_KEY = 'mcp-open-resources';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal open-resource entry suitable for diffing and serialisation. */
export interface OpenResourcesEntry {
  handle: string;
  server: string;
  uri: string;
  mimeType: string | undefined;
  live: boolean;
}

/** Data carried in a `data-mcp-open-resources` custom data part. */
export interface OpenResourcesData {
  /** Whether this is the initial full list or a diff. */
  isInitial: boolean;
  /** Full list of open resources (always present, even for diffs). */
  resources: OpenResourcesEntry[];
  /** When `isInitial` is false, describes what changed. */
  diff?: {
    added: OpenResourcesEntry[];
    removed: string[];
    changed: OpenResourcesEntry[];
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isOpenResourcesData(data: unknown): data is OpenResourcesData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as OpenResourcesData).isInitial === 'boolean' &&
    Array.isArray((data as OpenResourcesData).resources)
  );
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Extracts a minimal, diffable entry from a `ResourceWindow`. */
export function toOpenResourcesEntry(
  window: ResourceWindow,
): OpenResourcesEntry {
  return {
    handle: window.handle,
    server: window.namespace,
    uri: window.uri,
    mimeType: window.mimeType ?? undefined,
    live: window.live,
  };
}

/** Computes a stable diff between two open-resource lists. Returns `null` if identical. */
export function diffOpenResources(
  prev: OpenResourcesEntry[],
  curr: OpenResourcesEntry[],
): {
  added: OpenResourcesEntry[];
  removed: string[];
  changed: OpenResourcesEntry[];
} | null {
  const prevMap = new Map(prev.map((r) => [r.handle, r]));
  const currMap = new Map(curr.map((r) => [r.handle, r]));

  const added: OpenResourcesEntry[] = [];
  const removed: string[] = [];
  const changed: OpenResourcesEntry[] = [];

  for (const [handle, entry] of currMap) {
    const old = prevMap.get(handle);
    if (!old) {
      added.push(entry);
    } else if (
      old.server !== entry.server ||
      old.uri !== entry.uri ||
      old.mimeType !== entry.mimeType ||
      old.live !== entry.live
    ) {
      changed.push(entry);
    }
  }
  for (const [handle] of prevMap) {
    if (!currMap.has(handle)) removed.push(handle);
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// History scanning
// ---------------------------------------------------------------------------

/** Finds the most recent `data-mcp-open-resources` part in history. */
export function latestOpenResourcesPart(
  history: readonly ExtendedUIMessage[],
): OpenResourcesData | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (
        part &&
        isDataPartOf(OPEN_RESOURCES_KEY, part as never) &&
        isOpenResourcesData((part as { data: unknown }).data)
      ) {
        return (part as unknown as { data: OpenResourcesData }).data;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders an open-resource entry as a compact pipe-delimited row. */
function formatOpenResourceRow(entry: OpenResourcesEntry): string {
  return `${entry.handle}|${entry.server}|${entry.uri}|${entry.mimeType ?? '?'}|${entry.live ? 'yes' : 'no'}`;
}

/** Renders `OpenResourcesData` into model-visible text parts. */
export function renderOpenResourcesData(data: OpenResourcesData): TextPart[] {
  if (data.isInitial) {
    if (data.resources.length === 0) {
      return [
        { type: 'text', text: '<open-resources>\n(none)\n</open-resources>' },
      ];
    }
    const lines = ['<open-resources>', 'handle|server|uri|mime|live'];
    for (const r of data.resources) lines.push(formatOpenResourceRow(r));
    lines.push('</open-resources>');
    return [{ type: 'text', text: lines.join('\n') }];
  }

  // Diff
  const diff = data.diff;
  if (!diff) return [];
  const lines = ['<open-resources-diff>'];
  if (diff.added.length > 0) {
    lines.push('added:');
    for (const r of diff.added) lines.push(`  ${formatOpenResourceRow(r)}`);
  }
  if (diff.removed.length > 0) {
    lines.push('removed:');
    for (const handle of diff.removed) lines.push(`  ${handle}`);
  }
  if (diff.changed.length > 0) {
    lines.push('changed:');
    for (const r of diff.changed) lines.push(`  ${formatOpenResourceRow(r)}`);
  }
  // Include current full list for context after the diff
  lines.push('current:');
  for (const r of data.resources) lines.push(`  ${formatOpenResourceRow(r)}`);
  lines.push('</open-resources-diff>');
  return [{ type: 'text', text: lines.join('\n') }];
}

import type { TextPart } from 'ai';

import type { McpConnectionStatus, McpServerInfo } from '@/mcp';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { isDataPartOf } from '../extension-api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVER_LIST_KEY = 'mcp-server-list';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal server entry suitable for diffing and serialisation. */
export interface ServerListEntry {
  name: string;
  status: McpConnectionStatus;
  toolCount: number;
  resourceCount: number;
}

/** Data carried in a `data-mcp-server-list` custom data part. */
export interface ServerListData {
  /** Whether this is the initial full list or a diff. */
  isInitial: boolean;
  /** Full list of servers (always present, even for diffs). */
  servers: ServerListEntry[];
  /** When `isInitial` is false, describes what changed. */
  diff?: {
    added: ServerListEntry[];
    removed: string[];
    changed: ServerListEntry[];
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isServerListData(data: unknown): data is ServerListData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as ServerListData).isInitial === 'boolean' &&
    Array.isArray((data as ServerListData).servers)
  );
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Extracts a minimal, diffable server entry from `McpServerInfo`. */
export function toServerListEntry(info: McpServerInfo): ServerListEntry {
  return {
    name: info.name,
    status: info.status,
    toolCount: info.toolCount,
    resourceCount: info.resourceCount,
  };
}

/** Computes a stable diff between two server lists. Returns `null` if identical. */
export function diffServerLists(
  prev: ServerListEntry[],
  curr: ServerListEntry[],
): {
  added: ServerListEntry[];
  removed: string[];
  changed: ServerListEntry[];
} | null {
  const prevMap = new Map(prev.map((s) => [s.name, s]));
  const currMap = new Map(curr.map((s) => [s.name, s]));

  const added: ServerListEntry[] = [];
  const removed: string[] = [];
  const changed: ServerListEntry[] = [];

  for (const [name, entry] of currMap) {
    const old = prevMap.get(name);
    if (!old) {
      added.push(entry);
    } else if (
      old.status !== entry.status ||
      old.toolCount !== entry.toolCount ||
      old.resourceCount !== entry.resourceCount
    ) {
      changed.push(entry);
    }
  }
  for (const [name] of prevMap) {
    if (!currMap.has(name)) removed.push(name);
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// History scanning
// ---------------------------------------------------------------------------

/** Finds the most recent `data-mcp-server-list` part in history. */
export function latestServerListPart(
  history: readonly ExtendedUIMessage[],
): ServerListData | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (
        part &&
        isDataPartOf(SERVER_LIST_KEY, part as never) &&
        isServerListData((part as { data: unknown }).data)
      ) {
        return (part as unknown as { data: ServerListData }).data;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders a server list entry as a compact pipe-delimited row. */
function formatServerRow(entry: ServerListEntry): string {
  return `${entry.name}|${entry.status}|${entry.toolCount}|${entry.resourceCount}`;
}

/** Renders `ServerListData` into model-visible text parts. */
export function renderServerListData(data: ServerListData): TextPart[] {
  if (data.isInitial) {
    const lines = ['<mcp-servers>', 'name|status|tools|resources'];
    for (const s of data.servers) lines.push(formatServerRow(s));
    lines.push('</mcp-servers>');
    return [{ type: 'text', text: lines.join('\n') }];
  }

  // Diff
  const diff = data.diff;
  if (!diff) return [];
  const lines = ['<mcp-servers-diff>'];
  if (diff.added.length > 0) {
    lines.push('added:');
    for (const s of diff.added) lines.push(`  ${formatServerRow(s)}`);
  }
  if (diff.removed.length > 0) {
    lines.push('removed:');
    for (const name of diff.removed) lines.push(`  ${name}`);
  }
  if (diff.changed.length > 0) {
    lines.push('changed:');
    for (const s of diff.changed) lines.push(`  ${formatServerRow(s)}`);
  }
  // Include current full list for context after the diff
  lines.push('current:');
  for (const s of data.servers) lines.push(`  ${formatServerRow(s)}`);
  lines.push('</mcp-servers-diff>');
  return [{ type: 'text', text: lines.join('\n') }];
}

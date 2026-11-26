import type { McpConnectionStatus, McpServerInfo } from '@/mcp';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  type DataBlock,
  field,
  tableField,
} from '@/session/chat/utils/history-view';

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
  supportsEvents?: boolean;
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
    supportsEvents: info.supportsEvents ?? false,
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
      old.resourceCount !== entry.resourceCount ||
      (old.supportsEvents ?? false) !== (entry.supportsEvents ?? false)
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

export function projectServerListData(data: ServerListData): DataBlock[] {
  if (!data.isInitial && !data.diff) return [];
  return [
    {
      type: data.isInitial ? 'mcp-servers' : 'mcp-servers-diff',
      ...(data.isInitial
        ? {
            body: tableField(
              'servers',
              [
                'name',
                'status',
                'toolCount',
                'resourceCount',
                'supportsEvents',
              ],
              data.servers.map((server) => [
                server.name,
                server.status,
                server.toolCount,
                server.resourceCount,
                server.supportsEvents ?? false,
              ]),
              'trusted',
            ),
            fields: [],
          }
        : {
            fields: Object.entries(data.diff!).map(([key, value]) =>
              field(key, value, 'trusted'),
            ),
          }),
    },
  ];
}

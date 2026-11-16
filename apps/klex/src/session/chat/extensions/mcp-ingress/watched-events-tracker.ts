import type { TextPart } from 'ai';

import type { Mcp } from '@/mcp';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

export const WATCHED_EVENTS_KEY = 'mcp-watched-events';
type Watch = ReturnType<Mcp['getEventWatches']>[number];
export type WatchEntry = Pick<
  Watch,
  'watchId' | 'server' | 'name' | 'status' | 'delivery' | 'gap' | 'reason'
>;
export interface WatchedEventsData {
  isInitial: boolean;
  watches: WatchEntry[];
  diff?: { added: WatchEntry[]; removed: string[]; changed: WatchEntry[] };
}

export function toWatchEntry(watch: Watch): WatchEntry {
  const { watchId, server, name, status, delivery, gap, reason } = watch;
  return { watchId, server, name, status, delivery, gap, reason };
}

export function latestWatchedEventsPart(
  history: readonly ExtendedUIMessage[],
): WatchedEventsData | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as unknown as
        | { type?: string; data?: unknown }
        | undefined;
      if (part?.type !== `data-${WATCHED_EVENTS_KEY}`) continue;
      const data = part.data as WatchedEventsData | undefined;
      if (
        data &&
        typeof data.isInitial === 'boolean' &&
        Array.isArray(data.watches)
      )
        return data;
    }
  }
  return undefined;
}

export function watchedEventsUpdate(
  previous: WatchedEventsData | undefined,
  watches: WatchEntry[],
): WatchedEventsData | undefined {
  if (!previous) return { isInitial: true, watches };
  const before = new Map(
    previous.watches.map((watch) => [watch.watchId, watch]),
  );
  const after = new Map(watches.map((watch) => [watch.watchId, watch]));
  const added = watches.filter((watch) => !before.has(watch.watchId));
  const changed = watches.filter(
    (watch) =>
      before.has(watch.watchId) &&
      JSON.stringify(before.get(watch.watchId)) !== JSON.stringify(watch),
  );
  const removed = previous.watches
    .filter((watch) => !after.has(watch.watchId))
    .map((watch) => watch.watchId);
  if (!added.length && !changed.length && !removed.length) return undefined;
  return { isInitial: false, watches, diff: { added, changed, removed } };
}

export function renderWatchedEventsData(data: WatchedEventsData): TextPart[] {
  const tag = data.isInitial ? 'watched-mcp-events' : 'watched-mcp-events-diff';
  const row = (watch: WatchEntry) =>
    `¦${JSON.stringify({ watchId: watch.watchId, server: watch.server, name: watch.name, status: watch.status, delivery: watch.delivery, gap: watch.gap, reason: watch.reason })}`;
  const lines = [`<${tag}>`];
  if (data.isInitial)
    lines.push(...(data.watches.length ? data.watches.map(row) : ['(none)']));
  else if (data.diff) {
    if (data.diff.added.length)
      lines.push('added:', ...data.diff.added.map(row));
    if (data.diff.removed.length)
      lines.push(
        'removed:',
        ...data.diff.removed.map((id) => `¦${JSON.stringify(id)}`),
      );
    if (data.diff.changed.length)
      lines.push('changed:', ...data.diff.changed.map(row));
  }
  lines.push(`</${tag}>`);
  return [{ type: 'text', text: lines.join('\n') }];
}

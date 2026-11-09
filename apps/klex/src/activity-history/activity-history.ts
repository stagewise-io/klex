import {
  RECORD_SEPARATOR,
  renderRecordText,
} from '@/session/chat/utils/history-view';
import type {
  ActivityMessage,
  ActivitySource,
  SessionHistory,
} from '@/session-history';

import { collectActivityHistory } from './history-projection';

export interface ActivityPage {
  id: string;
  /** Inclusive start of a bounded runtime batch, retained for deferred revisits. */
  firstSourceId?: string;
  /** Canonical evidence actually rendered; absent on single-source pages. */
  sourceIds?: string[];
  startedAt: string | null;
  endedAt: string | null;
  text: string;
  offset: number;
  nextOffset: number | null;
  scannedBytes: number;
  truncated: boolean;
}

export interface ActivityBatch extends ActivityPage {
  startedAt: string;
  endedAt: string;
  recordCount: number;
}

export interface ActivityLimits {
  maxCharacters: number;
  maxDurationMs: number;
  idleTimeoutMs: number;
}

export interface ActivitySearchResult {
  matches: { id: string; snippet: string; offset: number }[];
  nextOffset: number | null;
  scannedBytes: number;
  truncated: boolean;
}

export interface ActivityHistory {
  isAvailable(): boolean;
  subscribe(listener: () => void): () => void;
  manifest(): Promise<ActivitySource[]>;
  latest(count: number): Promise<ActivitySource[]>;
  readPending(
    after: string | null,
    options: ActivityLimits & {
      active: boolean;
      lastActivityAt: number;
      now: number;
    },
  ): Promise<ActivityBatch | null>;
  readPage(
    id: string,
    options: {
      offset: number;
      limit: number;
      maxBytes: number;
      tail?: boolean;
      firstSourceId?: string;
    },
  ): Promise<ActivityPage | null>;
  listNeighbors(id: string, count: number): Promise<ActivitySource[]>;
  search(
    query: string,
    options: { offset: number; maxBytes: number; limit: number },
  ): Promise<ActivitySearchResult>;
  compareIds(left: string, right: string): number;
}

/** Handles address canonical messages, never durable activity groups. */
export function activityOrdinal(id: string | null): number | null {
  if (!id?.startsWith('history:') || id.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(id.slice(8), 'base64url').toString(),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      typeof value[1] !== 'string' ||
      typeof value[2] !== 'string'
    )
      return null;
    return value[0] as number;
  } catch {
    return null;
  }
}

function renderActivityRecords(source: ActivityMessage): string[] {
  if (!source.message) return [];
  return collectActivityHistory([source.message], null).messages.flatMap(
    (message) =>
      message.records.map((record, index) =>
        renderRecordText(
          record,
          message.role,
          index === message.records.length - 1 ? message.omittedRecords : 0,
        ),
      ),
  );
}

class ActivityHistoryModule implements ActivityHistory {
  constructor(private readonly history: SessionHistory) {}

  isAvailable(): boolean {
    return this.history.activityAvailable();
  }
  subscribe(listener: () => void): () => void {
    return this.history.subscribeActivity(listener);
  }
  manifest(): Promise<ActivitySource[]> {
    return this.history.activityManifest();
  }
  compareIds(left: string, right: string): number {
    return (activityOrdinal(left) ?? -1) - (activityOrdinal(right) ?? -1);
  }

  async latest(count: number): Promise<ActivitySource[]> {
    return this.history.readActivity({
      descending: true,
      limit: count,
      maxBytes: 0,
    });
  }

  async readPending(
    after: string | null,
    options: ActivityLimits & {
      active: boolean;
      lastActivityAt: number;
      now: number;
    },
  ): Promise<ActivityBatch | null> {
    if (options.active || !this.isAvailable()) return null;
    const ordinal = activityOrdinal(after);
    if (after !== null && ordinal === null)
      throw new Error('Legacy activity cursor requires cutover');
    const rows = await this.history.readActivity({ after: ordinal ?? -1 });
    if (!rows.length) return null;
    const first = rows[0]!;
    const selected: ActivityMessage[] = [];
    const blocks: string[] = [];
    let size = 0;
    let count = 0;
    let boundary = false;
    let truncated = false;
    for (const row of rows) {
      const records = renderActivityRecords(row);
      const text = records
        .map((record) => `${row.persistedAt.slice(11, 16)} ${record}`)
        .join(RECORD_SEPARATOR);
      const separatorSize = text && blocks.length ? RECORD_SEPARATOR.length : 0;
      if (
        selected.length &&
        (size + separatorSize + text.length > options.maxCharacters ||
          Date.parse(row.persistedAt) - Date.parse(first.persistedAt) >=
            options.maxDurationMs ||
          row.persistedAt.slice(0, 10) !== first.persistedAt.slice(0, 10))
      ) {
        boundary = true;
        break;
      }
      selected.push(row);
      if (text) {
        const bounded = text.slice(
          0,
          Math.max(0, options.maxCharacters - size - separatorSize),
        );
        blocks.push(bounded);
        size += bounded.length + separatorSize;
        truncated ||= bounded.length < text.length;
      }
      count += records.length;
      if (truncated) {
        boundary = true;
        break;
      }
    }
    const last = selected.at(-1)!;
    const idleAt = Math.max(
      Date.parse(last.persistedAt),
      options.lastActivityAt,
    );
    if (
      !boundary &&
      rows.length < 200 &&
      size < options.maxCharacters &&
      options.now - idleAt < options.idleTimeoutMs &&
      first.persistedAt.slice(0, 10) ===
        new Date(options.now).toISOString().slice(0, 10)
    )
      return null;
    return {
      id: last.id,
      firstSourceId: first.id,
      sourceIds: selected
        .filter((row) => renderActivityRecords(row).length > 0)
        .map((row) => row.id)
        .slice(-6),
      startedAt: first.persistedAt,
      endedAt: last.persistedAt,
      recordCount: count,
      text: blocks.join(RECORD_SEPARATOR),
      offset: 0,
      nextOffset: null,
      scannedBytes: selected.reduce(
        (sum, row) => sum + (row.message ? row.bytes : 0),
        0,
      ),
      truncated: truncated || selected.some((row) => row.message === null),
    };
  }

  async readPage(
    id: string,
    options: {
      offset: number;
      limit: number;
      maxBytes: number;
      tail?: boolean;
      firstSourceId?: string;
    },
  ): Promise<ActivityPage | null> {
    const ordinal = activityOrdinal(id);
    if (ordinal === null) return null;
    const firstOrdinal =
      options.firstSourceId === undefined
        ? ordinal
        : activityOrdinal(options.firstSourceId);
    if (firstOrdinal === null || firstOrdinal > ordinal) return null;
    const rows = await this.history.readActivity({
      after: firstOrdinal - 1,
      through: ordinal,
      limit: options.firstSourceId === undefined ? 1 : 200,
      maxBytes: options.maxBytes,
    });
    const row = rows.at(-1);
    if (!row || row.id !== id) return null;
    const rendered = rows.map((source) => ({
      source,
      text: renderActivityRecords(source)
        .map((record) => `${source.persistedAt.slice(11, 16)} ${record}`)
        .join(RECORD_SEPARATOR),
    }));
    const text = rendered
      .filter((item) => item.text)
      .map((item) => item.text)
      .join(RECORD_SEPARATOR);
    const limit = Math.max(0, Math.min(60_000, options.limit));
    const offset = options.tail
      ? Math.max(0, text.length - limit)
      : Math.max(0, options.offset);
    return {
      id,
      ...(options.firstSourceId === undefined
        ? {}
        : {
            firstSourceId: options.firstSourceId,
            sourceIds: rendered
              .filter((item) => item.text)
              .map((item) => item.source.id)
              .slice(-6),
          }),
      startedAt: rows[0]?.persistedAt ?? row.persistedAt,
      endedAt: row.persistedAt,
      text: text.slice(offset, offset + limit),
      offset,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      scannedBytes: rows.reduce(
        (sum, source) => sum + (source.message ? source.bytes : 0),
        0,
      ),
      truncated:
        rows.some((source) => source.message === null) ||
        (options.firstSourceId !== undefined &&
          rows[0]?.id !== options.firstSourceId) ||
        (Boolean(options.tail) && offset > 0),
    };
  }

  async listNeighbors(id: string, count: number): Promise<ActivitySource[]> {
    const ordinal = activityOrdinal(id);
    if (ordinal === null) return [];
    const limit = Math.max(1, Math.min(5, count));
    const [before, after] = await Promise.all([
      this.history.readActivity({
        through: ordinal - 1,
        descending: true,
        limit,
        maxBytes: 0,
      }),
      this.history.readActivity({ after: ordinal, limit, maxBytes: 0 }),
    ]);
    return [...before, ...after];
  }

  async search(
    query: string,
    options: { offset: number; maxBytes: number; limit: number },
  ): Promise<ActivitySearchResult> {
    const sources = (await this.latest(200)).reverse();
    const matches: ActivitySearchResult['matches'] = [];
    const needle = query.slice(0, 200).toLowerCase();
    let scannedBytes = 0;
    let index = Math.max(0, options.offset);
    let truncated = false;
    for (
      ;
      needle &&
      index < sources.length &&
      scannedBytes < options.maxBytes &&
      matches.length < Math.min(6, options.limit);
      index++
    ) {
      const source = sources[index]!;
      // Debit oversized candidates too: an omitted body must not allow unlimited work.
      let page: ActivityPage | null;
      try {
        page = await this.readPage(source.id, {
          offset: 0,
          limit: 60_000,
          maxBytes: options.maxBytes - scannedBytes,
        });
      } catch (error) {
        // Preserve completed work and its byte charge when a later query fails.
        // A failure before any work still propagates as an atomic failure.
        if (scannedBytes === 0) throw error;
        truncated = true;
        break;
      }
      if (!page) {
        truncated = true;
        continue;
      }
      scannedBytes += Math.min(
        options.maxBytes - scannedBytes,
        Math.max(page.scannedBytes, page.truncated ? source.bytes : 0),
      );
      truncated ||= page.truncated || page.nextOffset !== null;
      const position = page.text.toLowerCase().indexOf(needle);
      if (position >= 0) {
        const offset = Math.max(0, position - 160);
        matches.push({
          id: source.id,
          offset,
          snippet: page.text.slice(offset, position + needle.length + 160),
        });
      }
    }
    return {
      matches,
      nextOffset: index < sources.length ? index : null,
      scannedBytes,
      truncated: truncated || index < sources.length,
    };
  }
}

export function createActivityHistory(
  history: SessionHistory,
): ActivityHistory {
  return new ActivityHistoryModule(history);
}

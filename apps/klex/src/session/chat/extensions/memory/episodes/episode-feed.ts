import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { EpisodeStoreState } from './episode-files';
import { parseEpisodeRecordLine, renderEpisodeText } from './episode-format';
import {
  type EpisodePage,
  EpisodePageReadError,
  openEpisodeFile,
  readEpisodePage,
} from './episode-reader';

export type { EpisodePage } from './episode-reader';
export interface EpisodeSearchResult {
  matches: { id: string; snippet: string; offset: number }[];
  nextOffset: number | null;
  scannedBytes: number;
  truncated: boolean;
}

/** A finished episode, addressed by its path relative to `episodic/`. */
export interface EpisodeRef {
  /** `yyyy-MM-dd/{index}-HH-mm.jsonl`. Opaque to consumers. */
  id: string;
  date: string;
  index: number;
}

export interface CompletedEpisode extends EpisodeRef {
  startedAt: string;
  endedAt: string;
  recordCount: number;
  /** Line-format text with `HH:mm` timestamps, as `renderEpisodeText` renders it. */
  text: string;
}

/** Read-only view of finished episodes for other extensions. */
export interface EpisodeFeed {
  isAvailable(): boolean;
  /** Hints that availability or completed episodes changed; scan after subscribing. */
  subscribe(listener: () => void): () => void;
  /** Finished episodes strictly after `after` (null = from the start), oldest first. */
  listCompleted(after: string | null, limit: number): Promise<EpisodeRef[]>;
  /** Newest `count` finished episodes, oldest first. */
  listLatestCompleted(count: number): Promise<EpisodeRef[]>;
  read(id: string): Promise<CompletedEpisode | null>;
  listNeighbors(id: string, count: number): Promise<EpisodeRef[]>;
  readPage(
    id: string,
    options: {
      offset: number;
      limit: number;
      maxBytes: number;
      tail?: boolean;
    },
  ): Promise<EpisodePage | null>;
  search(
    query: string,
    options: { offset: number; maxBytes: number; limit: number },
  ): Promise<EpisodeSearchResult>;
  /** Orders episode ids oldest first; ids are opaque, so use this to sort. */
  compareIds(left: string, right: string): number;
}

export interface EpisodeFeedSource {
  episodicDir: string;
  /**
   * The episode that may still receive records, or null. Must resolve after
   * any episode file creation that started before the call.
   */
  getOpenEpisode: () => Promise<EpisodeStoreState | null>;
}

export interface EpisodeFeedHub extends EpisodeFeed {
  /** Attaches the live episode store. Returns a detach function. */
  attach(source: EpisodeFeedSource): () => void;
  /** Producer hint after an episode has stopped receiving records. */
  notifyChanged(): void;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FILE_PATTERN = /^(\d+)-\d{2}-\d{2}\.jsonl$/;
const ID_PATTERN = /^(\d{4}-\d{2}-\d{2})\/(\d+)-\d{2}-\d{2}\.jsonl$/;

/** Parses an episode id; null for anything that is not a plain episode path. */
export function parseEpisodeId(id: string): EpisodeRef | null {
  const match = ID_PATTERN.exec(id);
  if (!match?.[1] || !match[2]) return null;
  return { id, date: match[1], index: Number.parseInt(match[2], 10) };
}

/** Orders episodes by UTC date, then numeric daily index. */
export function compareEpisodeRefs(
  left: EpisodeRef,
  right: EpisodeRef,
): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  return left.index - right.index;
}

/** Orders episode ids like `compareEpisodeRefs`; unparseable ids sort first. */
export function compareEpisodeIds(left: string, right: string): number {
  const leftRef = parseEpisodeId(left);
  const rightRef = parseEpisodeId(right);
  if (!leftRef || !rightRef) return (leftRef ? 1 : 0) - (rightRef ? 1 : 0);
  return compareEpisodeRefs(leftRef, rightRef);
}

/**
 * Exposes finished episodes of the memory extension. An episode is finished
 * when it is not the source's open episode. Episodes are never reopened, so
 * after a restart every existing file is finished.
 */
class EpisodeFeedModule implements EpisodeFeedHub {
  private source: EpisodeFeedSource | null = null;
  private readonly listeners = new Set<() => void>();
  private notificationPending = false;
  private orderedRefs: Promise<EpisodeRef[]> | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChanged(): void {
    this.orderedRefs = null;
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      for (const listener of this.listeners) {
        // A subscriber cannot prevent other subscribers from being notified.
        try {
          listener();
        } catch {
          /* Notifications are hints only. */
        }
      }
    });
  }

  attach(source: EpisodeFeedSource): () => void {
    if (this.source) throw new Error('Episode feed is already attached');
    this.source = source;
    this.notifyChanged();
    return () => {
      if (this.source === source) {
        this.source = null;
        this.notifyChanged();
      }
    };
  }

  isAvailable(): boolean {
    return this.source !== null;
  }

  async listCompleted(
    after: string | null,
    limit: number,
  ): Promise<EpisodeRef[]> {
    const cursor = after === null ? null : parseEpisodeId(after);
    const source = this.source;
    if (!source || limit <= 0) return [];
    const refs = await this.getOrderedRefs(source);
    const open = await openId(source);
    if (source !== this.source) return [];
    // Binary-search the stable index rather than filtering the archive at
    // every cursor step. Completion hints invalidate the cached snapshot.
    let start = 0;
    let end = refs.length;
    if (cursor) {
      while (start < end) {
        const middle = Math.floor((start + end) / 2);
        const ref = refs[middle];
        if (!ref) break;
        if (compareEpisodeRefs(ref, cursor) <= 0) start = middle + 1;
        else end = middle;
      }
    }
    const completed: EpisodeRef[] = [];
    for (
      let index = start;
      index < refs.length && completed.length < limit;
      index++
    ) {
      const ref = refs[index];
      if (ref && ref.id !== open) completed.push(ref);
    }
    return completed;
  }

  compareIds(left: string, right: string): number {
    return compareEpisodeIds(left, right);
  }

  async listLatestCompleted(count: number): Promise<EpisodeRef[]> {
    const source = this.source;
    if (!source || count <= 0) return [];
    // Visit newest date directories first and stop once enough candidates
    // exist; searches never enumerate every episode in the archive.
    const refs = await listNewestEpisodeRefs(source.episodicDir, count + 1);
    const open = await openId(source);
    if (source !== this.source) return [];
    return refs.filter((ref) => ref.id !== open).slice(-count);
  }

  async listNeighbors(id: string, count: number): Promise<EpisodeRef[]> {
    const ref = parseEpisodeId(id);
    if (!ref) return [];
    const all = await this.listAllCompleted();
    const bounded = Number.isFinite(count)
      ? Math.max(0, Math.min(5, Math.floor(count)))
      : 0;
    if (bounded === 0) return [];
    return [
      ...all
        .filter((item) => compareEpisodeRefs(item, ref) < 0)
        .slice(-bounded),
      ...all
        .filter((item) => compareEpisodeRefs(item, ref) > 0)
        .slice(0, bounded),
    ];
  }

  async readPage(
    id: string,
    options: {
      offset: number;
      limit: number;
      maxBytes: number;
      tail?: boolean;
    },
  ): Promise<EpisodePage | null> {
    const source = this.source;
    if (!source || !parseEpisodeId(id) || id === (await openId(source)))
      return null;
    const page = await readEpisodePage(source.episodicDir, id, options);
    if (source !== this.source || id === (await openId(source))) return null;
    return page;
  }

  async search(
    query: string,
    options: { offset: number; maxBytes: number; limit: number },
  ): Promise<EpisodeSearchResult> {
    const all = (await this.listLatestCompleted(200)).reverse();
    const matches: EpisodeSearchResult['matches'] = [];
    const needle = query.slice(0, 200).toLowerCase();
    let scannedBytes = 0;
    let truncated = false;
    let index = Math.max(0, Math.floor(options.offset));
    const maxBytes = Math.max(0, Math.min(2_000_000, options.maxBytes));
    const limit = Math.max(1, Math.min(6, options.limit));
    for (
      ;
      needle &&
      index < all.length &&
      scannedBytes < maxBytes &&
      matches.length < limit;
      index++
    ) {
      const ref = all[index];
      if (!ref) break;
      let page: EpisodePage | null;
      try {
        page = await this.readPage(ref.id, {
          offset: 0,
          limit: 60_000,
          maxBytes: maxBytes - scannedBytes,
        });
      } catch (error) {
        // A damaged or inaccessible candidate must not hide other matches.
        if (error instanceof EpisodePageReadError)
          scannedBytes += error.scannedBytes;
        truncated = true;
        continue;
      }
      if (!page) continue;
      scannedBytes += page.scannedBytes;
      truncated ||= page.truncated || page.nextOffset !== null;
      const position = page.text.toLowerCase().indexOf(needle);
      if (position >= 0) {
        const start = Math.max(0, position - 160);
        matches.push({
          id: ref.id,
          snippet: page.text.slice(start, position + needle.length + 160),
          offset: start,
        });
      }
    }
    return {
      matches,
      nextOffset: index < all.length && needle ? index : null,
      scannedBytes,
      truncated: truncated || (Boolean(needle) && index < all.length),
    };
  }

  async read(id: string): Promise<CompletedEpisode | null> {
    const source = this.source;
    const ref = parseEpisodeId(id);
    if (!source || !ref) return null;
    if (ref.id === (await openId(source))) return null;
    const handle = await openEpisodeFile(source.episodicDir, id);
    if (!handle) return null;
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    if (source !== this.source || ref.id === (await openId(source)))
      return null;
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let recordCount = 0;
    for (const line of content.split(/\r?\n/)) {
      const entry = parseEpisodeRecordLine(line);
      if (!entry) continue;
      startedAt ??= entry.at;
      endedAt = entry.at;
      recordCount += 1;
    }
    if (!startedAt || !endedAt) return null;
    return {
      ...ref,
      startedAt,
      endedAt,
      recordCount,
      text: renderEpisodeText(content, { timestamps: true }),
    };
  }

  private async listAllCompleted(): Promise<EpisodeRef[]> {
    const source = this.source;
    if (!source) return [];
    // List before reading the open episode: a file created meanwhile is
    // either missing from the list or is the open episode.
    const refs = await this.getOrderedRefs(source);
    const open = await openId(source);
    if (source !== this.source) return [];
    return refs.filter((ref) => ref.id !== open);
  }

  private getOrderedRefs(source: EpisodeFeedSource): Promise<EpisodeRef[]> {
    if (!this.orderedRefs) {
      const snapshot = listEpisodeRefs(source.episodicDir).then((refs) =>
        refs.sort(compareEpisodeRefs),
      );
      this.orderedRefs = snapshot;
      void snapshot.catch(() => {
        if (this.orderedRefs === snapshot) this.orderedRefs = null;
      });
    }
    return this.orderedRefs;
  }
}

async function openId(source: EpisodeFeedSource): Promise<string | null> {
  const open = await source.getOpenEpisode();
  return open ? openEpisodeId(source.episodicDir, open.path) : null;
}

async function listEpisodeRefs(episodicDir: string): Promise<EpisodeRef[]> {
  const dates = await readdirOrEmpty(episodicDir);
  const refs: EpisodeRef[] = [];
  for (const date of dates) {
    if (!date.isDirectory() || !DATE_PATTERN.test(date.name)) continue;
    for (const file of await readdirOrEmpty(join(episodicDir, date.name))) {
      if (!file.isFile() || !FILE_PATTERN.test(file.name)) continue;
      const ref = parseEpisodeId(`${date.name}/${file.name}`);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

async function listNewestEpisodeRefs(
  episodicDir: string,
  count: number,
): Promise<EpisodeRef[]> {
  const dates = (await readdirOrEmpty(episodicDir))
    .filter((entry) => entry.isDirectory() && DATE_PATTERN.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  const refs: EpisodeRef[] = [];
  for (const date of dates) {
    const daily = (await readdirOrEmpty(join(episodicDir, date.name)))
      .filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const ref = parseEpisodeId(`${date.name}/${entry.name}`);
        return ref ? [ref] : [];
      })
      .sort((left, right) => compareEpisodeRefs(right, left));
    refs.push(...daily.slice(0, count - refs.length));
    if (refs.length >= count) break;
  }
  return refs.reverse();
}

async function readdirOrEmpty(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function openEpisodeId(episodicDir: string, path: string): string {
  return relative(episodicDir, path).split(sep).join('/');
}

export function createEpisodeFeed(): EpisodeFeedHub {
  return new EpisodeFeedModule();
}

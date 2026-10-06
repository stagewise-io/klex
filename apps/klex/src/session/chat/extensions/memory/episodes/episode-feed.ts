import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { EpisodeStoreState } from './episode-files';
import { parseEpisodeRecordLine, renderEpisodeText } from './episode-format';

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
  /** Finished episodes strictly after `after` (null = from the start), oldest first. */
  listCompleted(after: string | null, limit: number): Promise<EpisodeRef[]>;
  /** Newest `count` finished episodes, oldest first. */
  listLatestCompleted(count: number): Promise<EpisodeRef[]>;
  read(id: string): Promise<CompletedEpisode | null>;
}

export interface EpisodeFeedSource {
  episodicDir: string;
  getOpenEpisode: () => EpisodeStoreState | null;
}

export interface EpisodeFeedHub extends EpisodeFeed {
  /** Attaches the live episode store. Returns a detach function. */
  attach(source: EpisodeFeedSource): () => void;
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

/**
 * Exposes finished episodes of the memory extension. An episode is finished
 * when it is not the store's open episode. Episodes are never reopened, so
 * after a restart every existing file is finished.
 *
 * An idle open episode is deliberately still unfinished: a long step can
 * extend activity without the idle check and append to it again. It
 * finishes with the next rotation.
 */
class EpisodeFeedModule implements EpisodeFeedHub {
  private source: EpisodeFeedSource | null = null;

  attach(source: EpisodeFeedSource): () => void {
    if (this.source) throw new Error('Episode feed is already attached');
    this.source = source;
    return () => {
      if (this.source === source) this.source = null;
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
    const completed = await this.listAllCompleted();
    const later = cursor
      ? completed.filter((ref) => compareEpisodeRefs(ref, cursor) > 0)
      : completed;
    return later.slice(0, Math.max(0, limit));
  }

  async listLatestCompleted(count: number): Promise<EpisodeRef[]> {
    if (count <= 0) return [];
    return (await this.listAllCompleted()).slice(-count);
  }

  async read(id: string): Promise<CompletedEpisode | null> {
    const source = this.source;
    const ref = parseEpisodeId(id);
    if (!source || !ref) return null;
    let content: string;
    try {
      content = await readFile(join(source.episodicDir, id), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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
    const refs = await listEpisodeRefs(source.episodicDir);
    const open = source.getOpenEpisode();
    const openId = open ? openEpisodeId(source.episodicDir, open.path) : null;
    return refs.filter((ref) => ref.id !== openId).sort(compareEpisodeRefs);
  }
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

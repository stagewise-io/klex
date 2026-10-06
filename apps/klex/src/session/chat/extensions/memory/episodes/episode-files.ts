import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleLogger } from '@stagewise/logger';

import type { EpisodeRotationConfig } from '@/config';

import {
  createEpisodeHeader,
  createEpisodeRecordEntry,
  EPISODE_FILE_EXTENSION,
  type EpisodeRecordInput,
} from './episode-format';

interface OpenEpisode {
  path: string;
  date: string;
  createdAt: number;
  characters: number;
}

export interface EpisodeStoreOptions {
  episodicDir: string;
  /** Read once per `append`, so config changes apply to the next record. */
  getLimits: () => EpisodeRotationConfig;
  logger: ModuleLogger;
}

export interface EpisodeStoreState {
  path: string;
  characters: number;
  createdAt: number;
  lastActivityAt: number | null;
}

/** Legacy `.md` episodes still count so indexes never collide with them. */
const EPISODE_FILE_PATTERN = /^(\d+)-\d{2}-\d{2}\.(?:jsonl|md)$/;
const HEADER_LINE = `${JSON.stringify(createEpisodeHeader())}\n`;
const MAX_CREATE_ATTEMPTS = 5;

/**
 * Appends history records as JSON Lines episode entries and rotates
 * episodes. Sizes count characters of the serialized lines.
 *
 * A new episode starts before a record when the UTC date changed, the
 * episode reached `maxDurationMs`, activity paused for `idleTimeoutMs`, or
 * the record would push a non-empty episode past `maxCharacters`. The
 * record that crosses the size limit goes whole into the new episode; a
 * record larger than the limit goes into a new episode alone.
 *
 * There are no timers: a file is created together with its first entry, so
 * empty episodes cannot exist. Episodes are never reopened, so the first
 * append after a restart starts a new one.
 *
 * Each episode's share of a batch is written with a single `appendFile`.
 * A failed write closes the episode, so the retry starts a new file on a
 * clean line boundary instead of extending a torn line. A crash or failed
 * write leaves at most one truncated trailing line, which readers skip as
 * invalid JSON.
 */
export class EpisodeStore {
  private open: OpenEpisode | null = null;
  private lastActivityAt: number | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: EpisodeStoreOptions) {}

  append(
    records: readonly EpisodeRecordInput[],
    now = Date.now(),
  ): Promise<void> {
    return this.enqueue(async () => {
      if (records.length === 0) return;
      const limits = this.options.getLimits();
      const instant = new Date(now);
      let pending = '';
      for (const record of records) {
        const line = `${JSON.stringify(createEpisodeRecordEntry(record, instant))}\n`;
        if (this.shouldRotate(limits, now, line.length)) {
          await this.writePending(pending);
          pending = '';
          this.open = null;
        }
        const episode = this.open ?? (await this.createEpisode(instant));
        pending += line;
        episode.characters += line.length;
      }
      await this.writePending(pending);
      this.lastActivityAt = now;
    });
  }

  /**
   * Records main-session activity without writing. The idle rule is applied
   * before the timestamp moves; updating first would erase every idle gap.
   */
  observeActivity(now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.isIdle(this.options.getLimits(), now)) this.open = null;
      this.lastActivityAt = now;
    });
  }

  /**
   * Records that ongoing activity continued until `now` without applying the
   * idle rule, e.g. when a long step completes.
   */
  extendActivity(now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      this.lastActivityAt = now;
    });
  }

  /**
   * The open episode, read in queue order: an episode file being created
   * or rotated is already open by the time this resolves.
   */
  readOpenEpisode(): Promise<EpisodeStoreState | null> {
    return this.enqueue(async () => this.introspect());
  }

  introspect(): EpisodeStoreState | null {
    if (!this.open) return null;
    return {
      path: this.open.path,
      characters: this.open.characters,
      createdAt: this.open.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  private shouldRotate(
    limits: EpisodeRotationConfig,
    now: number,
    entrySize: number,
  ): boolean {
    const open = this.open;
    if (!open) return false;
    return (
      formatUtcDate(new Date(now)) !== open.date ||
      now - open.createdAt >= limits.maxDurationMs ||
      this.isIdle(limits, now) ||
      (open.characters > HEADER_LINE.length &&
        open.characters + entrySize > limits.maxCharacters)
    );
  }

  /** Appends lines to the open episode; a failed write closes it. */
  private async writePending(lines: string): Promise<void> {
    const episode = this.open;
    if (!episode || lines.length === 0) return;
    try {
      await appendFile(episode.path, lines, 'utf-8');
    } catch (error) {
      this.open = null;
      throw error;
    }
  }

  private isIdle(limits: EpisodeRotationConfig, now: number): boolean {
    return (
      this.lastActivityAt !== null &&
      now - this.lastActivityAt >= limits.idleTimeoutMs
    );
  }

  private async createEpisode(instant: Date): Promise<OpenEpisode> {
    const date = formatUtcDate(instant);
    const directory = join(this.options.episodicDir, date);
    await mkdir(directory, { recursive: true });
    for (let attempt = 1; ; attempt += 1) {
      const index = await nextDailyIndex(directory);
      const path = join(
        directory,
        `${index}-${formatUtcTime(instant)}${EPISODE_FILE_EXTENSION}`,
      );
      try {
        await writeFile(path, HEADER_LINE, {
          encoding: 'utf-8',
          flag: 'wx',
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' || attempt >= MAX_CREATE_ATTEMPTS) throw error;
        this.options.logger.warn(
          { path, attempt },
          'Episode file already exists — retrying with the next index',
        );
        continue;
      }
      this.open = {
        path,
        date,
        createdAt: instant.getTime(),
        characters: HEADER_LINE.length,
      };
      return this.open;
    }
  }

  /** Serializes async operations that touch episode state and files. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(fn);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function nextDailyIndex(directory: string): Promise<number> {
  let filenames: string[];
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 1;
  }
  let highest = 0;
  for (const filename of filenames) {
    const match = EPISODE_FILE_PATTERN.exec(filename);
    const index = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    highest = Math.max(highest, index);
  }
  return highest + 1;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatUtcTime(date: Date): string {
  return date.toISOString().slice(11, 16).replace(':', '-');
}

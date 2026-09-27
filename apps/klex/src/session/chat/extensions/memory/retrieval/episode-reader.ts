import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  episodeEntryText,
  parseEpisodeRecordLine,
} from '../episodes/episode-format';

export interface EpisodicEntryLocation {
  relativeFile: string;
  entryOrdinal: number;
  occurredAt: string;
  /** Line-format text of the record, as the history view renders it. */
  text: string;
}

/**
 * Parses a JSONL episode into entries, converting each record to line
 * format so search and context reads see the same text as before. Header,
 * blank, and invalid lines (such as a crash-truncated tail) are skipped.
 */
export function parseEpisodeEntries(
  content: string,
  relativeFile: string,
): EpisodicEntryLocation[] {
  const entries: EpisodicEntryLocation[] = [];
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEpisodeRecordLine(line);
    if (!entry) continue;
    entries.push({
      relativeFile,
      entryOrdinal: entries.length,
      occurredAt: entry.at,
      text: episodeEntryText(entry),
    });
  }
  return entries;
}

export interface EpisodicFileState {
  relativeFile: string;
  size: number;
  mtimeMs: number;
}

/** Legacy `.md` episodes are intentionally not read. */
const EPISODE_FILE_PATTERN = /^\d+-\d{2}-\d{2}\.jsonl$/;

export class EpisodicEntryStore {
  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async listFiles(): Promise<EpisodicFileState[]> {
    await this.ensure();
    const dates = await readdir(this.root, { withFileTypes: true });
    const result: EpisodicFileState[] = [];
    for (const date of dates) {
      if (!date.isDirectory()) continue;
      const directory = join(this.root, date.name);
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !EPISODE_FILE_PATTERN.test(file.name)) continue;
        const path = join(directory, file.name);
        const details = await stat(path);
        result.push({
          relativeFile: relative(this.root, path),
          size: details.size,
          mtimeMs: details.mtimeMs,
        });
      }
    }
    return result.sort((left, right) =>
      left.relativeFile.localeCompare(right.relativeFile),
    );
  }

  async read(relativeFile: string): Promise<EpisodicEntryLocation[]> {
    const path = join(this.root, relativeFile);
    return parseEpisodeEntries(await readFile(path, 'utf8'), relativeFile);
  }

  async readNeighbors(
    location: EpisodicEntryLocation,
    before: number,
    after: number,
  ): Promise<EpisodicEntryLocation[]> {
    const entries = await this.read(location.relativeFile);
    const index = entries.findIndex(
      (entry) => entry.entryOrdinal === location.entryOrdinal,
    );
    if (index < 0) return [location];
    return entries.slice(Math.max(0, index - before), index + after + 1);
  }
}

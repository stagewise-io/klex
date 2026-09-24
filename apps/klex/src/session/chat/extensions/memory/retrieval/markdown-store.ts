import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface EpisodicEntryLocation {
  relativeFile: string;
  entryOrdinal: number;
  occurredAt: string;
  text: string;
}

export function parseEpisodeEntries(
  content: string,
  relativeFile: string,
): EpisodicEntryLocation[] {
  const entries: EpisodicEntryLocation[] = [];
  let ordinal = 0;
  for (const line of content.split('\n')) {
    const match = ENTRY_PATTERN.exec(line);
    if (!match?.[1] || !match[2]) continue;
    entries.push({
      relativeFile,
      entryOrdinal: ordinal++,
      occurredAt: `${relativeFile.slice(0, 10)}T${match[1]}:00Z`,
      text: match[2].trim(),
    });
  }
  return entries;
}

export interface EpisodicFileState {
  relativeFile: string;
  size: number;
  mtimeMs: number;
}

const EPISODE_FILE_PATTERN = /^\d+-\d{2}-\d{2}\.md$/;
const ENTRY_PATTERN = /^- (\d{2}:\d{2}): (.+)$/;

export class EpisodicMarkdownStore {
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

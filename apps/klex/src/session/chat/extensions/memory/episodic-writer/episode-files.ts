import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export interface MemoryEntry {
  data: string;
  time: string;
}

interface OpenEpisode {
  createdAt: number;
  date: string;
  entryCount: number;
  path: string;
}

export interface EpisodeStoreOptions {
  episodicDir: string;
  onResetRequired: () => void;
  timezone: string;
  now?: () => Date;
  maxEntries?: number;
  maxAgeMs?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const EPISODE_FILE_PATTERN = /^(\d+)-\d{2}-\d{2}\.md$/;
const EPISODE_FRONTMATTER = '---\nanalyzed: false\n---\n\n';

/** Owns the single active episode and keeps file lifecycle opaque to the model. */
export class EpisodeStore {
  private readonly now: () => Date;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private openEpisode: OpenEpisode | null = null;
  private ageTimer: NodeJS.Timeout | null = null;
  private resetRequired = false;
  private readonly pendingEntries: MemoryEntry[] = [];
  private fingerprintDate: string | null = null;
  private readonly dailyFingerprints = new Set<string>();
  private duplicateEntriesSkipped = 0;

  constructor(private readonly options: EpisodeStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  async store(entry: MemoryEntry): Promise<void> {
    if (this.resetRequired) {
      this.pendingEntries.push(entry);
      return;
    }

    await this.append(entry);
  }

  /** Closes the current episode and requires a fresh writer context. */
  finishCurrentEpisode(): void {
    this.closeOpenEpisode();
    this.requireReset();
  }

  /** Called only after a fresh child session has started. */
  async completeReset(): Promise<void> {
    this.resetRequired = false;
    const entries = this.pendingEntries.splice(0);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (this.resetRequired) {
        this.pendingEntries.unshift(...entries.slice(index));
        break;
      }
      await this.append(entry);
    }
  }

  needsReset(): boolean {
    return this.resetRequired;
  }

  close(): void {
    this.closeOpenEpisode();
  }

  introspect(): Record<string, unknown> {
    return {
      openEpisode: this.openEpisode,
      pendingEntryCount: this.pendingEntries.length,
      duplicateEntriesSkipped: this.duplicateEntriesSkipped,
      resetRequired: this.resetRequired,
    };
  }

  private async append(entry: MemoryEntry): Promise<void> {
    const instant = this.toUtcInstant(entry.time);
    const date = formatUtcDate(instant);
    const utcTime = instant.toISOString().slice(11, 16);
    const fingerprint = `${utcTime}: ${normalizeMemoryData(entry.data)}`;
    await this.loadDailyFingerprints(date);
    if (this.dailyFingerprints.has(fingerprint)) {
      this.duplicateEntriesSkipped += 1;
      return;
    }

    if (this.openEpisode && this.openEpisode.date !== date) {
      this.closeOpenEpisode();
    }

    const episode =
      this.openEpisode ?? (await this.createEpisode(date, instant));
    await appendFile(episode.path, `- ${utcTime}: ${entry.data}\n`, 'utf-8');
    this.dailyFingerprints.add(fingerprint);
    episode.entryCount += 1;
    if (episode.entryCount >= this.maxEntries) {
      this.closeOpenEpisode();
      this.requireReset();
    }
  }

  private async loadDailyFingerprints(date: string): Promise<void> {
    if (this.fingerprintDate === date) return;
    this.fingerprintDate = date;
    this.dailyFingerprints.clear();
    const directory = join(this.options.episodicDir, date);
    let filenames: string[];
    try {
      filenames = await readdir(directory);
    } catch {
      return;
    }
    for (const filename of filenames) {
      if (!EPISODE_FILE_PATTERN.test(filename)) continue;
      const content = await readFile(join(directory, filename), 'utf-8');
      for (const line of content.split('\n')) {
        const match = /^- (\d{2}:\d{2}): (.+)$/.exec(line);
        if (!match?.[1] || !match[2]) continue;
        this.dailyFingerprints.add(
          `${match[1]}: ${normalizeMemoryData(match[2])}`,
        );
      }
    }
  }

  private async createEpisode(
    date: string,
    instant: Date,
  ): Promise<OpenEpisode> {
    const directory = join(this.options.episodicDir, date);
    await mkdir(directory, { recursive: true });
    const index = await nextDailyIndex(directory);
    const path = join(directory, `${index}-${formatUtcTime(instant)}.md`);
    await writeFile(path, EPISODE_FRONTMATTER, {
      encoding: 'utf-8',
      flag: 'wx',
    });

    const episode = {
      createdAt: this.now().getTime(),
      date,
      entryCount: 0,
      path,
    };
    this.openEpisode = episode;
    this.ageTimer = setTimeout(() => {
      this.ageTimer = null;
      if (this.openEpisode !== episode) return;
      this.closeOpenEpisode();
      this.requireReset();
    }, this.maxAgeMs);
    return episode;
  }

  private closeOpenEpisode(): void {
    this.clearAgeTimer();
    this.openEpisode = null;
  }

  private toUtcInstant(time: string): Date {
    const [hourText, minuteText] = time.split(':');
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error(`Invalid memory entry time "${time}". Expected HH:mm.`);
    }

    const date = localDateAt(this.now(), this.options.timezone);
    return localTimeToUtcInstant(date, hour, minute, this.options.timezone);
  }

  private requireReset(): void {
    if (this.resetRequired) return;
    this.resetRequired = true;
    this.options.onResetRequired();
  }

  private clearAgeTimer(): void {
    if (!this.ageTimer) return;
    clearTimeout(this.ageTimer);
    this.ageTimer = null;
  }
}

function normalizeMemoryData(data: string): string {
  return data.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

async function nextDailyIndex(directory: string): Promise<number> {
  let filenames: string[];
  try {
    filenames = await readdir(directory);
  } catch {
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

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

function localDateAt(date: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: numberPart(parts, 'year'),
    month: numberPart(parts, 'month'),
    day: numberPart(parts, 'day'),
  };
}

function localTimeToUtcInstant(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const wallTime = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instant = new Date(wallTime);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const representedAsUtc = Date.UTC(
      numberPart(parts, 'year'),
      numberPart(parts, 'month') - 1,
      numberPart(parts, 'day'),
      numberPart(parts, 'hour'),
      numberPart(parts, 'minute'),
      numberPart(parts, 'second'),
    );
    const corrected = new Date(
      wallTime - (representedAsUtc - instant.getTime()),
    );
    if (corrected.getTime() === instant.getTime()) break;
    instant = corrected;
  }
  return instant;
}

function numberPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new Error(`Missing ${type} date part.`);
  return Number(value);
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatUtcTime(date: Date): string {
  return date.toISOString().slice(11, 16).replace(':', '-');
}

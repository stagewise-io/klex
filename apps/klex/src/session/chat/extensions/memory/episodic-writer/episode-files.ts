import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface MemoryEntry {
  data: string;
  time: string;
}

interface OpenEpisode {
  createdAt: number;
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

  store(entry: MemoryEntry): void {
    if (this.resetRequired) {
      this.pendingEntries.push(entry);
      return;
    }

    this.append(entry);
  }

  /** Closes the current episode and requires a fresh writer context. */
  finishCurrentEpisode(): void {
    this.closeOpenEpisode();
    this.requireReset();
  }

  /** Called only after a fresh child session has started. */
  completeReset(): void {
    this.resetRequired = false;
    const entries = this.pendingEntries.splice(0);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (this.resetRequired) {
        this.pendingEntries.unshift(...entries.slice(index));
        break;
      }
      this.append(entry);
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

  private append(entry: MemoryEntry): void {
    const date = formatUtcDate(this.now());
    const utcTime = this.toUtcTime(entry.time);
    const fingerprint = `${utcTime}: ${normalizeMemoryData(entry.data)}`;
    this.loadDailyFingerprints(date);
    if (this.dailyFingerprints.has(fingerprint)) {
      this.duplicateEntriesSkipped += 1;
      return;
    }

    const episode = this.openEpisode ?? this.createEpisode();
    updateEpisode(episode.path, `- ${utcTime}: ${entry.data}\n`);
    this.dailyFingerprints.add(fingerprint);
    episode.entryCount += 1;
    if (episode.entryCount >= this.maxEntries) {
      this.closeOpenEpisode();
      this.requireReset();
    }
  }

  private loadDailyFingerprints(date: string): void {
    if (this.fingerprintDate === date) return;
    this.fingerprintDate = date;
    this.dailyFingerprints.clear();
    const directory = join(this.options.episodicDir, date);
    if (!existsSync(directory)) return;
    for (const filename of readdirSync(directory)) {
      if (!EPISODE_FILE_PATTERN.test(filename)) continue;
      const content = readFileSync(join(directory, filename), 'utf-8');
      for (const line of content.split('\n')) {
        const match = /^- (\d{2}:\d{2}): (.+)$/.exec(line);
        if (!match?.[1] || !match[2]) continue;
        this.dailyFingerprints.add(
          `${match[1]}: ${normalizeMemoryData(match[2])}`,
        );
      }
    }
  }

  private createEpisode(): OpenEpisode {
    const createdAt = this.now();
    const date = formatUtcDate(createdAt);
    const directory = join(this.options.episodicDir, date);
    mkdirSync(directory, { recursive: true });
    const index = nextDailyIndex(directory);
    const path = join(directory, `${index}-${formatUtcTime(createdAt)}.md`);
    writeFileSync(path, EPISODE_FRONTMATTER, {
      encoding: 'utf-8',
      flag: 'wx',
    });

    const episode = {
      createdAt: createdAt.getTime(),
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

  private toUtcTime(time: string): string {
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
    return localTimeToUtc(date, hour, minute, this.options.timezone);
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

function updateEpisode(path: string, entryLine: string): void {
  const content = readFileSync(path, 'utf-8');
  writeFileSync(
    path,
    `${withUnanalyzedFrontmatter(content)}${entryLine}`,
    'utf-8',
  );
}

function withUnanalyzedFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return `${EPISODE_FRONTMATTER}${content}`;

  const closingDelimiter = content.indexOf('\n---\n', 4);
  if (closingDelimiter < 0) return `${EPISODE_FRONTMATTER}${content}`;

  const header = content.slice(4, closingDelimiter);
  const analyzedPattern = /^analyzed\s*:.*$/m;
  const nextHeader = analyzedPattern.test(header)
    ? header.replace(analyzedPattern, 'analyzed: false')
    : `${header}${header ? '\n' : ''}analyzed: false`;
  return `---\n${nextHeader}\n---\n${content.slice(closingDelimiter + 5)}`;
}

function normalizeMemoryData(data: string): string {
  return data.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function nextDailyIndex(directory: string): number {
  if (!existsSync(directory)) return 1;
  let highest = 0;
  for (const filename of readdirSync(directory)) {
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

function localTimeToUtc(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
): string {
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
  return instant.toISOString().slice(11, 16);
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

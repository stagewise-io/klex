import { dirname } from 'node:path';

import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type { ExtendedUIMessage } from '../../message-types';
import {
  createDataPart,
  type DataPartTransformers,
  dataPartTransformer,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  isDataPartOf,
  type ProvisionalStepContext,
} from '../extension-api';
import { readTimezoneStore, writeTimezoneStore } from './storage';
import systemPromptPart from './system-prompt.md';

const TIME_KEY = 'time';
const TIMEZONE_KEY = 'timezone';
const DEFAULT_TZ = 'UTC';

type TimeData = { timestamp: number; tz?: string };
type TimezoneData = { tz: string; timestamp: number };

// --- formatting helpers ---

function tzName(
  d: Date,
  tz: string,
  style: 'short' | 'long' | 'longOffset',
): string {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: style,
    })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/**
 * Derives a timezone abbreviation (e.g. "CEST") from the long
 * timezone name (e.g. "Central European Summer Time"). Used as a
 * fallback when the ICU `short` format returns a `GMT+X` offset
 * instead of a named abbreviation.
 */
function tzAbbr(d: Date, tz: string): string {
  const short = tzName(d, tz, 'short');
  if (!short.startsWith('GMT')) return short;
  const long = tzName(d, tz, 'long');
  if (long.startsWith('GMT')) return short;
  return long
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function tzOffset(d: Date, tz: string): string {
  const value = tzName(d, tz, 'longOffset');
  return value === 'GMT' ? '+00:00' : value.replace(/^GMT/, '');
}

function formatTime(ts: number, tz: string, full: boolean): string {
  const d = new Date(ts * 1000);
  const opts: Intl.DateTimeFormatOptions = full
    ? {
        weekday: 'long',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hourCycle: 'h23',
      }
    : { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' };
  const parts = new Intl.DateTimeFormat('en-US', {
    ...opts,
    timeZone: tz,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hm = `${get('hour').replace(/^0/, '')}:${get('minute')}`;
  return full
    ? `${get('weekday')}, ${get('day')}.${get('month')}.${get('year')}, ${hm}`
    : hm;
}

function formatTimeWithOffset(ts: number, tz: string): string {
  const d = new Date(ts * 1000);
  const base = formatTime(ts, tz, true);
  return `${base} ${tzOffset(d, tz)}`;
}

function formatTimezone(ts: number, tz: string): string {
  const d = new Date(ts * 1000);
  const abbr = tzAbbr(d, tz);
  return `${tz}, ${abbr}, ${tzOffset(d, tz)}`;
}

function dayKey(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latestPart(
  history: readonly ExtendedUIMessage[],
  key: string,
  accepts: (data: unknown) => boolean,
): ExtendedUIMessage['parts'][number] | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (
        part &&
        isDataPartOf(key, part as never) &&
        accepts((part as unknown as { data: unknown }).data)
      ) {
        return part;
      }
    }
  }
  return null;
}

function isTimeData(data: unknown): data is TimeData {
  return (
    isRecord(data) &&
    typeof data.timestamp === 'number' &&
    Number.isFinite(data.timestamp)
  );
}

function isTimezoneData(data: unknown): data is TimezoneData {
  return (
    isRecord(data) &&
    typeof data.timestamp === 'number' &&
    Number.isFinite(data.timestamp) &&
    typeof data.tz === 'string' &&
    isValidTimezone(data.tz)
  );
}

function latestTimeContext(history: readonly ExtendedUIMessage[]): {
  timestamp: number | null;
  timezone: string | null;
} {
  let timestamp: number | null = null;
  let timezone: string | null = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const parts = history[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!part) continue;

      if (timestamp === null && isDataPartOf(TIME_KEY, part as never)) {
        const data = (part as unknown as { data: unknown }).data;
        if (isTimeData(data)) timestamp = data.timestamp;
      }

      if (timezone === null && isDataPartOf(TIMEZONE_KEY, part as never)) {
        const data = (part as unknown as { data: unknown }).data;
        if (isTimezoneData(data)) timezone = data.tz;
      }

      if (timestamp !== null && timezone !== null) {
        return { timestamp, timezone };
      }
    }
  }

  return { timestamp, timezone };
}

class TimeExt implements Extension {
  private convDayKey: string | null = null;
  private readonly dataDirectory: string;
  private timezone = DEFAULT_TZ;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly cfg: TimeExtConfig,
  ) {
    this.dataDirectory = dirname(dirname(dirname(deps.getDataDir(true))));
  }

  async onStart(): Promise<void> {
    const persistedTimezone = await readTimezoneStore(this.dataDirectory);
    if (persistedTimezone !== undefined) {
      if (!isValidTimezone(persistedTimezone)) {
        throw new Error(
          `Stored timezone "${persistedTimezone}" is not a valid IANA identifier.`,
        );
      }
      this.timezone = persistedTimezone;
    }
  }

  getProvisionalStepContext(
    history: readonly ExtendedUIMessage[],
  ): ProvisionalStepContext {
    const now = Math.floor(Date.now() / 1000);
    const latest = latestTimeContext(history);
    const timeStale =
      latest.timestamp === null ||
      now < latest.timestamp ||
      now - latest.timestamp >= this.cfg.timeUpdatePeriod;
    const tzMissing = latest.timezone === null;
    const tzChanged =
      latest.timezone !== null && latest.timezone !== this.timezone;

    if (!timeStale && !tzMissing && !tzChanged) return { parts: [] };

    const parts = [
      createDataPart(TIME_KEY, { timestamp: now, tz: this.timezone }),
    ] as unknown as ExtendedUIMessage['parts'];
    if (tzMissing || tzChanged) {
      parts.push(
        createDataPart(TIMEZONE_KEY, {
          tz: this.timezone,
          timestamp: now,
        }) as never,
      );
    }

    return { parts };
  }

  historyTransformer(history: ExtendedUIMessage[]): ExtendedUIMessage[] {
    const first = history[0];
    if (!first) return history;

    const original = this.deps.getHistory();
    const cutoffIndex = original.findIndex(
      (message) => message.id === first.id,
    );
    if (cutoffIndex <= 0) return history;

    const removed = original.slice(0, cutoffIndex);
    const time = latestPart(removed, TIME_KEY, isTimeData);
    const timezone =
      latestPart(removed, TIMEZONE_KEY, isTimezoneData) ??
      createDataPart(TIMEZONE_KEY, {
        tz: this.timezone,
        timestamp: Math.floor(Date.now() / 1000),
      });

    return [
      {
        ...first,
        parts: [
          ...(time ? [structuredClone(time)] : []),
          structuredClone(timezone) as never,
          ...first.parts,
        ],
      },
      ...history.slice(1),
    ];
  }

  getTools(): ToolSet {
    return {
      getTime: tool({
        description: 'Get current time, optionally in one timezone.',
        inputSchema: z.object({
          timezone: z
            .string()
            .trim()
            .nullable()
            .default(null)
            .describe(
              'IANA timezone. Empty: current default. Does not change default.',
            ),
        }),
        execute: async ({ timezone }) => {
          const tz = timezone?.trim() || this.timezone;
          if (!isValidTimezone(tz)) {
            throw new Error(
              `Invalid timezone "${tz}". Use IANA identifier ("Europe/Berlin" or "UTC").`,
            );
          }
          const ts = Math.floor(Date.now() / 1000);
          return { time: formatTimeWithOffset(ts, tz) };
        },
      }),
      changeTimezone: tool({
        description:
          'Set default timezone for future time context. Only when regular work needs it.',
        inputSchema: z.object({
          timezone: z
            .string()
            .describe(
              'IANA timezone, e.g. "Europe/Berlin", "America/New_York", or "UTC".',
            ),
        }),
        execute: async ({ timezone }) => {
          if (!isValidTimezone(timezone)) {
            throw new Error(
              `Invalid timezone "${timezone}". Use IANA identifier ("Europe/Berlin" or "UTC").`,
            );
          }
          await writeTimezoneStore(this.dataDirectory, timezone);
          this.timezone = timezone;
          return { timezone };
        },
      }),
    };
  }

  getSystemPromptPart(): string {
    return systemPromptPart;
  }

  dataPartTransformers: DataPartTransformers = {
    [TIME_KEY]: dataPartTransformer<TimeData>((data, occurrence) => {
      if (!isTimeData(data)) return [];
      const tz =
        typeof data.tz === 'string' && isValidTimezone(data.tz)
          ? data.tz
          : DEFAULT_TZ;
      const key = dayKey(data.timestamp, tz);
      const full = occurrence === 0 || this.convDayKey !== key;
      this.convDayKey = key;
      return [
        {
          type: 'text',
          text: `<time>${formatTime(data.timestamp, tz, full)}</time>`,
        },
      ];
    }),
    [TIMEZONE_KEY]: dataPartTransformer<TimezoneData>((data) => {
      if (!isTimezoneData(data)) return [];
      return [
        {
          type: 'text',
          text: `<timezone>${formatTimezone(data.timestamp, data.tz)}</timezone>`,
        },
      ];
    }),
  };

  introspect(): Record<string, unknown> {
    return {
      timeUpdatePeriod: this.cfg.timeUpdatePeriod,
      timezone: this.timezone,
    };
  }
}

export interface TimeExtConfig {
  /** Minimum whole seconds between updates before executable generations. */
  timeUpdatePeriod: number;
}

export function createTimeExt(config: TimeExtConfig): ExtensionFactory {
  if (
    !Number.isFinite(config.timeUpdatePeriod) ||
    !Number.isInteger(config.timeUpdatePeriod) ||
    config.timeUpdatePeriod < 0
  ) {
    throw new Error('timeUpdatePeriod must be a non-negative integer.');
  }

  return {
    identifier: 'io.stagewise/time',
    displayName: 'Time',
    create: (deps) => new TimeExt(deps, config),
  };
}

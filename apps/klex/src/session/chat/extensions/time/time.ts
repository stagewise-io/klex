import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type { DataBlock } from '@/session/chat/utils/history-view';

import type { ExtendedUIMessage } from '../../message-types';
import {
  blockPartTransformer,
  createDataPart,
  type DataPartTransformers,
  type Extension,
  type ExtensionFactory,
  isDataPartOf,
  type ProvisionalStepContext,
} from '../extension-api';
import systemPromptPart from './system-prompt.md';

const TIME_KEY = 'time';
const TIMEZONE_KEY = 'timezone';

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

export function formatTimeContext(
  ts: number,
  tz: string,
  full: boolean,
): string {
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
  const base = formatTimeContext(ts, tz, true);
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
    Number.isFinite(new Date(data.timestamp * 1000).getTime())
  );
}

/** Self-contained timestamps for history; never mutates live conversion state. */
export function timeHistoryBlocks(
  data: unknown,
  fallbackTimezone = 'UTC',
): readonly DataBlock[] {
  if (!isTimeData(data)) return [];
  const tz =
    typeof data.tz === 'string' && isValidTimezone(data.tz)
      ? data.tz
      : fallbackTimezone;
  return [{ type: 'time', value: formatTimeContext(data.timestamp, tz, true) }];
}

function isTimezoneData(data: unknown): data is TimezoneData {
  return (
    isRecord(data) &&
    typeof data.timestamp === 'number' &&
    Number.isFinite(new Date(data.timestamp * 1000).getTime()) &&
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

  constructor(private readonly cfg: TimeExtConfig) {}

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
      latest.timezone !== null && latest.timezone !== this.cfg.timezone;

    if (!timeStale && !tzMissing && !tzChanged) return { parts: [] };

    const parts = [
      createDataPart(TIME_KEY, { timestamp: now, tz: this.cfg.timezone }),
    ] as unknown as ExtendedUIMessage['parts'];
    if (tzMissing || tzChanged) {
      parts.push(
        createDataPart(TIMEZONE_KEY, {
          tz: this.cfg.timezone,
          timestamp: now,
        }) as never,
      );
    }

    return { parts };
  }

  /**
   * Carries the latest valid time and timezone out of the dropped prefix.
   * A missing time is not invented; a missing timezone falls back to the
   * startup timezone so the header always anchors the clock's zone.
   */
  getCheckpointCarry(
    dropped: readonly ExtendedUIMessage[],
  ): ExtendedUIMessage['parts'] {
    const time = latestPart(dropped, TIME_KEY, isTimeData);
    const timezone =
      latestPart(dropped, TIMEZONE_KEY, isTimezoneData) ??
      (createDataPart(TIMEZONE_KEY, {
        tz: this.cfg.timezone,
        timestamp: Math.floor(Date.now() / 1000),
      }) as unknown as ExtendedUIMessage['parts'][number]);

    return [
      ...(time ? [structuredClone(time)] : []),
      structuredClone(timezone),
    ];
  }

  getTools(): ToolSet {
    const tools: ToolSet = {
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
          const tz = timezone?.trim() || this.cfg.timezone;
          if (!isValidTimezone(tz)) {
            throw new Error(
              `Invalid timezone "${tz}". Use IANA identifier ("Europe/Berlin" or "UTC").`,
            );
          }
          const ts = Math.floor(Date.now() / 1000);
          return { time: formatTimeWithOffset(ts, tz) };
        },
      }),
    };

    return tools;
  }

  getSystemPromptPart(): string {
    return systemPromptPart;
  }

  dataPartTransformers: DataPartTransformers = {
    [TIME_KEY]: blockPartTransformer<TimeData>(
      (data, occurrence) => {
        if (!isTimeData(data)) return [];
        const tz =
          typeof data.tz === 'string' && isValidTimezone(data.tz)
            ? data.tz
            : this.cfg.timezone;
        const key = dayKey(data.timestamp, tz);
        const full = occurrence === 0 || this.convDayKey !== key;
        this.convDayKey = key;
        return [
          { type: 'time', value: formatTimeContext(data.timestamp, tz, full) },
        ];
      },
      (data) => timeHistoryBlocks(data, this.cfg.timezone),
    ),
    [TIMEZONE_KEY]: blockPartTransformer<TimezoneData>((data) => {
      if (!isTimezoneData(data)) return [];
      return [
        { type: 'timezone', value: formatTimezone(data.timestamp, data.tz) },
      ];
    }),
  };

  introspect(): Record<string, unknown> {
    return {
      timeUpdatePeriod: this.cfg.timeUpdatePeriod,
      timezone: this.cfg.timezone,
    };
  }
}

export interface TimeExtConfig {
  /** Minimum whole seconds between updates before executable generations. */
  timeUpdatePeriod: number;
  /** IANA timezone resolved once during process startup. */
  timezone: string;
}

/** Adds timezone-aware current-time context to a session at the configured cadence. */
export function createTimeExt(config: TimeExtConfig): ExtensionFactory {
  if (!isValidTimezone(config.timezone)) {
    throw new Error(
      `timezone must be a valid IANA identifier; received "${config.timezone}".`,
    );
  }
  if (
    !Number.isFinite(config.timeUpdatePeriod) ||
    !Number.isInteger(config.timeUpdatePeriod) ||
    config.timeUpdatePeriod < 0
  ) {
    throw new Error('timeUpdatePeriod must be a non-negative integer.');
  }

  const startupConfig = { ...config };
  return {
    identifier: 'io.stagewise/time',
    displayName: 'Time',
    create: () => new TimeExt(startupConfig),
  };
}

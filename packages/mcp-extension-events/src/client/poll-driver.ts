import {
  DEFAULT_MIN_POLL_INTERVAL_MS,
  EVENTS_ERROR_CODES,
} from '../constants.js';
import type { EventOccurrence, EventsPollResult } from '../spec.types.js';
import type { RegisteredEventsClient } from './events-client.js';

export interface PollBatch {
  events: EventOccurrence[];
  /** Cursor after this batch. `null` when the event type has no replay. */
  cursor: string | null;
  /** True when the server skipped events (possible gap). */
  truncated: boolean;
}

export interface PollDriverOptions {
  client: Pick<RegisteredEventsClient, 'poll'>;
  name: string;
  arguments?: Record<string, unknown>;
  /** Last cursor the caller committed; `null`/absent = start from now. */
  cursor?: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
  signal: AbortSignal;
  /**
   * Called for every poll result, including empty ones that only advance the
   * cursor (`events` is `[]`). The loop waits for it before polling again, so
   * a slow consumer applies backpressure. A throw is treated as a transient
   * failure and the same cursor is polled again (events are re-delivered).
   */
  onBatch(batch: PollBatch): void | Promise<void>;
  /** Called once when the subscription can never succeed (see below). */
  onTerminated?(error: unknown): void;
  /** Called on every transient failure before the backoff sleep. */
  onError?(error: unknown): void;
  minIntervalMs?: number;
  maxBackoffMs?: number;
  /** Injectable for tests. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
}

/** Errors that no amount of retrying fixes without a new subscription. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  EVENTS_ERROR_CODES.MethodNotFound,
  EVENTS_ERROR_CODES.InvalidParams,
  EVENTS_ERROR_CODES.NotFound,
  EVENTS_ERROR_CODES.Forbidden,
  EVENTS_ERROR_CODES.Unsupported,
]);

export function isTerminalEventsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && TERMINAL_CODES.has(code);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Runs one poll loop for one subscription until aborted or terminated.
 * Resolves when the loop ends; never rejects.
 */
export async function runPollLoop(options: PollDriverOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const floor = options.minIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  let cursor: string | null = options.cursor ?? null;
  let failures = 0;
  let immediatePolls = 0;

  while (!options.signal.aborted) {
    let result: EventsPollResult;
    try {
      result = await options.client.poll(
        {
          name: options.name,
          ...(options.arguments === undefined
            ? {}
            : { arguments: options.arguments }),
          cursor,
          // maxAgeMs is ignored by servers for a null cursor, so always safe.
          ...(options.maxAgeMs === undefined
            ? {}
            : { maxAgeMs: options.maxAgeMs }),
          ...(options.maxEvents === undefined
            ? {}
            : { maxEvents: options.maxEvents }),
        },
        { request: { signal: options.signal } },
      );
      if (options.signal.aborted) return;
    } catch (error) {
      if (options.signal.aborted) return;
      if (isTerminalEventsError(error)) {
        options.onTerminated?.(error);
        return;
      }
      failures++;
      options.onError?.(error);
      await sleep(backoffMs(failures, maxBackoff, random), options.signal);
      continue;
    }

    const next = result.cursor ?? null;
    try {
      await options.onBatch({
        events: result.events,
        cursor: next,
        truncated: result.truncated === true,
      });
    } catch (error) {
      if (options.signal.aborted) return;
      failures++;
      options.onError?.(error);
      await sleep(backoffMs(failures, maxBackoff, random), options.signal);
      continue;
    }

    failures = 0;
    const progressed = next !== cursor;
    cursor = next;
    if (options.signal.aborted) return;
    // Bound even advancing backlog drains; duplicate/empty same-cursor pages
    // must never bypass the rate floor.
    if (result.hasMore === true && progressed && ++immediatePolls < 32)
      continue;
    immediatePolls = 0;
    // Floor protects against a server that induces a tight loop.
    await sleep(Math.max(result.nextPollMs ?? floor, floor), options.signal);
  }
}

export function backoffMs(
  failures: number,
  maxBackoffMs: number,
  random: () => number,
): number {
  const base = Math.min(1000 * 2 ** (failures - 1), maxBackoffMs);
  return Math.round(base / 2 + random() * (base / 2));
}

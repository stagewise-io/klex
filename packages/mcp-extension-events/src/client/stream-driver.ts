import { HEARTBEAT_TIMEOUT_FACTOR } from '../constants.js';
import type {
  EventsActiveParams,
  EventsErrorParams,
  EventsEventParams,
  EventsHeartbeatParams,
  EventsTerminatedParams,
} from '../spec.types.js';
import {
  backoffMs,
  isTerminalEventsError,
  type PollBatch,
} from './poll-driver.js';

export interface StreamOpenParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
  heartbeatMs?: number;
}

/** Messages of one `events/stream`, already routed by subscription id. */
export interface StreamSink {
  active(params: EventsActiveParams): void;
  event(params: EventsEventParams): void;
  heartbeat(params: EventsHeartbeatParams): void;
  error(params: EventsErrorParams): void;
  terminated(params: EventsTerminatedParams): void;
}

/**
 * Transport port. `open` resolves when the stream ends (server result or
 * abort) and rejects when the request fails, including with a JSON-RPC error.
 * The SDK adapter implements this; the driver never touches the SDK.
 */
export interface StreamPort {
  open(
    params: StreamOpenParams,
    sink: StreamSink,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface StreamDriverOptions {
  port: StreamPort;
  name: string;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  maxAgeMs?: number;
  heartbeatMs?: number;
  activationTimeoutMs?: number;
  signal: AbortSignal;
  /**
   * Same contract as the poll driver. Resolve = durably handled, so the
   * cursor may advance. A throw drops the stream and reconnects from the last
   * cursor that was handled, so the failed event is delivered again.
   */
  onBatch(batch: PollBatch): void | Promise<void>;
  /** The subscription ended for good. The caller decides whether to resubscribe. */
  onTerminated?(error: unknown): void;
  onError?(error: unknown): void;
  maxBackoffMs?: number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
}

const DEFAULT_GRANTED_HEARTBEAT_MS = 30_000;

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
 * Runs one push subscription until aborted or terminated. Resolves when the
 * loop ends; never rejects.
 */
export async function runStreamLoop(
  options: StreamDriverOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  let cursor: string | null = options.cursor ?? null;
  let failures = 0;

  while (!options.signal.aborted) {
    const connection = new AbortController();
    const signal = AbortSignal.any([options.signal, connection.signal]);
    let tail: Promise<void> = Promise.resolve();
    let terminated: EventsTerminatedParams['error'] | undefined;
    let stalled = false;
    let consumerFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grantMs: number | undefined;
    const activationTimer = setTimeout(() => {
      stalled = true;
      connection.abort();
    }, options.activationTimeoutMs ?? 30_000);
    let queued = 0;

    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (grantMs === undefined) return;
      timer = setTimeout(() => {
        stalled = true;
        connection.abort();
      }, grantMs * HEARTBEAT_TIMEOUT_FACTOR);
    };

    const enqueue = (work: () => Promise<void>): void => {
      if (signal.aborted) return;
      // Bound retained closures while a consumer waits for quiescence.
      if (queued >= 128) {
        consumerFailed = true;
        connection.abort();
        return;
      }
      queued++;
      tail = tail.then(async () => {
        queued--;
        if (signal.aborted) return;
        try {
          await work();
        } catch (error) {
          consumerFailed = true;
          options.onError?.(error);
          connection.abort();
        }
      });
    };

    const deliver = async (
      events: PollBatch['events'],
      next: string | null,
      truncated: boolean,
    ): Promise<void> => {
      await options.onBatch({ events, cursor: next, truncated });
      cursor = next;
    };

    const sink: StreamSink = {
      active(params) {
        clearTimeout(activationTimer);
        if (
          params.heartbeatMs !== undefined &&
          (!Number.isFinite(params.heartbeatMs) || params.heartbeatMs <= 0)
        ) {
          consumerFailed = true;
          connection.abort();
          return;
        }
        grantMs =
          params.heartbeatMs ??
          options.heartbeatMs ??
          DEFAULT_GRANTED_HEARTBEAT_MS;
        failures = 0;
        arm();
        // `active` also reports a fresh cursor after a gap (truncated).
        enqueue(() =>
          deliver([], params.cursor ?? null, params.truncated === true),
        );
      },
      event(params) {
        arm();
        enqueue(() => {
          const { cursor: next, ...rest } = params;
          return deliver([{ ...rest, cursor: next }], next ?? null, false);
        });
      },
      heartbeat(params) {
        arm();
        // A null cursor means "no replay"; it must never replace a real one.
        if (params.cursor === undefined || params.cursor === null) return;
        const next = params.cursor;
        if (next === cursor) return;
        enqueue(() => deliver([], next, false));
      },
      error(params) {
        arm();
        options.onError?.(params.error);
      },
      terminated(params) {
        terminated = params.error;
        connection.abort();
      },
    };

    let openError: unknown;
    try {
      await options.port.open(
        {
          name: options.name,
          ...(options.arguments === undefined
            ? {}
            : { arguments: options.arguments }),
          cursor,
          ...(options.maxAgeMs === undefined
            ? {}
            : { maxAgeMs: options.maxAgeMs }),
          ...(options.heartbeatMs === undefined
            ? {}
            : { heartbeatMs: options.heartbeatMs }),
        },
        sink,
        signal,
      );
    } catch (error) {
      openError = error;
    }
    clearTimeout(activationTimer);
    if (timer !== undefined) clearTimeout(timer);
    await tail;

    if (options.signal.aborted) return;
    if (terminated !== undefined) {
      options.onTerminated?.(terminated);
      return;
    }
    if (
      openError !== undefined &&
      !stalled &&
      !consumerFailed &&
      isTerminalEventsError(openError)
    ) {
      options.onTerminated?.(openError);
      return;
    }
    if (openError !== undefined || stalled || consumerFailed) {
      failures++;
      options.onError?.(
        openError ??
          new Error(
            stalled ? 'Events stream heartbeat timeout' : 'Consumer failed',
          ),
      );
    } else {
      failures = Math.max(failures, 1);
    }
    await sleep(backoffMs(failures, maxBackoff, random), options.signal);
  }
}

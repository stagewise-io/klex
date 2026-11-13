import { randomUUID } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';

import { withEventsClientCapability } from '../capabilities.js';
import {
  EVENTS_ACTIVE_NOTIFICATION,
  EVENTS_ERROR_NOTIFICATION,
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_HEARTBEAT_NOTIFICATION,
  EVENTS_STREAM_METHOD,
  EVENTS_TERMINATED_NOTIFICATION,
  SUBSCRIPTION_ID_META_KEY,
} from '../constants.js';
import {
  EventsActiveParamsSchema,
  EventsErrorParamsSchema,
  EventsEventParamsSchema,
  EventsHeartbeatParamsSchema,
  EventsTerminatedParamsSchema,
} from '../generated/schema.js';
import type { StreamPort, StreamSink } from './stream-driver.js';

/** Private `_meta` marker used to find our request on the wire. */
const STREAM_TAG_META_KEY = 'io.stagewise/events-stream-tag';

type WireMessage = {
  id?: unknown;
  params?: { _meta?: Record<string, unknown> };
};
type SendFn = (message: never, ...rest: never[]) => Promise<void>;
type TransportLike = { send: SendFn };

/**
 * The SDK does not expose the JSON-RPC id of a request, but SEP-3415 routes
 * stream notifications by that id. Wrap the transport BEFORE
 * `client.connect(transport)` to observe the id of tagged requests.
 */
export interface RequestIdTap {
  /** Resolves with the wire id of the request carrying `tag`. */
  idFor(tag: string): Promise<string | number>;
  observe(tag: string, listener: (id: string | number) => void): void;
  forget(tag: string): void;
}

export function createRequestIdTap(transport: TransportLike): RequestIdTap {
  const observers = new Map<string, (id: string | number) => void>();
  const seen = new Map<string, string | number>();
  const waiting = new Map<string, (id: string | number) => void>();
  const original = transport.send.bind(transport) as (
    message: unknown,
    ...rest: unknown[]
  ) => Promise<void>;
  (transport as { send: unknown }).send = (
    message: unknown,
    ...rest: unknown[]
  ) => {
    const messages = Array.isArray(message) ? message : [message];
    for (const m of messages as WireMessage[]) {
      const tag = m.params?._meta?.[STREAM_TAG_META_KEY];
      if (
        typeof tag === 'string' &&
        (typeof m.id === 'number' || typeof m.id === 'string')
      ) {
        observers.get(tag)?.(m.id);
        seen.set(tag, m.id);
        waiting.get(tag)?.(m.id);
        waiting.delete(tag);
      }
    }
    return original(message, ...rest);
  };
  return {
    idFor(tag) {
      const id = seen.get(tag);
      if (id !== undefined) return Promise.resolve(id);
      return new Promise((resolve) => waiting.set(tag, resolve));
    },
    observe(tag, listener) {
      observers.set(tag, listener);
    },
    forget(tag) {
      observers.delete(tag);
      seen.delete(tag);
      waiting.delete(tag);
    },
  };
}

type StreamClient = Pick<
  Client,
  'request' | 'setNotificationHandler' | 'registerCapabilities'
>;

const NO_TIMEOUT_MS = 2 ** 31 - 1;

const routers = new WeakMap<object, Map<string | number, StreamSink>>();

function routerFor(client: StreamClient): Map<string | number, StreamSink> {
  const existing = routers.get(client);
  if (existing) return existing;
  const sinks = new Map<string | number, StreamSink>();
  const route =
    (pick: (sink: StreamSink) => (params: never) => void) =>
    async (params: Record<string, unknown>) => {
      const meta = params['_meta'] as Record<string, unknown> | undefined;
      const id = meta?.[SUBSCRIPTION_ID_META_KEY];
      if (typeof id !== 'string' && typeof id !== 'number') return;
      const sink = sinks.get(id);
      if (sink) pick(sink)(params as never);
    };
  const handlers: Array<
    [string, z.ZodType, (sink: StreamSink) => (params: never) => void]
  > = [
    [EVENTS_ACTIVE_NOTIFICATION, EventsActiveParamsSchema, (s) => s.active],
    [EVENTS_EVENT_NOTIFICATION, EventsEventParamsSchema, (s) => s.event],
    [
      EVENTS_HEARTBEAT_NOTIFICATION,
      EventsHeartbeatParamsSchema,
      (s) => s.heartbeat,
    ],
    [EVENTS_ERROR_NOTIFICATION, EventsErrorParamsSchema, (s) => s.error],
    [
      EVENTS_TERMINATED_NOTIFICATION,
      EventsTerminatedParamsSchema,
      (s) => s.terminated,
    ],
  ];
  for (const [method, schema, pick] of handlers) {
    client.setNotificationHandler(
      method as never,
      { params: schema } as never,
      route(pick) as never,
    );
  }
  routers.set(client, sinks);
  return sinks;
}

/**
 * `StreamPort` over a real SDK `Client`. Notifications for all streams on one
 * client are demultiplexed by `_meta["io.modelcontextprotocol/subscriptionId"]`.
 * Pass the tap created from the transport that the client is connected with.
 */
export function createSdkStreamPort(
  client: StreamClient,
  tap: RequestIdTap,
  metadata?: Record<string, unknown>,
): StreamPort {
  const sinks = routerFor(client);
  return {
    async open(params, sink, signal) {
      if (signal.aborted) return;
      const tag = randomUUID();
      let id: string | number | undefined;
      // Bind before sending: even a synchronous peer may notify in send().
      tap.observe(tag, (wireId) => {
        id = wireId;
        sinks.set(wireId, sink);
      });
      try {
        const request = client.request(
          {
            method: EVENTS_STREAM_METHOD,
            params: {
              ...params,
              _meta: withEventsClientCapability({
                ...metadata,
                [STREAM_TAG_META_KEY]: tag,
              }),
            },
          },
          z.looseObject({}),
          { signal, timeout: NO_TIMEOUT_MS },
        );
        await request;
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      } finally {
        if (id !== undefined) sinks.delete(id);
        tap.forget(tag);
      }
    },
  };
}

import type { Client, RequestOptions } from '@modelcontextprotocol/client';

import {
  resolveServerEventsSupport,
  withEventsCapability,
  withEventsClientCapability,
} from '../capabilities.js';
import {
  EVENTS_LIST_METHOD,
  EVENTS_POLL_METHOD,
  SERVER_DISCOVER_METHOD,
} from '../constants.js';
import {
  EventsListResultSchema,
  EventsPollResultSchema,
  ServerDiscoverResultSchema,
} from '../generated/schema.js';
import type {
  EventDescriptor,
  EventsCapabilities,
  EventsPollParams,
  EventsPollResult,
  ServerDiscoverResult,
} from '../spec.types.js';

export type EventsClientProtocol = Pick<
  Client,
  | 'getProtocolEra'
  | 'getServerCapabilities'
  | 'registerCapabilities'
  | 'request'
>;

export interface EventsRequestOptions {
  metadata?: Record<string, unknown>;
  request?: RequestOptions;
}

export interface RegisteredEventsClient {
  discover(options?: EventsRequestOptions): Promise<ServerDiscoverResult>;
  /** Never sends `events/*` to a server that did not advertise the extension. */
  serverSupportsEvents(options?: EventsRequestOptions): Promise<boolean>;
  listEvents(options?: EventsRequestOptions): Promise<EventDescriptor[]>;
  poll(
    params: EventsPollParams,
    options?: EventsRequestOptions,
  ): Promise<EventsPollResult>;
}

export class EventsUnsupportedError extends Error {
  constructor() {
    super('Server does not support the Events extension');
    this.name = 'EventsUnsupportedError';
  }
}

const MAX_LIST_PAGES = 100;

function withMeta<T extends Record<string, unknown>>(
  params: T,
  metadata?: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  return {
    ...params,
    _meta: withEventsClientCapability({
      ...(params['_meta'] as Record<string, unknown> | undefined),
      ...metadata,
    }),
  };
}

export function registerEventsClient(
  client: EventsClientProtocol,
): RegisteredEventsClient {
  client.registerCapabilities(withEventsCapability({}));
  let discoveryCapabilities: EventsCapabilities | undefined;
  let discoveryRequest: Promise<ServerDiscoverResult> | undefined;

  const discover = (
    options?: EventsRequestOptions,
  ): Promise<ServerDiscoverResult> => {
    if (discoveryRequest) return discoveryRequest;
    discoveryRequest = client
      .request(
        {
          method: SERVER_DISCOVER_METHOD,
          params: withMeta({}, options?.metadata),
        },
        ServerDiscoverResultSchema,
        options?.request,
      )
      .then((result) => {
        discoveryCapabilities = result.capabilities;
        return result;
      });
    discoveryRequest.catch(() => {
      discoveryRequest = undefined;
    });
    return discoveryRequest;
  };

  const serverSupportsEvents = async (
    options?: EventsRequestOptions,
  ): Promise<boolean> => {
    const initialization = client.getServerCapabilities();
    if (
      discoveryCapabilities !== undefined ||
      client.getProtocolEra() !== undefined ||
      initialization !== undefined
    ) {
      return resolveServerEventsSupport({
        discovery: discoveryCapabilities,
        initialization,
      });
    }
    await discover(options);
    return resolveServerEventsSupport({
      discovery: discoveryCapabilities,
      initialization: client.getServerCapabilities(),
    });
  };

  const requireSupport = async (
    options?: EventsRequestOptions,
  ): Promise<void> => {
    if (!(await serverSupportsEvents(options))) {
      throw new EventsUnsupportedError();
    }
  };

  return {
    discover,
    serverSupportsEvents,
    async listEvents(options) {
      await requireSupport(options);
      const events: EventDescriptor[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await client.request(
          {
            method: EVENTS_LIST_METHOD,
            params: withMeta(
              cursor === undefined ? {} : { cursor },
              options?.metadata,
            ),
          },
          EventsListResultSchema,
          options?.request,
        );
        events.push(...result.events);
        if (!result.nextCursor) return events;
        cursor = result.nextCursor;
      }
      throw new Error(`events/list exceeded ${MAX_LIST_PAGES} pages`);
    },
    async poll(params, options) {
      await requireSupport(options);
      return client.request(
        {
          method: EVENTS_POLL_METHOD,
          params: withMeta({ ...params }, options?.metadata),
        },
        EventsPollResultSchema,
        options?.request,
      );
    },
  };
}

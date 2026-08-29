import type { Client, RequestOptions } from '@modelcontextprotocol/client';

import { registerSubscriptionAcknowledgementHandler } from '@stagewise/mcp-extension-client';

import {
  resolveServerRealtimeMediaSupport,
  withRealtimeMediaCapability,
  withRealtimeMediaClientCapability,
} from '../capabilities.js';
import {
  REALTIME_MEDIA_ACCEPT_METHOD,
  REALTIME_MEDIA_END_METHOD,
  REALTIME_MEDIA_REJECT_METHOD,
  REALTIME_MEDIA_SESSION_ENDED_METHOD,
  REALTIME_MEDIA_SESSION_OFFERED_METHOD,
  SERVER_DISCOVER_METHOD,
  SUBSCRIPTIONS_LISTEN_METHOD,
} from '../constants.js';
import {
  AcceptRealtimeMediaSessionResultSchema,
  EndRealtimeMediaSessionResultSchema,
  RealtimeMediaSessionEndedNotificationParamsSchema,
  RealtimeMediaSessionOfferedNotificationParamsSchema,
  ServerDiscoverResultSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenResultSchema,
} from '../generated/schema.js';
import type {
  RealtimeMediaCapabilities,
  RealtimeMediaExtensionCapability,
  RealtimeMediaNotification,
  RealtimeMediaSubscription,
  ServerDiscoverResult,
} from '../spec.types.js';
import {
  decodeRealtimeMediaAcceptResult,
  type RealtimeMediaClientAcceptResult,
} from './transport-decoder.js';

export type RealtimeMediaClientProtocol = Pick<
  Client,
  | 'getProtocolEra'
  | 'getServerCapabilities'
  | 'registerCapabilities'
  | 'request'
  | 'setNotificationHandler'
>;

export interface RegisterRealtimeMediaClientOptions {
  capability?: RealtimeMediaExtensionCapability;
  onNotification?(
    notification: RealtimeMediaNotification,
  ): void | Promise<void>;
}

export interface RealtimeMediaRequestOptions {
  metadata?: Record<string, unknown>;
  request?: RequestOptions;
}

export interface RealtimeMediaSubscriptionHandle {
  readonly closed: Promise<void>;
}

export interface RegisteredRealtimeMediaClient {
  discover(
    options?: RealtimeMediaRequestOptions,
  ): Promise<ServerDiscoverResult>;
  listen(
    subscription?: RealtimeMediaSubscription,
    options?: RealtimeMediaRequestOptions,
  ): Promise<RealtimeMediaSubscriptionHandle>;
  accept(
    sessionId: string,
    options?: RealtimeMediaRequestOptions,
  ): Promise<RealtimeMediaClientAcceptResult>;
  reject(
    sessionId: string,
    options?: RealtimeMediaRequestOptions,
  ): Promise<void>;
  end(sessionId: string, options?: RealtimeMediaRequestOptions): Promise<void>;
  serverSupportsRealtimeMedia(
    options?: RealtimeMediaRequestOptions,
  ): Promise<boolean>;
}

function paramsWithCapability<T extends Record<string, unknown>>(
  params: T,
  capability: RealtimeMediaExtensionCapability,
  metadata?: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  return {
    ...params,
    _meta: withRealtimeMediaClientCapability(metadata ?? {}, capability),
  };
}

export function registerRealtimeMediaClient(
  client: RealtimeMediaClientProtocol,
  options: RegisterRealtimeMediaClientOptions = {},
): RegisteredRealtimeMediaClient {
  const capability = options.capability ?? {
    transports: ['livekit-room'],
    media: ['audio'],
  };
  client.registerCapabilities(withRealtimeMediaCapability({}, capability));
  let discoveryCapabilities: RealtimeMediaCapabilities | undefined;
  let discoveryRequest: Promise<ServerDiscoverResult> | undefined;
  let resolveAcknowledgement: (() => void) | undefined;

  const markServerSupport = (): void => {
    discoveryCapabilities = withRealtimeMediaCapability({}, capability);
  };

  const discover = (
    requestOptions?: RealtimeMediaRequestOptions,
  ): Promise<ServerDiscoverResult> => {
    if (discoveryRequest) return discoveryRequest;
    discoveryRequest = client
      .request(
        {
          method: SERVER_DISCOVER_METHOD,
          params: paramsWithCapability(
            {},
            capability,
            requestOptions?.metadata,
          ),
        },
        ServerDiscoverResultSchema,
        requestOptions?.request,
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

  const serverSupportsRealtimeMedia = async (
    requestOptions?: RealtimeMediaRequestOptions,
  ): Promise<boolean> => {
    const initialization = client.getServerCapabilities();
    if (
      discoveryCapabilities !== undefined ||
      client.getProtocolEra() !== undefined ||
      initialization !== undefined
    ) {
      return resolveServerRealtimeMediaSupport({
        discovery: discoveryCapabilities,
        initialization,
        localCapability: capability,
      });
    }
    await discover(requestOptions);
    return resolveServerRealtimeMediaSupport({
      discovery: discoveryCapabilities,
      initialization: client.getServerCapabilities(),
      localCapability: capability,
    });
  };

  const requireServerSupport = async (
    requestOptions?: RealtimeMediaRequestOptions,
  ): Promise<void> => {
    if (!(await serverSupportsRealtimeMedia(requestOptions))) {
      throw new Error('Server does not support the Realtime Media extension');
    }
  };

  client.setNotificationHandler(
    REALTIME_MEDIA_SESSION_OFFERED_METHOD,
    { params: RealtimeMediaSessionOfferedNotificationParamsSchema },
    async (params) => {
      markServerSupport();
      await options.onNotification?.({
        jsonrpc: '2.0',
        method: REALTIME_MEDIA_SESSION_OFFERED_METHOD,
        params,
      });
    },
  );
  client.setNotificationHandler(
    REALTIME_MEDIA_SESSION_ENDED_METHOD,
    { params: RealtimeMediaSessionEndedNotificationParamsSchema },
    async (params) => {
      markServerSupport();
      await options.onNotification?.({
        jsonrpc: '2.0',
        method: REALTIME_MEDIA_SESSION_ENDED_METHOD,
        params,
      });
    },
  );
  registerSubscriptionAcknowledgementHandler(
    client,
    'io.stagewise/realtime-media',
    (params) => {
      const subscription =
        SubscriptionsAcknowledgedNotificationSchema.shape.params.parse(params)
          .notifications['io.stagewise/realtime-media'];
      if (!subscription) return;
      markServerSupport();
      resolveAcknowledgement?.();
      resolveAcknowledgement = undefined;
    },
  );

  return {
    discover,
    async listen(subscription = {}, requestOptions) {
      await requireServerSupport(requestOptions);
      const acknowledgement = new Promise<void>((resolve) => {
        resolveAcknowledgement = resolve;
      });
      const request = client.request(
        {
          method: SUBSCRIPTIONS_LISTEN_METHOD,
          params: paramsWithCapability(
            {
              notifications: {
                'io.stagewise/realtime-media': subscription,
              },
            },
            capability,
            requestOptions?.metadata,
          ),
        },
        SubscriptionsListenResultSchema,
        {
          ...requestOptions?.request,
          onprogress: requestOptions?.request?.onprogress ?? (() => undefined),
          resetTimeoutOnProgress: true,
        },
      );
      const closed = request.then(() => undefined);
      void closed.catch(() => undefined);
      await Promise.race([acknowledgement, closed]).catch((error) => {
        resolveAcknowledgement = undefined;
        throw error;
      });
      return { closed };
    },
    async accept(sessionId, requestOptions) {
      await requireServerSupport(requestOptions);
      const result = await client.request(
        {
          method: REALTIME_MEDIA_ACCEPT_METHOD,
          params: paramsWithCapability(
            { sessionId },
            capability,
            requestOptions?.metadata,
          ),
        },
        AcceptRealtimeMediaSessionResultSchema,
        requestOptions?.request,
      );
      return decodeRealtimeMediaAcceptResult(result);
    },
    async reject(sessionId, requestOptions) {
      await requireServerSupport(requestOptions);
      await client.request(
        {
          method: REALTIME_MEDIA_REJECT_METHOD,
          params: paramsWithCapability(
            { sessionId },
            capability,
            requestOptions?.metadata,
          ),
        },
        EndRealtimeMediaSessionResultSchema,
        requestOptions?.request,
      );
    },
    async end(sessionId, requestOptions) {
      await requireServerSupport(requestOptions);
      await client.request(
        {
          method: REALTIME_MEDIA_END_METHOD,
          params: paramsWithCapability(
            { sessionId },
            capability,
            requestOptions?.metadata,
          ),
        },
        EndRealtimeMediaSessionResultSchema,
        requestOptions?.request,
      );
    },
    serverSupportsRealtimeMedia,
  };
}

import type { Client, RequestOptions } from '@modelcontextprotocol/client';

import {
  resolveServerPushNotificationsSupport,
  withPushNotificationsCapability,
  withPushNotificationsClientCapability,
} from '../capabilities.js';
import {
  PUSH_NOTIFICATIONS_ACK_METHOD,
  PUSH_NOTIFICATIONS_GET_METHOD,
  PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
  SERVER_DISCOVER_METHOD,
  SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  SUBSCRIPTIONS_LISTEN_METHOD,
} from '../constants.js';
import {
  AcknowledgeEventsResultSchema,
  GetEventsResultSchema,
  PushNotificationNotificationParamsSchema,
  ServerDiscoverResultSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenResultSchema,
} from '../generated/schema.js';
import type {
  AcknowledgeEventsParams,
  GetEventsParams,
  GetEventsResult,
  PushNotificationNotification,
  PushNotificationsCapabilities,
  PushNotificationsSubscription,
  ServerDiscoverResult,
} from '../spec.types.js';

export type PushNotificationsClientProtocol = Pick<
  Client,
  | 'getProtocolEra'
  | 'getServerCapabilities'
  | 'registerCapabilities'
  | 'request'
  | 'setNotificationHandler'
> & {
  assertCanSetRequestHandler?(method: string): void;
};

export interface RegisterPushNotificationsClientOptions {
  onEvent?(notification: PushNotificationNotification): void | Promise<void>;
}

export interface PushNotificationsRequestOptions {
  metadata?: Record<string, unknown>;
  request?: RequestOptions;
}

export interface PushNotificationsSubscriptionHandle {
  readonly closed: Promise<void>;
}

export interface RegisteredPushNotificationsClient {
  discover(
    options?: PushNotificationsRequestOptions,
  ): Promise<ServerDiscoverResult>;
  getEvents(
    params?: GetEventsParams,
    options?: PushNotificationsRequestOptions,
  ): Promise<GetEventsResult>;
  acknowledgeEvents(
    params: AcknowledgeEventsParams,
    options?: PushNotificationsRequestOptions,
  ): Promise<void>;
  listen(
    subscription: PushNotificationsSubscription,
    options?: PushNotificationsRequestOptions,
  ): Promise<PushNotificationsSubscriptionHandle>;
  serverSupportsPushNotifications(
    options?: PushNotificationsRequestOptions,
  ): Promise<boolean>;
  acknowledgedSubscription(): PushNotificationsSubscription | undefined;
}

function paramsWithCapability<T extends Record<string, unknown>>(
  params: T,
  metadata?: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  return {
    ...params,
    _meta: withPushNotificationsClientCapability(metadata ?? {}),
  };
}

export function registerPushNotificationsClient(
  client: PushNotificationsClientProtocol,
  options: RegisterPushNotificationsClientOptions = {},
): RegisteredPushNotificationsClient {
  client.registerCapabilities(withPushNotificationsCapability({}));
  let discoveryCapabilities: PushNotificationsCapabilities | undefined;
  let discoveryRequest: Promise<ServerDiscoverResult> | undefined;
  let acknowledged: PushNotificationsSubscription | undefined;
  let resolveAcknowledgement: (() => void) | undefined;

  const markServerSupport = (): void => {
    discoveryCapabilities = withPushNotificationsCapability({});
  };

  const discover = (
    requestOptions?: PushNotificationsRequestOptions,
  ): Promise<ServerDiscoverResult> => {
    if (discoveryRequest) return discoveryRequest;

    discoveryRequest = client
      .request(
        {
          method: SERVER_DISCOVER_METHOD,
          params: paramsWithCapability({}, requestOptions?.metadata),
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

  const serverSupportsPushNotifications = async (
    requestOptions?: PushNotificationsRequestOptions,
  ): Promise<boolean> => {
    const initialization = client.getServerCapabilities();
    if (
      discoveryCapabilities !== undefined ||
      client.getProtocolEra() !== undefined ||
      initialization !== undefined
    ) {
      return resolveServerPushNotificationsSupport({
        discovery: discoveryCapabilities,
        initialization,
      });
    }
    await discover(requestOptions);
    return resolveServerPushNotificationsSupport({
      discovery: discoveryCapabilities,
      initialization: client.getServerCapabilities(),
    });
  };

  const requireServerSupport = async (
    requestOptions?: PushNotificationsRequestOptions,
  ): Promise<void> => {
    if (!(await serverSupportsPushNotifications(requestOptions))) {
      throw new Error(
        'Server does not support the Push Notifications extension',
      );
    }
  };

  client.setNotificationHandler(
    PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
    { params: PushNotificationNotificationParamsSchema },
    async (params) => {
      markServerSupport();
      await options.onEvent?.({
        jsonrpc: '2.0',
        method: PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
        params,
      });
    },
  );
  client.setNotificationHandler(
    SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
    { params: SubscriptionsAcknowledgedNotificationSchema.shape.params },
    (params) => {
      markServerSupport();
      acknowledged = params.notifications['io.stagewise/push-notifications'];
      resolveAcknowledgement?.();
      resolveAcknowledgement = undefined;
    },
  );

  return {
    discover,
    async getEvents(params = {}, requestOptions) {
      await requireServerSupport(requestOptions);
      return client.request(
        {
          method: PUSH_NOTIFICATIONS_GET_METHOD,
          params: paramsWithCapability(params, requestOptions?.metadata),
        },
        GetEventsResultSchema,
        requestOptions?.request,
      );
    },
    async acknowledgeEvents(params, requestOptions) {
      await requireServerSupport(requestOptions);
      await client.request(
        {
          method: PUSH_NOTIFICATIONS_ACK_METHOD,
          params: paramsWithCapability(params, requestOptions?.metadata),
        },
        AcknowledgeEventsResultSchema,
        requestOptions?.request,
      );
    },
    async listen(subscription, requestOptions) {
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
                'io.stagewise/push-notifications': subscription,
              },
            },
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
    serverSupportsPushNotifications,
    acknowledgedSubscription: () => acknowledged,
  };
}

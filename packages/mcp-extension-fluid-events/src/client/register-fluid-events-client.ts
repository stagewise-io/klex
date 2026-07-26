import type { Client, RequestOptions } from '@modelcontextprotocol/client';

import {
  resolveServerFluidEventsSupport,
  withFluidEventsCapability,
  withFluidEventsClientCapability,
} from '../capabilities.js';
import {
  FLUID_EVENTS_ACK_METHOD,
  FLUID_EVENTS_GET_METHOD,
  FLUID_EVENTS_NOTIFICATION_METHOD,
  SERVER_DISCOVER_METHOD,
  SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  SUBSCRIPTIONS_LISTEN_METHOD,
} from '../constants.js';
import {
  AcknowledgeEventsResultSchema,
  FluidEventNotificationParamsSchema,
  GetEventsResultSchema,
  ServerDiscoverResultSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenResultSchema,
} from '../generated/schema.js';
import type {
  AcknowledgeEventsParams,
  FluidEventNotification,
  FluidEventsCapabilities,
  FluidEventsSubscription,
  GetEventsParams,
  GetEventsResult,
  ServerDiscoverResult,
} from '../spec.types.js';

export type FluidEventsClientProtocol = Pick<
  Client,
  | 'getServerCapabilities'
  | 'registerCapabilities'
  | 'request'
  | 'setNotificationHandler'
> & {
  assertCanSetRequestHandler?(method: string): void;
};

export interface RegisterFluidEventsClientOptions {
  onEvent?(notification: FluidEventNotification): void | Promise<void>;
}

export interface FluidEventsRequestOptions {
  metadata?: Record<string, unknown>;
  request?: RequestOptions;
}

export interface FluidEventsSubscriptionHandle {
  readonly closed: Promise<void>;
}

export interface RegisteredFluidEventsClient {
  discover(options?: FluidEventsRequestOptions): Promise<ServerDiscoverResult>;
  getEvents(
    params?: GetEventsParams,
    options?: FluidEventsRequestOptions,
  ): Promise<GetEventsResult>;
  acknowledgeEvents(
    params: AcknowledgeEventsParams,
    options?: FluidEventsRequestOptions,
  ): Promise<void>;
  listen(
    subscription: FluidEventsSubscription,
    options?: FluidEventsRequestOptions,
  ): Promise<FluidEventsSubscriptionHandle>;
  serverSupportsFluidEvents(
    options?: FluidEventsRequestOptions,
  ): Promise<boolean>;
  acknowledgedSubscription(): FluidEventsSubscription | undefined;
}

function paramsWithCapability<T extends Record<string, unknown>>(
  params: T,
  metadata?: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  return {
    ...params,
    _meta: withFluidEventsClientCapability(metadata ?? {}),
  };
}

export function registerFluidEventsClient(
  client: FluidEventsClientProtocol,
  options: RegisterFluidEventsClientOptions = {},
): RegisteredFluidEventsClient {
  client.registerCapabilities(withFluidEventsCapability({}));
  let discoveryCapabilities: FluidEventsCapabilities | undefined;
  let discoveryRequest: Promise<ServerDiscoverResult> | undefined;
  let acknowledged: FluidEventsSubscription | undefined;
  let resolveAcknowledgement: (() => void) | undefined;

  const markServerSupport = (): void => {
    discoveryCapabilities = withFluidEventsCapability({});
  };

  const discover = (
    requestOptions?: FluidEventsRequestOptions,
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

  const serverSupportsFluidEvents = async (
    requestOptions?: FluidEventsRequestOptions,
  ): Promise<boolean> => {
    if (discoveryCapabilities === undefined) {
      try {
        await discover(requestOptions);
      } catch (error) {
        const initialization = client.getServerCapabilities();
        if (initialization === undefined) throw error;
      }
    }
    return resolveServerFluidEventsSupport({
      discovery: discoveryCapabilities,
      initialization: client.getServerCapabilities(),
    });
  };

  const requireServerSupport = async (
    requestOptions?: FluidEventsRequestOptions,
  ): Promise<void> => {
    if (!(await serverSupportsFluidEvents(requestOptions))) {
      throw new Error('Server does not support the Fluid Events extension');
    }
  };

  client.setNotificationHandler(
    FLUID_EVENTS_NOTIFICATION_METHOD,
    { params: FluidEventNotificationParamsSchema },
    async (params) => {
      markServerSupport();
      await options.onEvent?.({
        jsonrpc: '2.0',
        method: FLUID_EVENTS_NOTIFICATION_METHOD,
        params,
      });
    },
  );
  client.setNotificationHandler(
    SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
    { params: SubscriptionsAcknowledgedNotificationSchema.shape.params },
    (params) => {
      markServerSupport();
      acknowledged = params.notifications['io.stagewise.fluid/events'];
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
          method: FLUID_EVENTS_GET_METHOD,
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
          method: FLUID_EVENTS_ACK_METHOD,
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
                'io.stagewise.fluid/events': subscription,
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
    serverSupportsFluidEvents,
    acknowledgedSubscription: () => acknowledged,
  };
}

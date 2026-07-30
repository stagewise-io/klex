import type { BaseContext, Server } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  hasPerRequestPushNotificationsCapability,
  hasPushNotificationsCapability,
  missingPushNotificationsCapabilityError,
  pushNotificationsCapabilities,
  withPushNotificationsCapability,
} from '../capabilities.js';
import {
  PUSH_NOTIFICATIONS_ACK_METHOD,
  PUSH_NOTIFICATIONS_GET_METHOD,
  PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
  SERVER_DISCOVER_METHOD,
} from '../constants.js';
import {
  AcknowledgeEventsParamsSchema,
  AcknowledgeEventsResultSchema,
  GetEventsParamsSchema,
  GetEventsResultSchema,
  PushNotificationNotificationParamsSchema,
  ServerDiscoverResultSchema,
} from '../generated/schema.js';
import type {
  AcknowledgeEventsParams,
  GetEventsParams,
  GetEventsResult,
  PushNotificationNotificationParams,
} from '../spec.types.js';

export type PushNotificationsServerProtocol = Pick<
  Server,
  | 'getClientCapabilities'
  | 'notification'
  | 'registerCapabilities'
  | 'setRequestHandler'
> & {
  assertCanSetRequestHandler?(method: string): void;
};
export type PushNotificationsRequestContext = BaseContext;

export interface PushNotificationsServerHandlers {
  getEvents(
    params: GetEventsParams,
    context: PushNotificationsRequestContext,
  ): Promise<GetEventsResult> | GetEventsResult;
  acknowledgeEvents(
    params: AcknowledgeEventsParams,
    context: PushNotificationsRequestContext,
  ): Promise<void> | void;
}

export interface RegisterPushNotificationsServerOptions {
  acceptInitializationCapabilities?: boolean;
}

export class PushNotificationsProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'PushNotificationsProtocolError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface RegisteredPushNotificationsServer {
  clientSupportsPushNotifications(metadata?: Record<string, unknown>): boolean;
  /** Sends an event that the application has already made durably retrievable. */
  sendEvent(
    params: PushNotificationNotificationParams,
    options?: {
      metadata?: Record<string, unknown>;
      relatedRequestId?: string | number;
    },
  ): Promise<void>;
}

export function registerPushNotificationsServer(
  server: PushNotificationsServerProtocol,
  handlers: PushNotificationsServerHandlers,
  options: RegisterPushNotificationsServerOptions = {},
): RegisteredPushNotificationsServer {
  server.registerCapabilities(withPushNotificationsCapability({}));

  const supports = (metadata?: Record<string, unknown>): boolean =>
    hasPerRequestPushNotificationsCapability(metadata) ||
    (options.acceptInitializationCapabilities === true &&
      hasPushNotificationsCapability(server.getClientCapabilities()));

  const requireSupport = (context: BaseContext): void => {
    const metadata = context.mcpReq?.envelope as
      | Record<string, unknown>
      | undefined;
    if (!supports(metadata)) {
      throw new PushNotificationsProtocolError(
        missingPushNotificationsCapabilityError(),
      );
    }
  };

  server.setRequestHandler(
    SERVER_DISCOVER_METHOD,
    {
      params: z.record(z.string(), z.unknown()),
      result: ServerDiscoverResultSchema,
    },
    () => ({ capabilities: pushNotificationsCapabilities() }),
  );
  server.setRequestHandler(
    PUSH_NOTIFICATIONS_GET_METHOD,
    { params: GetEventsParamsSchema, result: GetEventsResultSchema },
    async (params, context) => {
      requireSupport(context);
      return GetEventsResultSchema.parse(
        await handlers.getEvents(params, context),
      );
    },
  );
  server.setRequestHandler(
    PUSH_NOTIFICATIONS_ACK_METHOD,
    {
      params: AcknowledgeEventsParamsSchema,
      result: AcknowledgeEventsResultSchema,
    },
    async (params, context) => {
      requireSupport(context);
      await handlers.acknowledgeEvents(params, context);
      return {};
    },
  );

  return {
    clientSupportsPushNotifications: supports,
    async sendEvent(params, notificationOptions) {
      if (!supports(notificationOptions?.metadata)) {
        throw new PushNotificationsProtocolError(
          missingPushNotificationsCapabilityError(),
        );
      }
      await server.notification(
        {
          method: PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
          params: PushNotificationNotificationParamsSchema.parse(params),
        },
        { relatedRequestId: notificationOptions?.relatedRequestId },
      );
    },
  };
}

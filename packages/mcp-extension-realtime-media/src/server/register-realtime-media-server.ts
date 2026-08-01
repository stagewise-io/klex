import type { BaseContext, Server } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  hasPerRequestRealtimeMediaCapability,
  hasRealtimeMediaCapability,
  missingRealtimeMediaCapabilityError,
  realtimeMediaCapabilities,
  withRealtimeMediaCapability,
} from '../capabilities.js';
import {
  REALTIME_MEDIA_ACCEPT_METHOD,
  REALTIME_MEDIA_END_METHOD,
  REALTIME_MEDIA_EXPIRED_OFFER_CODE,
  REALTIME_MEDIA_INVALID_STATE_CODE,
  REALTIME_MEDIA_REJECT_METHOD,
  REALTIME_MEDIA_SESSION_ENDED_METHOD,
  REALTIME_MEDIA_SESSION_OFFERED_METHOD,
  REALTIME_MEDIA_UNKNOWN_SESSION_CODE,
  SERVER_DISCOVER_METHOD,
} from '../constants.js';
import {
  AcceptRealtimeMediaSessionResultSchema,
  EndRealtimeMediaSessionResultSchema,
  RealtimeMediaSessionEndedNotificationParamsSchema,
  RealtimeMediaSessionOfferedNotificationParamsSchema,
  RealtimeMediaSessionParamsSchema,
  RejectRealtimeMediaSessionResultSchema,
  ServerDiscoverResultSchema,
} from '../generated/schema.js';
import type {
  AcceptRealtimeMediaSessionResult,
  RealtimeMediaProtocolErrorData,
  RealtimeMediaProtocolErrorKind,
  RealtimeMediaSessionEndedNotificationParams,
  RealtimeMediaSessionOfferedNotificationParams,
  RealtimeMediaSessionParams,
} from '../spec.types.js';

export type RealtimeMediaServerProtocol = Pick<
  Server,
  | 'getClientCapabilities'
  | 'notification'
  | 'registerCapabilities'
  | 'setRequestHandler'
> & {
  assertCanSetRequestHandler?(method: string): void;
};
export type RealtimeMediaRequestContext = BaseContext;

export interface RealtimeMediaServerHandlers {
  accept(
    params: RealtimeMediaSessionParams,
    context: RealtimeMediaRequestContext,
  ):
    | Promise<AcceptRealtimeMediaSessionResult>
    | AcceptRealtimeMediaSessionResult;
  reject(
    params: RealtimeMediaSessionParams,
    context: RealtimeMediaRequestContext,
  ): Promise<void> | void;
  end(
    params: RealtimeMediaSessionParams,
    context: RealtimeMediaRequestContext,
  ): Promise<void> | void;
}

export interface RegisterRealtimeMediaServerOptions {
  acceptInitializationCapabilities?: boolean;
  /** Disable when an application composes discovery through another handler. */
  registerDiscoveryHandler?: boolean;
}

export class RealtimeMediaProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'RealtimeMediaProtocolError';
    this.code = error.code;
    this.data = error.data;
  }
}

export function realtimeMediaSessionError(
  kind: RealtimeMediaProtocolErrorKind,
  sessionId: string,
): RealtimeMediaProtocolError {
  const codes: Record<RealtimeMediaProtocolErrorKind, number> = {
    'unknown-session': REALTIME_MEDIA_UNKNOWN_SESSION_CODE,
    'expired-offer': REALTIME_MEDIA_EXPIRED_OFFER_CODE,
    'invalid-state': REALTIME_MEDIA_INVALID_STATE_CODE,
  };
  const messages: Record<RealtimeMediaProtocolErrorKind, string> = {
    'unknown-session': 'Unknown realtime media session',
    'expired-offer': 'Realtime media offer expired',
    'invalid-state': 'Invalid realtime media session state',
  };
  const data: RealtimeMediaProtocolErrorData = { kind, sessionId };
  return new RealtimeMediaProtocolError({
    code: codes[kind],
    message: messages[kind],
    data,
  });
}

export interface RealtimeMediaNotificationOptions {
  metadata?: Record<string, unknown>;
  relatedRequestId?: string | number;
}

export interface RegisteredRealtimeMediaServer {
  clientSupportsRealtimeMedia(metadata?: Record<string, unknown>): boolean;
  sendSessionOffered(
    params: RealtimeMediaSessionOfferedNotificationParams,
    options?: RealtimeMediaNotificationOptions,
  ): Promise<void>;
  sendSessionEnded(
    params: RealtimeMediaSessionEndedNotificationParams,
    options?: RealtimeMediaNotificationOptions,
  ): Promise<void>;
}

export function registerRealtimeMediaServer(
  server: RealtimeMediaServerProtocol,
  handlers: RealtimeMediaServerHandlers,
  options: RegisterRealtimeMediaServerOptions = {},
): RegisteredRealtimeMediaServer {
  server.registerCapabilities(withRealtimeMediaCapability({}));

  const supports = (metadata?: Record<string, unknown>): boolean =>
    hasPerRequestRealtimeMediaCapability(metadata) ||
    (options.acceptInitializationCapabilities === true &&
      hasRealtimeMediaCapability(server.getClientCapabilities()));

  const requireSupport = (context: BaseContext): void => {
    const metadata = context.mcpReq?.envelope as
      | Record<string, unknown>
      | undefined;
    if (!supports(metadata)) {
      throw new RealtimeMediaProtocolError(
        missingRealtimeMediaCapabilityError(),
      );
    }
  };

  if (options.registerDiscoveryHandler !== false) {
    server.setRequestHandler(
      SERVER_DISCOVER_METHOD,
      {
        params: z.record(z.string(), z.unknown()),
        result: ServerDiscoverResultSchema,
      },
      () => ({ capabilities: realtimeMediaCapabilities() }),
    );
  }
  server.setRequestHandler(
    REALTIME_MEDIA_ACCEPT_METHOD,
    {
      params: RealtimeMediaSessionParamsSchema,
      result: AcceptRealtimeMediaSessionResultSchema,
    },
    async (params, context) => {
      requireSupport(context);
      return AcceptRealtimeMediaSessionResultSchema.parse(
        await handlers.accept(params, context),
      );
    },
  );
  server.setRequestHandler(
    REALTIME_MEDIA_REJECT_METHOD,
    {
      params: RealtimeMediaSessionParamsSchema,
      result: RejectRealtimeMediaSessionResultSchema,
    },
    async (params, context) => {
      requireSupport(context);
      await handlers.reject(params, context);
      return {};
    },
  );
  server.setRequestHandler(
    REALTIME_MEDIA_END_METHOD,
    {
      params: RealtimeMediaSessionParamsSchema,
      result: EndRealtimeMediaSessionResultSchema,
    },
    async (params, context) => {
      requireSupport(context);
      await handlers.end(params, context);
      return {};
    },
  );

  const requireNotificationSupport = (
    metadata?: Record<string, unknown>,
  ): void => {
    if (!supports(metadata)) {
      throw new RealtimeMediaProtocolError(
        missingRealtimeMediaCapabilityError(),
      );
    }
  };

  return {
    clientSupportsRealtimeMedia: supports,
    async sendSessionOffered(params, notificationOptions) {
      requireNotificationSupport(notificationOptions?.metadata);
      await server.notification(
        {
          method: REALTIME_MEDIA_SESSION_OFFERED_METHOD,
          params:
            RealtimeMediaSessionOfferedNotificationParamsSchema.parse(params),
        },
        { relatedRequestId: notificationOptions?.relatedRequestId },
      );
    },
    async sendSessionEnded(params, notificationOptions) {
      requireNotificationSupport(notificationOptions?.metadata);
      await server.notification(
        {
          method: REALTIME_MEDIA_SESSION_ENDED_METHOD,
          params:
            RealtimeMediaSessionEndedNotificationParamsSchema.parse(params),
        },
        { relatedRequestId: notificationOptions?.relatedRequestId },
      );
    },
  };
}

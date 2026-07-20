import type { BaseContext, Server } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import {
  fluidEventsCapabilities,
  hasFluidEventsCapability,
  hasPerRequestFluidEventsCapability,
  missingFluidEventsCapabilityError,
  withFluidEventsCapability,
} from '../capabilities.js';
import {
  FLUID_EVENTS_ACK_METHOD,
  FLUID_EVENTS_GET_METHOD,
  FLUID_EVENTS_NOTIFICATION_METHOD,
  SERVER_DISCOVER_METHOD,
} from '../constants.js';
import {
  AcknowledgeEventsParamsSchema,
  AcknowledgeEventsResultSchema,
  FluidEventNotificationParamsSchema,
  GetEventsParamsSchema,
  GetEventsResultSchema,
  ServerDiscoverResultSchema,
} from '../generated/schema.js';
import type {
  AcknowledgeEventsParams,
  FluidEventNotificationParams,
  GetEventsParams,
  GetEventsResult,
} from '../spec.types.js';

export type FluidEventsServerProtocol = Pick<
  Server,
  | 'getClientCapabilities'
  | 'notification'
  | 'registerCapabilities'
  | 'setRequestHandler'
> & {
  assertCanSetRequestHandler?(method: string): void;
};
export type FluidEventsRequestContext = BaseContext;

export interface FluidEventsServerHandlers {
  getEvents(
    params: GetEventsParams,
    context: FluidEventsRequestContext,
  ): Promise<GetEventsResult> | GetEventsResult;
  acknowledgeEvents(
    params: AcknowledgeEventsParams,
    context: FluidEventsRequestContext,
  ): Promise<void> | void;
}

export interface RegisterFluidEventsServerOptions {
  acceptInitializationCapabilities?: boolean;
}

export class FluidEventsProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'FluidEventsProtocolError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface RegisteredFluidEventsServer {
  clientSupportsFluidEvents(metadata?: Record<string, unknown>): boolean;
  /** Sends an event that the application has already made durably retrievable. */
  sendEvent(
    params: FluidEventNotificationParams,
    options?: {
      metadata?: Record<string, unknown>;
      relatedRequestId?: string | number;
    },
  ): Promise<void>;
}

export function registerFluidEventsServer(
  server: FluidEventsServerProtocol,
  handlers: FluidEventsServerHandlers,
  options: RegisterFluidEventsServerOptions = {},
): RegisteredFluidEventsServer {
  server.registerCapabilities(withFluidEventsCapability({}));

  const supports = (metadata?: Record<string, unknown>): boolean =>
    hasPerRequestFluidEventsCapability(metadata) ||
    (options.acceptInitializationCapabilities === true &&
      hasFluidEventsCapability(server.getClientCapabilities()));

  const requireSupport = (context: BaseContext): void => {
    const metadata = context.mcpReq?.envelope as
      | Record<string, unknown>
      | undefined;
    if (!supports(metadata)) {
      throw new FluidEventsProtocolError(missingFluidEventsCapabilityError());
    }
  };

  server.setRequestHandler(
    SERVER_DISCOVER_METHOD,
    {
      params: z.record(z.string(), z.unknown()),
      result: ServerDiscoverResultSchema,
    },
    () => ({ capabilities: fluidEventsCapabilities() }),
  );
  server.setRequestHandler(
    FLUID_EVENTS_GET_METHOD,
    { params: GetEventsParamsSchema, result: GetEventsResultSchema },
    async (params, context) => {
      requireSupport(context);
      return GetEventsResultSchema.parse(
        await handlers.getEvents(params, context),
      );
    },
  );
  server.setRequestHandler(
    FLUID_EVENTS_ACK_METHOD,
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
    clientSupportsFluidEvents: supports,
    async sendEvent(params, notificationOptions) {
      if (!supports(notificationOptions?.metadata)) {
        throw new FluidEventsProtocolError(missingFluidEventsCapabilityError());
      }
      await server.notification(
        {
          method: FLUID_EVENTS_NOTIFICATION_METHOD,
          params: FluidEventNotificationParamsSchema.parse(params),
        },
        { relatedRequestId: notificationOptions?.relatedRequestId },
      );
    },
  };
}

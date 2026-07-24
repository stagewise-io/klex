import {
  JSONRPCMessageSchema,
  RequestIdSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod';

declare const gatewaySessionIdBrand: unique symbol;

export type GatewaySessionId = string & {
  readonly [gatewaySessionIdBrand]: true;
};

export const GATEWAY_PROTOCOL_VERSION = 1 as const;

export interface SessionOpenFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'session.open';
  readonly sessionId: GatewaySessionId;
}

export interface SessionOpenedFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'session.opened';
  readonly sessionId: GatewaySessionId;
}

export interface GatewayMessageOptions {
  readonly relatedRequestId?: z.infer<typeof RequestIdSchema>;
}

export interface SessionMessageFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'session.message';
  readonly sessionId: GatewaySessionId;
  readonly message: z.infer<typeof JSONRPCMessageSchema>;
  readonly options?: GatewayMessageOptions;
}

export interface SessionCloseFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'session.close';
  readonly sessionId: GatewaySessionId;
  readonly reason?: string;
}

export type GatewayToEnvironmentFrame =
  | SessionOpenFrame
  | SessionMessageFrame
  | SessionCloseFrame;

export type EnvironmentToGatewayFrame =
  | SessionOpenedFrame
  | SessionMessageFrame
  | SessionCloseFrame;

export type GatewayFrame =
  | GatewayToEnvironmentFrame
  | EnvironmentToGatewayFrame;

const GatewaySessionIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    'Session ID must not have whitespace',
  )
  .transform((value) => value as GatewaySessionId);

const FrameBaseSchema = z.object({
  version: z.literal(GATEWAY_PROTOCOL_VERSION),
  sessionId: GatewaySessionIdSchema,
});

const SessionOpenFrameSchema = FrameBaseSchema.extend({
  type: z.literal('session.open'),
}).strict();

const SessionOpenedFrameSchema = FrameBaseSchema.extend({
  type: z.literal('session.opened'),
}).strict();

const GatewayMessageOptionsSchema = z
  .object({
    relatedRequestId: RequestIdSchema.optional(),
  })
  .strict();

const SessionMessageFrameSchema = FrameBaseSchema.extend({
  type: z.literal('session.message'),
  message: JSONRPCMessageSchema,
  options: GatewayMessageOptionsSchema.optional(),
}).strict();

const SessionCloseFrameSchema = FrameBaseSchema.extend({
  type: z.literal('session.close'),
  reason: z.string().optional(),
}).strict();

const GatewayToEnvironmentFrameSchema = z.discriminatedUnion('type', [
  SessionOpenFrameSchema,
  SessionMessageFrameSchema,
  SessionCloseFrameSchema,
]);

const EnvironmentToGatewayFrameSchema = z.discriminatedUnion('type', [
  SessionOpenedFrameSchema,
  SessionMessageFrameSchema,
  SessionCloseFrameSchema,
]);

export function createGatewaySessionId(value: string): GatewaySessionId {
  return GatewaySessionIdSchema.parse(value);
}

export function encodeGatewayFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame);
}

export function decodeGatewayToEnvironmentFrame(
  input: string,
): GatewayToEnvironmentFrame {
  return GatewayToEnvironmentFrameSchema.parse(JSON.parse(input));
}

export function decodeEnvironmentToGatewayFrame(
  input: string,
): EnvironmentToGatewayFrame {
  return EnvironmentToGatewayFrameSchema.parse(JSON.parse(input));
}

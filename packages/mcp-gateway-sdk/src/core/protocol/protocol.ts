import { z } from 'zod';

declare const gatewayExchangeIdBrand: unique symbol;

export type GatewayExchangeId = string & {
  readonly [gatewayExchangeIdBrand]: true;
};

export const GATEWAY_PROTOCOL_VERSION = 2 as const;
export const MAX_GATEWAY_CHUNK_BYTES = 64 * 1024;

export type GatewayHeaders = Record<string, string>;

export interface ExchangeOpenFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'exchange.open';
  readonly exchangeId: GatewayExchangeId;
  readonly method: string;
  readonly url: string;
  readonly headers: GatewayHeaders;
  readonly body?: string;
}

export interface ExchangeOpenedFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'exchange.opened';
  readonly exchangeId: GatewayExchangeId;
  readonly status: number;
  readonly statusText: string;
  readonly headers: GatewayHeaders;
}

export interface ExchangeChunkFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'exchange.chunk';
  readonly exchangeId: GatewayExchangeId;
  readonly data: string;
}

export interface ExchangeCloseFrame {
  readonly version: typeof GATEWAY_PROTOCOL_VERSION;
  readonly type: 'exchange.close';
  readonly exchangeId: GatewayExchangeId;
  readonly reason?: string;
}

export type GatewayToEnvironmentFrame = ExchangeOpenFrame | ExchangeCloseFrame;
export type EnvironmentToGatewayFrame =
  | ExchangeOpenedFrame
  | ExchangeChunkFrame
  | ExchangeCloseFrame;
export type GatewayFrame =
  | GatewayToEnvironmentFrame
  | EnvironmentToGatewayFrame;

const GatewayExchangeIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    'Exchange ID must not have whitespace',
  )
  .transform((value) => value as GatewayExchangeId);

const HeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .refine((value) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value)),
    z.string().refine((value) => !/[\r\n]/.test(value)),
  )
  .transform((headers) => headers as GatewayHeaders);

const Base64Schema = z
  .string()
  .refine(isCanonicalBase64, 'Invalid base64 data');
const FrameBaseSchema = z.object({
  version: z.literal(GATEWAY_PROTOCOL_VERSION),
  exchangeId: GatewayExchangeIdSchema,
});
const ExchangeOpenFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.open'),
  method: z.string().regex(/^[A-Z]+$/),
  url: z.string().url(),
  headers: HeadersSchema,
  body: Base64Schema.optional(),
}).strict();
const ExchangeOpenedFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.opened'),
  status: z.number().int().min(100).max(599),
  statusText: z.string().refine((value) => !/[\r\n]/.test(value)),
  headers: HeadersSchema,
}).strict();
const ExchangeChunkFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.chunk'),
  data: Base64Schema.refine(
    (value) => decodedBase64Length(value) <= MAX_GATEWAY_CHUNK_BYTES,
    'Gateway chunk exceeds size limit',
  ),
}).strict();
const ExchangeCloseFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.close'),
  reason: z.string().min(1).optional(),
}).strict();
const GatewayToEnvironmentFrameSchema = z.discriminatedUnion('type', [
  ExchangeOpenFrameSchema,
  ExchangeCloseFrameSchema,
]);
const EnvironmentToGatewayFrameSchema = z.discriminatedUnion('type', [
  ExchangeOpenedFrameSchema,
  ExchangeChunkFrameSchema,
  ExchangeCloseFrameSchema,
]);

export function createGatewayExchangeId(value: string): GatewayExchangeId {
  return GatewayExchangeIdSchema.parse(value);
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

function isCanonicalBase64(value: string): boolean {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  return (
    (value.length * 3) / 4 -
    (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  );
}
